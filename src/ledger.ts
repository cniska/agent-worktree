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
import { basename, dirname, join } from "node:path";
import { refuser, systemErrorCode } from "./coded-error";
import { directoryEntries } from "./directory";
import { note } from "./log";
import { dataDir } from "./paths";
import {
  type Block,
  blockOfUnits,
  blockText,
  isInUse,
  isRunOf,
  type PortRequest,
  parseUnit,
  RANGE,
  type Unit,
  units,
} from "./ports";
import { type Project, storedName, type WorktreeName } from "./project";

export type Entry = { readonly name: WorktreeName; readonly ready: boolean; readonly block: Block | null };

const LEDGER_DIR_OF_EARLIER_RELEASES = "agent-worktrees";

const CLAIMS_DIR = "ports";

const ALREADY_EXISTS = "EEXIST";

const GONE = "ENOENT";

const refuse = refuser<{
  readonly no_free_ports: { readonly name: string; readonly ports: number };
}>({
  no_free_ports: {
    message: ({ name, ports }) =>
      `no block of ${ports} ports from ${RANGE} is free for ${name}: worktrees hold some and other programs listen on the rest; setup is pending`,
    resolve: () =>
      "remove a worktree you are done with, fix a teardown that failed for a worktree that is gone, or run agent-worktree prune in another clone whose gone worktrees hold blocks, then run the command again",
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

function claimFile(unit: Unit): string {
  return join(claimsDir(), String(unit));
}

function holderAt(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if (systemErrorCode(error) === GONE) return null;
    throw error;
  }
}

type Claim = { readonly unit: Unit; readonly holder: string };

function claims(): readonly Claim[] {
  return directoryEntries(claimsDir()).flatMap((dirent) => {
    const unit = parseUnit(dirent.name);
    if (unit === null || !dirent.isFile()) return [];
    const holder = holderAt(claimFile(unit));
    return holder === null ? [] : [{ unit, holder }];
  });
}

function unitsHeldBy(all: readonly Claim[], holder: string): readonly Unit[] {
  return all.filter((claim) => claim.holder === holder).map((claim) => claim.unit);
}

function heldBy(all: readonly Claim[], holder: string): Block | null {
  return blockOfUnits(unitsHeldBy(all, holder));
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

function placeClaim(unit: Unit, holder: string): boolean {
  mkdirSync(claimsDir(), { recursive: true });
  const staging = mkdtempSync(join(claimsDir(), ".claim-"));
  const written = join(staging, "holder");
  writeFileSync(written, holder);
  try {
    linkSync(written, claimFile(unit));
    return true;
  } catch (error) {
    if (systemErrorCode(error) === ALREADY_EXISTS) return false;
    throw error;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function dropClaim(unit: Unit, holder: string): void {
  if (holderAt(claimFile(unit)) === holder) rmSync(claimFile(unit), { force: true });
}

function dropClaims(held: readonly Unit[], holder: string): void {
  for (const unit of [...held].sort((a, b) => b - a)) dropClaim(unit, holder);
}

type Reclaim = (other: WorktreeName) => boolean;

function takenOver(project: Project, holder: string, reclaim: Reclaim): boolean {
  if (!existsSync(holder)) {
    freeStale(holder, unitsHeldBy(claims(), holder));
    return true;
  }
  if (dirname(holder) !== ledgerDir(project)) return false;
  return reclaim(storedName(basename(holder)));
}

async function isFree(project: Project, unit: Unit, holder: string, reclaim: Reclaim): Promise<boolean> {
  const taken = holderAt(claimFile(unit));
  if (taken === holder) return true;
  if (taken !== null && !takenOver(project, taken, reclaim)) return false;
  return !(await isInUse(unit));
}

async function firstBusy(
  project: Project,
  candidate: readonly Unit[],
  holder: string,
  reclaim: Reclaim,
): Promise<number | null> {
  for (const [index, unit] of candidate.entries())
    if (!(await isFree(project, unit, holder, reclaim))) return index;
  return null;
}

function placeAll(candidate: readonly Unit[], holder: string): boolean {
  const placed: Unit[] = [];
  for (const unit of candidate) {
    if (placeClaim(unit, holder)) placed.push(unit);
    else if (holderAt(claimFile(unit)) !== holder) {
      dropClaims(placed, holder);
      return false;
    }
  }
  return true;
}

async function claimLowest(
  project: Project,
  holder: string,
  unitCount: number,
  reclaim: Reclaim,
): Promise<Block | null> {
  const all = units();
  let start = 0;
  while (start + unitCount <= all.length) {
    const candidate = all.slice(start, start + unitCount);
    const busy = await firstBusy(project, candidate, holder, reclaim);
    if (busy !== null) start += busy + 1;
    else if (placeAll(candidate, holder)) return blockOfUnits(candidate);
    else start += 1;
  }
  return null;
}

export async function claimBlock(
  project: Project,
  name: WorktreeName,
  wanted: PortRequest,
  reclaim: Reclaim,
): Promise<Block> {
  const held = blockOf(project, name);
  if (held !== null && isRunOf(held, wanted.unitCount)) return held;
  const holder = entryDir(project, name);
  const block = await claimLowest(project, holder, wanted.unitCount, reclaim);
  const outside = unitsHeldBy(claims(), holder).filter((unit) => block === null || !block.includes(unit));
  dropClaims(outside, holder);
  if (block === null) throw refuse("no_free_ports", { name, ports: wanted.ports });
  note(`port block ${blockText(block)} for ${name}`);
  return block;
}

export function releaseBlock(project: Project, name: WorktreeName): void {
  const holder = entryDir(project, name);
  dropClaims(unitsHeldBy(claims(), holder), holder);
}

export function unregister(project: Project, name: WorktreeName): void {
  releaseBlock(project, name);
  rmSync(entryDir(project, name), { recursive: true, force: true });
}

function setAside(unit: Unit): string | null {
  const moved = join(mkdtempSync(join(claimsDir(), ".stale-")), "claim");
  try {
    renameSync(claimFile(unit), moved);
    return moved;
  } catch (error) {
    rmSync(dirname(moved), { recursive: true, force: true });
    if (systemErrorCode(error) === GONE) return null;
    throw error;
  }
}

function putBack(unit: Unit, moved: string): void {
  try {
    linkSync(moved, claimFile(unit));
  } catch (error) {
    if (systemErrorCode(error) !== ALREADY_EXISTS) throw error;
  }
}

function freedUnit(unit: Unit): boolean {
  const moved = setAside(unit);
  if (moved === null) return false;
  const holder = holderAt(moved);
  const freed = holder !== null && !existsSync(holder);
  if (!freed) putBack(unit, moved);
  rmSync(dirname(moved), { recursive: true, force: true });
  return freed;
}

function freeStale(holder: string, stale: readonly Unit[]): void {
  const freed = blockOfUnits([...stale].sort((a, b) => b - a).filter(freedUnit));
  if (freed !== null) note(`port block ${blockText(freed)} freed from ${holder}, which is gone`);
}

export function freeStaleBlocks(): void {
  const all = claims();
  const gone = new Set(all.map((claim) => claim.holder).filter((holder) => !existsSync(holder)));
  for (const holder of gone) freeStale(holder, unitsHeldBy(all, holder));
}
