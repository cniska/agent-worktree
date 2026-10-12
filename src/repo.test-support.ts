import { execFileSync, spawnSync } from "node:child_process";
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
import { dirname, join, resolve } from "node:path";
import { CodedError } from "./coded-error";
import { type Project, parseName, type WorktreeName, worktreePath } from "./project";

const CLI = resolve(import.meta.dir, "cli.ts");

const scratchDirs: string[] = [];

export function caseSensitiveFilesystem(): boolean {
  const dir = scratchDir();
  mkdirSync(join(dir, "Case"));
  return !existsSync(join(dir, "case"));
}

export function scratchDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agent-worktrees-")));
  scratchDirs.push(dir);
  return dir;
}

export function removeScratchDirs(): void {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  scriptFiles.clear();
}

type Run = { readonly status: number | null; readonly stdout: string; readonly stderr: string };

export function cli(cwd: string, args: readonly string[], stdin: string | null = null): Run {
  const run = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    input: stdin ?? undefined,
    env: { ...process.env, FORCE_COLOR: "3" },
  });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
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

export function projectAt(dir: string): Project {
  return { primary: dir, commonDir: join(dir, ".git") };
}

const RECORD = { setup: "setup-record", teardown: "teardown-record" } as const;

export const SETUP_RECORD = `$WORKTREE_PRIMARY/../${RECORD.setup}`;
export const TEARDOWN_RECORD = `$WORKTREE_PRIMARY/../${RECORD.teardown}`;

export function recording(record: string): string {
  return `printf '%s\\n' "\${WORKTREE_NAME-unset}" "$WORKTREE_PATH" "$WORKTREE_PRIMARY" "$(pwd -P)" > "${record}"`;
}

export function recorded(path: string): readonly string[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "");
}

const scriptFiles = new Map<string, string>();

function scriptFile(body: string): string {
  const known = scriptFiles.get(body);
  if (known !== undefined) return known;
  const path = join(scratchDir(), "script.sh");
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  scriptFiles.set(body, path);
  return path;
}

type ScriptName = "worktree-setup.sh" | "worktree-teardown.sh";

function linkScript(checkout: string, name: ScriptName, body: string): void {
  const path = join(checkout, "scripts", name);
  mkdirSync(dirname(path), { recursive: true });
  rmSync(path, { force: true });
  symlinkSync(scriptFile(body), path);
}

export function script(checkout: string, name: ScriptName, body: string): void {
  linkScript(checkout, name, body);
  git(checkout, ["add", `scripts/${name}`]);
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

export function fixture({ setup, teardown }: { setup?: string; teardown?: string } = {}): Fixture {
  const dir = repo();
  linkScript(dir, "worktree-setup.sh", setup ?? recording(SETUP_RECORD));
  if (teardown !== undefined) linkScript(dir, "worktree-teardown.sh", teardown);
  git(dir, ["add", "scripts"]);
  git(dir, ["commit", "-q", "-m", "scripts"]);
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
