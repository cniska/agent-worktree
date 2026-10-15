import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CodedError } from "./coded-error";
import { type Block, blockOfUnits, isInUse, parseUnit, type Unit, units } from "./ports";
import { type Project, parseName, type WorktreeName, worktreePath } from "./project";

const scratchDirs: string[] = [];

export function caseSensitiveFilesystem(): boolean {
  const dir = scratchDir();
  mkdirSync(join(dir, "Case"));
  return !existsSync(join(dir, "case"));
}

export function scratchDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agent-worktree-")));
  scratchDirs.push(dir);
  return dir;
}

export function removeScratchDirs(): void {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  hookFiles.clear();
}

export function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

export function repo(): string {
  const dir = join(scratchDir(), "repo");
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  writeFileSync(join(dir, "README.md"), "initial");
  git(dir, ["add", "README.md"]);
  git(dir, ["commit", "-q", "-m", "initial"]);
  return dir;
}

export function withRemote(dir: string, name: string): string {
  const bare = join(scratchDir(), `${name}.git`);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  git(dir, ["remote", "add", name, bare]);
  git(dir, ["push", "-q", name, "main"]);
  return bare;
}

export function projectAt(dir: string): Project {
  return { primary: dir, commonDir: join(dir, ".git") };
}

const RECORD = { setup: "setup-record", teardown: "teardown-record" } as const;

export const SETUP_RECORD = `$WORKTREE_PRIMARY/../${RECORD.setup}`;
export const TEARDOWN_RECORD = `$WORKTREE_PRIMARY/../${RECORD.teardown}`;

export function recording(record: string): string {
  return `printf '%s\\n' "\${WORKTREE_NAME-unset}" "\${WORKTREE_PATH-unset}" "$WORKTREE_PRIMARY" "$(pwd -P)" > "${record}"`;
}

export function recorded(path: string): readonly string[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "");
}

const hookFiles = new Map<string, string>();

function hookFile(body: string): string {
  const known = hookFiles.get(body);
  if (known !== undefined) return known;
  const path = join(scratchDir(), "hook.sh");
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  hookFiles.set(body, path);
  return path;
}

export const HOOKS = ".worktree-hooks";

type HookName = "setup" | "teardown";

function linkHook(checkout: string, name: HookName, body: string): void {
  const path = join(checkout, HOOKS, name);
  mkdirSync(dirname(path), { recursive: true });
  rmSync(path, { force: true });
  symlinkSync(hookFile(body), path);
}

export function hook(checkout: string, name: HookName, body: string): void {
  linkHook(checkout, name, body);
  git(checkout, ["add", HOOKS]);
  git(checkout, ["commit", "-q", "-m", name]);
}

export type Fixture = {
  readonly dir: string;
  readonly project: Project;
  readonly setupRecord: string;
  readonly teardownRecord: string;
  name(raw: string): WorktreeName;
  path(raw: string): string;
};

export async function freeUnits(): Promise<readonly Unit[]> {
  const inUse = await Promise.all(units().map(isInUse));
  return units().filter((_, index) => !inUse[index]);
}

export async function firstFreeUnit(): Promise<Unit> {
  const [free] = await freeUnits();
  if (free === undefined) throw new Error("every port unit is in use on this machine");
  return free;
}

export function unitAt(first: Unit, offset: number): Unit {
  const unit = parseUnit(String(first + offset * 10));
  if (unit === null) throw new Error(`no unit ${offset} after ${first}`);
  return unit;
}

function runFrom(first: Unit, count: number): readonly Unit[] {
  return Array.from({ length: count }, (_, offset) => unitAt(first, offset));
}

export function blockAt(first: Unit, count = 1): Block {
  const block = blockOfUnits(runFrom(first, count));
  if (block === null) throw new Error(`no run of ${count} units from ${first}`);
  return block;
}

export async function firstFreeRun(count: number): Promise<Unit> {
  const free = new Set(await freeUnits());
  const last = units().length - count;
  const first = units().find(
    (unit, index) => index <= last && runFrom(unit, count).every((each) => free.has(each)),
  );
  if (first === undefined) throw new Error(`no ${count} consecutive port units are free on this machine`);
  return first;
}

export function requestPorts(checkout: string, ports: string): void {
  const path = join(checkout, HOOKS, "ports");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, ports);
  git(checkout, ["add", HOOKS]);
  git(checkout, ["commit", "-q", "-m", "ports"]);
}

type FixtureOptions = { setup?: string; teardown?: string; ports?: number };

export function fixture({ setup, teardown, ports }: FixtureOptions = {}): Fixture {
  const dir = repo();
  if (ports !== undefined) requestPorts(dir, `${ports}\n`);
  process.env.XDG_DATA_HOME = join(dirname(dir), "data");
  linkHook(dir, "setup", setup ?? recording(SETUP_RECORD));
  if (teardown !== undefined) linkHook(dir, "teardown", teardown);
  git(dir, ["add", HOOKS]);
  git(dir, ["commit", "-q", "-m", "hooks"]);
  const current = projectAt(dir);
  const names = new Map<string, WorktreeName>();
  const name = (raw: string): WorktreeName => {
    const known = names.get(raw);
    if (known !== undefined) return known;
    const parsed = parseName(current, raw);
    names.set(raw, parsed);
    return parsed;
  };
  return {
    dir,
    project: current,
    setupRecord: join(dirname(dir), RECORD.setup),
    teardownRecord: join(dirname(dir), RECORD.teardown),
    name,
    path: (raw) => worktreePath(current, name(raw)),
  };
}

export function hookEvent(fields: Record<string, string>): string {
  return JSON.stringify({
    session_id: "00000000-0000-0000-0000-000000000000",
    transcript_path: "/transcripts/session.jsonl",
    cwd: "/checkout",
    ...fields,
  });
}

export function refusal(run: () => unknown): CodedError {
  try {
    run();
  } catch (error) {
    if (error instanceof CodedError && error.kind === "refusal") return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

export async function rejection(run: () => Promise<unknown>): Promise<CodedError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof CodedError && error.kind === "refusal") return error;
    throw error;
  }
  throw new Error("expected a refusal");
}
