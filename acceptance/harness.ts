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
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { decode, type JsonObject, type JsonValue } from "@toon-format/toon";

const ENTRY = join(import.meta.dir, "..", "src", "cli.ts");

const BUILD_COMPILED = join(import.meta.dir, "..", "scripts", "build-compiled.sh");

const NO_TRANSPILER_CACHE = "0";

export const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

const RELEASE_DOWNLOADS = "https://github.com/cniska/agent-worktree/releases/latest/download";

type Env = Readonly<Record<string, string>>;

export type Ran = { readonly exitCode: number; readonly stdout: string; readonly stderr: string };

export type World = {
  readonly root: string;
  readonly home: string;
  readonly data: string;
  readonly env: Env;
};

const scratchDirs: string[] = [];

function scratchDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agent-worktree-acceptance-")));
  scratchDirs.push(dir);
  return dir;
}

export function removeScratchDirs(): void {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function world(): World {
  const root = scratchDir();
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

const OFFLINE = [
  "/usr/bin/sandbox-exec",
  "-p",
  '(version 1)(allow default)(deny network*)(allow network-outbound (remote ip "localhost:*"))',
];

type RunOptions = { readonly stdin?: string; readonly env?: Env; readonly unset?: readonly string[] };

function environment(w: World, { env, unset }: RunOptions): Env {
  return Object.fromEntries(Object.entries({ ...w.env, ...env }).filter(([name]) => !unset?.includes(name)));
}

function spawn(w: World, cwd: string, argv: readonly string[], options: RunOptions): Ran {
  const [program = "", ...args] = [...OFFLINE, ...argv];
  const ran = spawnSync(program, args, {
    cwd,
    input: options.stdin ?? "",
    encoding: "utf8",
    env: environment(w, options),
  });
  return { exitCode: ran.status ?? -1, stdout: ran.stdout, stderr: ran.stderr };
}

export async function runAsync(w: World, cwd: string, args: readonly string[]): Promise<Ran> {
  const child = Bun.spawn([...OFFLINE, process.execPath, ENTRY, ...args], {
    cwd,
    env: environment(w, {}),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

export function runAtOnce(
  w: World,
  cwd: string,
  runs: readonly (readonly string[])[],
): Promise<readonly Ran[]> {
  return Promise.all(runs.map((args) => runAsync(w, cwd, args)));
}

export function run(w: World, cwd: string, args: readonly string[], options: RunOptions = {}): Ran {
  return spawn(w, cwd, [process.execPath, ENTRY, ...args], options);
}

export function compiledBinary(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const binary = join(dir, "agent-worktree");
  const built = spawnSync("bash", [BUILD_COMPILED, binary], {
    encoding: "utf8",
    env: { PATH: `${dirname(process.execPath)}:${SYSTEM_PATH}` },
  });
  if (built.status !== 0) throw new Error(`build-compiled.sh exited ${built.status}: ${built.stderr}`);
  return binary;
}

export function toolsOnly(w: World, tools: readonly string[]): string {
  const bin = join(w.root, "tools");
  mkdirSync(bin, { recursive: true });
  for (const tool of tools) {
    const found = Bun.which(tool, { PATH: w.env.PATH });
    if (found === null) throw new Error(`${tool} is not on PATH`);
    symlinkSync(found, join(bin, tool));
  }
  return bin;
}

export function runOnPath(w: World, cwd: string, path: string, args: readonly string[]): Ran {
  return spawn(w, cwd, ["agent-worktree", ...args], { env: { PATH: path } });
}

export function runProgram(w: World, cwd: string, argv: readonly string[], env: Env): Ran {
  return spawn(w, cwd, argv, { env });
}

export function releaseAssets(dir: string, binary: string, target: string): string {
  mkdirSync(dir, { recursive: true });
  const tarball = join(dir, `agent-worktree-${target}.tar.gz`);
  const packed = spawnSync("tar", ["-czf", tarball, "-C", dirname(binary), basename(binary)], {
    encoding: "utf8",
  });
  if (packed.status !== 0) throw new Error(`tar exited ${packed.status}: ${packed.stderr}`);
  const digest = new Bun.CryptoHasher("sha256").update(readFileSync(tarball)).digest("hex");
  writeFileSync(join(dir, `agent-worktree-${target}.sha256`), `${digest}  agent-worktree-${target}.tar.gz\n`);
  return dir;
}

export function curlServing(bin: string, assets: string): string {
  mkdirSync(bin, { recursive: true });
  const curl = join(bin, "curl");
  writeFileSync(
    curl,
    [
      "#!/bin/sh",
      "url=; out=",
      'while [ "$#" -gt 0 ]; do case "$1" in -o) out="$2"; shift ;; https://*) url="$1" ;; esac; shift; done',
      `file="${assets}/\${url##*/}"`,
      `case "$url" in ${RELEASE_DOWNLOADS}/*) ;; *) exit 22 ;; esac`,
      '[ -f "$file" ] || exit 22',
      'cp "$file" "$out"',
      "",
    ].join("\n"),
  );
  chmodSync(curl, 0o755);
  return bin;
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

export function commitIn(w: World, checkout: string, file: string): string {
  writeFileSync(join(checkout, file), `${file}\n`);
  git(w, checkout, ["add", file]);
  git(w, checkout, ["commit", "-q", "-m", file]);
  return git(w, checkout, ["rev-parse", "HEAD"]);
}

export function repo(w: World, at = join(w.root, "clones", "repo")): string {
  mkdirSync(dirname(at), { recursive: true });
  git(w, w.root, ["init", "-q", "-b", "main", at]);
  writeFileSync(join(at, "README.md"), "initial\n");
  git(w, at, ["add", "README.md"]);
  git(w, at, ["commit", "-q", "-m", "initial"]);
  return at;
}

export function bareRemote(w: World, dir: string): string {
  const bare = join(w.root, "remotes", "origin.git");
  mkdirSync(dirname(bare), { recursive: true });
  git(w, w.root, ["init", "-q", "--bare", "-b", "main", bare]);
  git(w, dir, ["remote", "add", "origin", bare]);
  git(w, dir, ["push", "-q", "origin", "main"]);
  return bare;
}

export type HookName = "setup" | "teardown";

export function installHook(w: World, checkout: string, hook: HookName, body: string): void {
  succeeded(run(w, checkout, ["install", `--${hook}`, body]));
  git(w, checkout, ["add", HOOKS]);
  git(w, checkout, ["commit", "-q", "-m", hook]);
}

export const HOOKS = ".worktree-hooks";

export function requestPorts(w: World, checkout: string, text: string): void {
  const path = join(checkout, HOOKS, "ports");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  git(w, checkout, ["add", HOOKS]);
  git(w, checkout, ["commit", "-q", "-m", "ports"]);
}

export function recording(record: string): string {
  return `printf '%s\\t%s\\t%s\\t%s\\n' "\${WORKTREE_NAME-unset}" "\${WORKTREE_PATH-unset}" "$WORKTREE_PRIMARY" "$(pwd -P)" >> "${record}"`;
}

export function portRecording(record: string): string {
  return `printf '%s\\n' "\${WORKTREE_PORT-unset}" >> "${record}"`;
}

export function portsRecorded(record: string): readonly string[] {
  return existsSync(record) ? readFileSync(record, "utf8").split("\n").slice(0, -1) : [];
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
  const probe = printedPath(run(w, dir, ["path", "probe"]));
  const key = keyOf(w, probe);
  return { dir, path: (name) => join(w.data, key, name) };
}

const ONE_LINE_EACH = /^(?:[^\n]+\n)*$/;

export function printedLines(ran: Ran): readonly string[] {
  expect({ exitCode: ran.exitCode, stderr: ran.stderr }).toMatchObject({ exitCode: 0 });
  expect(ran.stdout).toMatch(ONE_LINE_EACH);
  return ran.stdout.split("\n").slice(0, -1);
}

function isRecord(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: JsonValue | undefined): JsonObject {
  if (value === undefined || !isRecord(value)) throw new Error(`${JSON.stringify(value)} is not a record`);
  return value;
}

function text(value: JsonValue | undefined): string {
  if (typeof value !== "string") throw new Error(`${JSON.stringify(value)} is not a string`);
  return value;
}

function envelope(toon: string): JsonObject {
  expect(toon).toEndWith("\n");
  expect(toon).not.toEndWith("\n\n");
  return record(decode(toon));
}

export function succeeded(ran: Ran): JsonValue {
  expect({ exitCode: ran.exitCode, stderr: ran.stderr }).toMatchObject({ exitCode: 0 });
  const shown = envelope(ran.stdout);
  expect(shown.ok).toBe(true);
  expect(Object.keys(shown)).toEqual(["command", "ok", "result"]);
  return shown.result ?? null;
}

export function printedPath(ran: Ran): string {
  const result = record(succeeded(ran));
  expect(Object.keys(result)).toEqual(["path"]);
  return text(result.path);
}

export function removed(ran: Ran): JsonObject {
  return record(succeeded(ran));
}

export type Refusal = { readonly message: string; readonly act: string };

const ENVELOPE_START = /(?:^|\n)(command: [^\n]*\nok: false\n[\s\S]*)$/;

type Printed = Refusal & { readonly code: string; readonly kind: string };

export function errorOf(ran: Ran, command: string): Printed {
  const match = ENVELOPE_START.exec(ran.stderr);
  expect({ stderr: ran.stderr, envelope: match !== null }).toMatchObject({ envelope: true });
  const shown = envelope(match?.[1] ?? "");
  expect(shown.command).toBe(command);
  expect(shown.ok).toBe(false);
  const error = record(shown.error);
  expect(Object.keys(error)).toEqual(["kind", "code", "message", "meta", "resolve"]);
  record(error.meta);
  return {
    kind: text(error.kind),
    code: text(error.code),
    message: text(error.message),
    act: text(error.resolve),
  };
}

function refusalOf(ran: Ran, exitCode: number, command: string | null): Refusal {
  expect({ exitCode: ran.exitCode, stdout: ran.stdout }).toEqual({ exitCode, stdout: "" });
  const { message, act } = errorOf(ran, command ?? "agent-worktree");
  return { message, act };
}

export function refused(ran: Ran, command: string): Refusal {
  return refusalOf(ran, 1, command);
}

export function usageRefused(ran: Ran, command: string | null): Refusal {
  const refusal = refusalOf(ran, 2, command);
  expect(errorOf(ran, command ?? "agent-worktree").code).toBe("usage");
  return refusal;
}

const STATES = ["ready", "pending", "orphaned", "unlisted", "unmanaged", "legacy"] as const;

export type Listed = {
  readonly name: string;
  readonly state: (typeof STATES)[number];
  readonly branch: string | null;
  readonly path: string;
};

function isState(value: JsonValue | undefined): value is Listed["state"] {
  return STATES.some((state) => state === value);
}

type ListedFull = Listed & { readonly ports: string | null };

function nullable(value: JsonValue | undefined): string | null {
  return value === null ? null : text(value);
}

function rows(listing: JsonValue): readonly JsonObject[] {
  const { worktrees } = record(listing);
  if (!Array.isArray(worktrees)) throw new Error(`${JSON.stringify(worktrees)} is not a list`);
  return worktrees.map(record);
}

function listed(w: World, dir: string): readonly ListedFull[] {
  const full = succeeded(run(w, dir, ["ls", "--full"]));
  const brief = succeeded(run(w, dir, ["ls"]));
  const records = rows(full).map((row) => {
    expect(Object.keys(row)).toEqual(["name", "state", "branch", "ports", "path"]);
    const { name, state, branch, ports, path } = row;
    if (!isState(state)) throw new Error(`${String(state)} is not a state ls prints`);
    return { name: text(name), state, branch: nullable(branch), ports: nullable(ports), path: text(path) };
  });
  expect(rows(brief)).toEqual(records.map(({ name, state, path }) => ({ name, state, path })));
  const counts = Object.fromEntries(
    STATES.map((state) => [state, records.filter((each) => each.state === state).length] as const),
  );
  expect(record(brief).counts).toEqual(counts);
  expect(record(full).counts).toEqual(counts);
  return records;
}

export function ls(w: World, dir: string): readonly Listed[] {
  return listed(w, dir).map(({ name, state, branch, path }) => ({ name, state, branch, path }));
}

export function lsPorts(w: World, dir: string): Readonly<Record<string, string | null>> {
  return Object.fromEntries(listed(w, dir).map(({ name, ports }) => [name, ports]));
}

const FIRST_UNIT = 24000;

const UNIT_WIDTH = 10;

const UNIT_COUNT = 100;

async function listenedOn(hostname: string, port: number): Promise<boolean> {
  try {
    (await Bun.connect({ hostname, port, socket: { data() {} } })).terminate();
    return true;
  } catch {
    return false;
  }
}

async function unitInUse(unit: number): Promise<boolean> {
  const ports = Array.from({ length: UNIT_WIDTH }, (_, offset) => unit + offset);
  const probes = ports.flatMap((port) => ["127.0.0.1", "::1"].map((host) => listenedOn(host, port)));
  return (await Promise.all(probes)).some((listened) => listened);
}

type FreeUnits = readonly [number, number, number, ...number[]];

function atLeastThree(units: readonly number[]): units is FreeUnits {
  return units.length >= 3;
}

export async function freeUnits(): Promise<FreeUnits> {
  const all = Array.from({ length: UNIT_COUNT }, (_, index) => FIRST_UNIT + index * UNIT_WIDTH);
  const inUse = await Promise.all(all.map(unitInUse));
  const free = all.filter((_, index) => !inUse[index]);
  if (!atLeastThree(free)) throw new Error("fewer than three port units are free on this machine");
  return free;
}

export function firstRun(free: readonly number[], count: number): number {
  const taken = new Set(free);
  const first = free.find((unit) =>
    Array.from({ length: count }, (_, offset) => unit + offset * UNIT_WIDTH).every((each) => taken.has(each)),
  );
  if (first === undefined) throw new Error(`no ${count} consecutive port units are free on this machine`);
  return first;
}

export function blockText(block: number, ports = UNIT_WIDTH): string {
  return `${block}-${block + ports - 1}`;
}

export type Address = { readonly hostname: string; readonly port: number };

export type Listener = { readonly connections: () => number };

export function onLoopback(ports: readonly number[]): readonly Address[] {
  return ports.map((port) => ({ hostname: "127.0.0.1", port }));
}

export async function holding<T>(
  addresses: readonly Address[],
  body: (held: readonly Listener[]) => Promise<T>,
): Promise<T> {
  const counts = addresses.map(() => 0);
  const held = addresses.map(({ hostname, port }, index) =>
    Bun.listen({
      hostname,
      port,
      socket: {
        open() {
          counts[index] = (counts[index] ?? 0) + 1;
        },
        data() {},
      },
    }),
  );
  try {
    return await body(addresses.map((_, index) => ({ connections: () => counts[index] ?? 0 })));
  } finally {
    for (const each of held) each.stop(true);
  }
}

export function hookEvent(fields: Readonly<Record<string, string>>): string {
  return JSON.stringify({
    session_id: "00000000-0000-0000-0000-000000000000",
    transcript_path: "/transcripts/session.jsonl",
    cwd: "/checkout",
    ...fields,
  });
}
