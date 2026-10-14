import { expect } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ENTRY = join(import.meta.dir, "..", "src", "cli.ts");

const NO_TRANSPILER_CACHE = "0";

type Env = Readonly<Record<string, string>>;

export type Ran = { readonly exitCode: number; readonly stdout: string; readonly stderr: string };

export type World = {
  readonly root: string;
  readonly home: string;
  readonly data: string;
  readonly env: Env;
};

const scratchDirs: string[] = [];

export function removeScratch(): void {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function world(): World {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-worktree-acceptance-")));
  scratchDirs.push(root);
  const home = join(root, "home");
  const xdg = { XDG_DATA_HOME: "data", XDG_CONFIG_HOME: "config", XDG_STATE_HOME: "state" };
  for (const dir of [home, ...Object.values(xdg).map((name) => join(root, name))]) mkdirSync(dir);
  return {
    root,
    home,
    data: join(root, "data", "agent-worktree"),
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      ...Object.fromEntries(Object.entries(xdg).map(([variable, name]) => [variable, join(root, name)])),
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Test Author",
      GIT_AUTHOR_EMAIL: "author@example.test",
      GIT_COMMITTER_NAME: "Test Author",
      GIT_COMMITTER_EMAIL: "author@example.test",
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: NO_TRANSPILER_CACHE,
    },
  };
}

const OFFLINE = ["/usr/bin/sandbox-exec", "-p", "(version 1)(allow default)(deny network*)"];

type RunOptions = { readonly stdin?: string; readonly env?: Env; readonly unset?: readonly string[] };

function spawn(w: World, cwd: string, argv: readonly string[], { stdin, env, unset }: RunOptions): Ran {
  const [program = "", ...args] = [...OFFLINE, ...argv];
  const merged = Object.entries({ ...w.env, ...env }).filter(([name]) => !unset?.includes(name));
  const ran = spawnSync(program, args, {
    cwd,
    input: stdin ?? "",
    encoding: "utf8",
    env: Object.fromEntries(merged),
  });
  return { exitCode: ran.status ?? -1, stdout: ran.stdout, stderr: ran.stderr };
}

export function run(w: World, cwd: string, args: readonly string[], options: RunOptions = {}): Ran {
  return spawn(w, cwd, [process.execPath, ENTRY, ...args], options);
}

const LAUNCHER = join(import.meta.dir, "..", "bin", "agent-worktree");

export type Launched = Ran & { readonly callerPath: string };

export function launch(w: World, cwd: string, args: readonly string[]): Launched {
  const bin = join(w.root, "mise-bin");
  mkdirSync(bin, { recursive: true });
  const mise = join(bin, "mise");
  writeFileSync(mise, `#!/bin/sh\n[ "$1" = which ] && echo "${process.execPath}"\n`);
  chmodSync(mise, 0o755);
  const callerPath = `${bin}:${w.env.PATH}`;
  return { ...spawn(w, cwd, [LAUNCHER, ...args], { env: { PATH: callerPath } }), callerPath };
}

export const PLUGIN = join(import.meta.dir, "..", "plugin");

export function pluginCommand(w: World, cwd: string, command: string, stdin = ""): Ran {
  const bin = join(w.root, "bin");
  mkdirSync(bin, { recursive: true });
  const cli = join(bin, "agent-worktree");
  writeFileSync(cli, `#!/bin/sh\nexec "${process.execPath}" "${ENTRY}" "$@"\n`);
  chmodSync(cli, 0o755);
  return spawn(w, cwd, ["/bin/sh", "-c", command], {
    stdin,
    env: { PATH: `${bin}:${w.env.PATH}`, CLAUDE_PLUGIN_ROOT: PLUGIN },
  });
}

export function git(w: World, cwd: string, args: readonly string[]): string {
  const ran = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: w.env });
  expect({ args, status: ran.status, stderr: ran.stderr }).toMatchObject({ status: 0 });
  return ran.stdout.trim();
}

export function repo(w: World, at = join(w.root, "clones", "repo")): string {
  mkdirSync(dirname(at), { recursive: true });
  git(w, w.root, ["init", "-q", "-b", "main", at]);
  writeFileSync(join(at, "README.md"), "initial\n");
  git(w, at, ["add", "README.md"]);
  git(w, at, ["commit", "-q", "-m", "initial"]);
  return at;
}

