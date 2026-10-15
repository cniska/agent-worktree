import { spawnSync } from "node:child_process";
import { accessSync, chmodSync, constants, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { unreachable } from "./assert";
import { refuser, systemErrorCode } from "./coded-error";
import { type Exit, exitOf } from "./exit";
import { note } from "./log";
import { type Block, PORT_LIMIT, type PortRequest, parsePortRequest } from "./ports";
import type { Project, WorktreeName } from "./project";

const HOOKS_DIR = "worktree-hooks";

export type CommandHook = "setup" | "teardown";

const PORTS = "ports";

export type Installed = {
  readonly setup: string | null;
  readonly teardown: string | null;
  readonly ports: PortRequest | null;
};

type HookEnv = {
  readonly name: WorktreeName | null;
  readonly path: string | null;
  readonly primary: string;
  readonly block: Block | null;
};

const refuse = refuser<{
  readonly hook_not_executable: { readonly hook: string };
  readonly hook_unrunnable: { readonly hook: string; readonly detail: string };
  readonly invalid_ports: { readonly found: Found; readonly checkout: string; readonly holds: string };
}>({
  hook_not_executable: {
    message: ({ hook }) => `${hook} exists but is not executable`,
    resolve: ({ hook }) => `chmod +x ${hook}, or delete it when it is not needed, then run the command again`,
  },
  hook_unrunnable: {
    message: ({ hook, detail }) => `${hook} could not start: ${detail}`,
    resolve: () => "fix the hook's interpreter line, then run the command again",
  },
  invalid_ports: {
    message: ({ found, holds }) =>
      `${found.hook} must hold one whole number of ports ${PORT_LIMIT}, and ${holds}`,
    resolve: ({ found, checkout }) =>
      `run ${reinstall(found.place, checkout)} with the number of ports the worktree needs, or delete ${found.hook} when it needs none, then run the command again`,
  },
});

export type Place = "committed" | "local";

function hooksDir(project: Project, checkout: string, place: Place): string {
  return place === "local" ? join(project.commonDir, HOOKS_DIR) : join(checkout, `.${HOOKS_DIR}`);
}

type Found = { readonly hook: string; readonly place: Place };

function reinstall(place: Place, checkout: string): string {
  switch (place) {
    case "local":
      return "agent-worktree install --local --ports <n>";
    case "committed":
      return `agent-worktree install --ports <n> in ${checkout}`;
    default:
      return unreachable(place);
  }
}

function find(project: Project, checkout: string, name: string): Found | null {
  const local = join(hooksDir(project, checkout, "local"), name);
  if (exists(local)) return { hook: local, place: "local" };
  const committed = join(hooksDir(project, checkout, "committed"), name);
  return exists(committed) ? { hook: committed, place: "committed" } : null;
}

export function portRequest(project: Project, checkout: string): PortRequest | null {
  const found = find(project, checkout, PORTS);
  if (found === null) return null;
  const text = readText(found.hook);
  if (text === null) throw refuse("invalid_ports", { found, checkout, holds: "cannot be read as a file" });
  const request = parsePortRequest(text);
  if (request === null)
    throw refuse("invalid_ports", { found, checkout, holds: `holds: ${JSON.stringify(text)}` });
  return request;
}

const UNREADABLE = new Set(["EISDIR", "ENOENT", "ELOOP", "ENOTDIR", "EACCES"]);

function readText(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    const code = systemErrorCode(error);
    if (code !== null && UNREADABLE.has(code)) return null;
    throw error;
  }
}

const NOT_EXECUTABLE = new Set(["EACCES", "ENOENT", "ENOTDIR", "ELOOP"]);

function isAccessRefusal(error: unknown): boolean {
  const code = systemErrorCode(error);
  return code !== null && NOT_EXECUTABLE.has(code);
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch (error) {
    if (isAccessRefusal(error)) return false;
    throw error;
  }
}

function exists(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
}

export function hookIn(project: Project, checkout: string, name: CommandHook): string | null {
  const hook = find(project, checkout, name)?.hook ?? null;
  if (hook === null) return null;
  if (!isExecutable(hook)) throw refuse("hook_not_executable", { hook });
  return hook;
}

export function runHook(hook: string, cwd: string, { name, path, primary, block }: HookEnv): Exit {
  note(`running ${hook} in ${cwd}`);
  const { WORKTREE_NAME: _name, WORKTREE_PATH: _path, WORKTREE_PORT: _port, ...env } = process.env;
  const named = name === null ? {} : { WORKTREE_NAME: name };
  const located = path === null ? {} : { WORKTREE_PATH: path };
  const ported = block === null ? {} : { WORKTREE_PORT: String(block[0]) };
  const run = spawnSync(hook, [], {
    cwd,
    env: { ...env, ...named, ...located, ...ported, WORKTREE_PRIMARY: primary },
    stdio: ["ignore", 2, 2],
  });
  if (run.error) throw refuse("hook_unrunnable", { hook, detail: run.error.message });
  return exitOf(run);
}

function quoted(command: string): string {
  return `'${command.replaceAll("'", "'\\''")}'`;
}

function commandHook(command: string): string {
  return `#!/bin/sh\nset -eu\n\ncommand=${quoted(command)}\n\nexec sh -ec "$command"\n`;
}

const RUNNABLE = 0o755;

const READ_ONLY = 0o644;

type Written = { readonly name: string; readonly text: string; readonly mode: number };

function toWrite({ setup, teardown, ports }: Installed): readonly Written[] {
  return [
    ...(setup === null ? [] : [{ name: "setup", text: commandHook(setup), mode: RUNNABLE }]),
    ...(teardown === null ? [] : [{ name: "teardown", text: commandHook(teardown), mode: RUNNABLE }]),
    ...(ports === null ? [] : [{ name: PORTS, text: `${ports.ports}\n`, mode: READ_ONLY }]),
  ];
}

export function install(
  project: Project,
  checkout: string,
  place: Place,
  installed: Installed,
): readonly string[] {
  const dir = hooksDir(project, checkout, place);
  mkdirSync(dir, { recursive: true });
  return toWrite(installed).map(({ name, text, mode }) => {
    const hook = join(dir, name);
    writeFileSync(hook, text);
    chmodSync(hook, mode);
    return hook;
  });
}
