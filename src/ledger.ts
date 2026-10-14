import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { refuser, systemErrorCode } from "./coded-error";
import { directoryEntries } from "./directory";
import { dataDir } from "./paths";
import { type Block, blocks, isBound, parseBlock, RANGE } from "./ports";
import { type Project, storedName, type WorktreeName } from "./project";

export type Entry = { readonly name: WorktreeName; readonly ready: boolean; readonly block: Block | null };

const LEDGER_DIR_OF_EARLIER_RELEASES = "agent-worktrees";

const CLAIMS_DIR = "ports";

const ALREADY_EXISTS = "EEXIST";

const GONE = "ENOENT";

const refuse = refuser<{
  readonly no_free_ports: { readonly name: string };
}>({
  no_free_ports: {
    message: ({ name }) =>
      `no port block from ${RANGE} is free for ${name}: worktrees hold some and other programs bind the rest; setup is pending`,
    resolve: () =>
      "remove a worktree you are done with, or run agent-worktree prune to free the blocks of worktrees that are gone, then run the command again",
  },
});

function ledgerDir(project: Project): string {
  return join(project.commonDir, LEDGER_DIR_OF_EARLIER_RELEASES);
}

function entryDir(project: Project, name: WorktreeName): string {
  return join(ledgerDir(project), name);
}

function readyFile(project: Project, name: WorktreeName): string {
  return join(entryDir(project, name), "ready");
}

function claimsDir(): string {
  return join(dataDir(), CLAIMS_DIR);
}

function claimFile(block: Block): string {
  return join(claimsDir(), String(block));
}

function holderAt(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if (systemErrorCode(error) === GONE) return null;
    throw error;
  }
}

type Claim = { readonly block: Block; readonly holder: string };

function claims(): readonly Claim[] {
  return directoryEntries(claimsDir()).flatMap((dirent) => {
    const block = parseBlock(dirent.name);
    if (block === null || !dirent.isFile()) return [];
    const holder = holderAt(claimFile(block));
    return holder === null ? [] : [{ block, holder }];
  });
}

function heldBy(all: readonly Claim[], holder: string): Block | null {
  const held = all.filter((claim) => claim.holder === holder).map((claim) => claim.block);
  return held.sort((a, b) => a - b)[0] ?? null;
}

function entryNames(project: Project): readonly string[] {
  return directoryEntries(ledgerDir(project))
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => dirent.name);
}

function entryOf(project: Project, name: WorktreeName, all: readonly Claim[]): Entry {
  return {
    name,
    ready: existsSync(readyFile(project, name)),
    block: heldBy(all, entryDir(project, name)),
  };
}

export function entries(project: Project): readonly Entry[] {
  const all = claims();
  return entryNames(project).map((raw) => entryOf(project, storedName(raw), all));
}

export function blockOf(project: Project, name: WorktreeName): Block | null {
  return heldBy(claims(), entryDir(project, name));
}

export function register(project: Project, name: WorktreeName): void {
  mkdirSync(entryDir(project, name), { recursive: true });
}

export function markReady(project: Project, name: WorktreeName): void {
  writeFileSync(readyFile(project, name), "");
}

function placeClaim(block: Block, holder: string): boolean {
  mkdirSync(claimsDir(), { recursive: true });
  const staging = mkdtempSync(join(claimsDir(), ".claim-"));
  const written = join(staging, "holder");
  writeFileSync(written, holder);
  try {
    linkSync(written, claimFile(block));
    return true;
  } catch (error) {
    if (systemErrorCode(error) === ALREADY_EXISTS) return false;
    throw error;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export function claimBlock(project: Project, name: WorktreeName): Block {
  const held = blockOf(project, name);
  if (held !== null) return held;
  const holder = entryDir(project, name);
  for (const block of blocks()) {
    if (existsSync(claimFile(block)) || isBound(block)) continue;
    if (placeClaim(block, holder)) return block;
  }
  throw refuse("no_free_ports", { name });
}

export function unregister(project: Project, name: WorktreeName): void {
  const holder = entryDir(project, name);
  for (const claim of claims()) if (claim.holder === holder) rmSync(claimFile(claim.block), { force: true });
  rmSync(holder, { recursive: true, force: true });
}

function setAside(block: Block): string | null {
  const moved = join(mkdtempSync(join(claimsDir(), ".stale-")), "claim");
  try {
    renameSync(claimFile(block), moved);
    return moved;
  } catch (error) {
    rmSync(dirname(moved), { recursive: true, force: true });
    if (systemErrorCode(error) === GONE) return null;
    throw error;
  }
}

function putBack(block: Block, moved: string): void {
  try {
    linkSync(moved, claimFile(block));
  } catch (error) {
    if (systemErrorCode(error) !== ALREADY_EXISTS) throw error;
  }
}

function freeStale(block: Block): void {
  const moved = setAside(block);
  if (moved === null) return;
  const holder = holderAt(moved);
  if (holder !== null && existsSync(holder)) putBack(block, moved);
  rmSync(dirname(moved), { recursive: true, force: true });
}

export function freeStaleBlocks(): void {
  for (const claim of claims()) if (!existsSync(claim.holder)) freeStale(claim.block);
}