export type ScriptName = "worktree-setup.sh" | "worktree-teardown.sh";

export function script(w: World, checkout: string, name: ScriptName, body: string): void {
  const path = join(checkout, "scripts", name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  git(w, checkout, ["add", `scripts/${name}`]);
  git(w, checkout, ["commit", "-q", "-m", name]);
}

export function recording(record: string): string {
  return `printf '%s\\t%s\\t%s\\t%s\\n' "\${WORKTREE_NAME-unset}" "\${WORKTREE_PATH-unset}" "$WORKTREE_PRIMARY" "$(pwd -P)" >> "${record}"`;
}

export type Recorded = {
  readonly name: string;
  readonly path: string;
  readonly primary: string;
  readonly cwd: string;
};

export function recorded(record: string): readonly Recorded[] {
  if (!existsSync(record)) return [];
  return readFileSync(record, "utf8")
    .split("\n")
    .slice(0, -1)
    .map((line) => {
      const fields = line.split("\t");
      expect(fields).toHaveLength(4);
      const [name = "", path = "", primary = "", cwd = ""] = fields;
      return { name, path, primary, cwd };
    });
}

export function keyOf(w: World, path: string): string {
  expect(dirname(dirname(path))).toBe(w.data);
  return dirname(path).slice(w.data.length + 1);
}

export type Project = { readonly dir: string; path(name: string): string };

export function project(w: World): Project {
  const dir = repo(w);
  const [probe = ""] = succeeded(run(w, dir, ["path", "probe"]));
  const key = keyOf(w, probe);
  return { dir, path: (name) => join(w.data, key, name) };
}

const ONE_LINE_EACH = /^(?:[^\n]+\n)*$/;

export function succeeded(ran: Ran): readonly string[] {
  expect({ exitCode: ran.exitCode, stderr: ran.stderr }).toMatchObject({ exitCode: 0 });
  expect(ran.stdout).toMatch(ONE_LINE_EACH);
  return ran.stdout.split("\n").slice(0, -1);
}

export type Refusal = { readonly message: string; readonly act: string };

const REFUSAL_TAIL = /(?:^|\n)agent-worktree(?: ([a-z]+))?: ([^\n]+)\n {2}([^\n]+)\n$/;

function refusalOf(ran: Ran, exitCode: number, command: string | null): Refusal {
  expect({ exitCode: ran.exitCode, stdout: ran.stdout }).toEqual({ exitCode, stdout: "" });
  const match = REFUSAL_TAIL.exec(ran.stderr);
  expect({ stderr: ran.stderr, refusal: match !== null }).toMatchObject({ refusal: true });
  const [, named, message = "", act = ""] = match ?? [];
  expect(named ?? null).toBe(command);
  return { message, act };
}

export function refused(ran: Ran, command: string): Refusal {
  return refusalOf(ran, 1, command);
}

export function usageRefused(ran: Ran, command: string | null): Refusal {
  return refusalOf(ran, 2, command);
}

const STATES = [
  "ready",
  "setup pending",
  "orphaned (prune)",
  "unlisted",
  "unmanaged",
  "legacy (move or drop)",
] as const;

export type Listed = {
  readonly name: string;
  readonly state: (typeof STATES)[number];
  readonly branch: string;
  readonly path: string;
};

function isState(text: string): text is Listed["state"] {
  return STATES.some((state) => state === text);
}

export function ls(w: World, dir: string): readonly Listed[] {
  return succeeded(run(w, dir, ["ls"])).map((line) => {
    const fields = line.split("\t");
    expect(fields).toHaveLength(4);
    const [name = "", state = "", branch = "", path = ""] = fields;
    if (!isState(state)) throw new Error(`${state} is not a state ls prints`);
    return { name, state, branch, path };
  });
}

export function hookEvent(fields: Readonly<Record<string, string>>): string {
  return JSON.stringify({
    session_id: "00000000-0000-0000-0000-000000000000",
    transcript_path: "/transcripts/session.jsonl",
    cwd: "/checkout",
    ...fields,
  });
}
