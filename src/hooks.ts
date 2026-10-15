import { spawnSync } from "node:child_process";
import { accessSync, chmodSync, constants, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { refuser, systemErrorCode } from "./coded-error";
import { type Exit, exitOf } from "./exit";
import { note } from "./log";
import { type Block, PORT_LIMIT, type PortRequest, parsePortRequest } from "./ports";
import type { WorktreeName } from "./project";

const HOOKS_DIR = ".worktree-hooks";

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
  readonly invalid_ports: { readonly hook: string; readonly checkout: string; readonly found: string };
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
    message: ({ hook, found }) => `${hook} must hold one whole number of ports ${PORT_LIMIT}, and ${found}`,
    resolve: ({ hook, checkout }) =>
      `run agent-worktree install --ports <n> in ${checkout} with the number of ports the worktree needs, or delete ${hook} when it needs none, then run the command again`,
  },
});

function hooksDir(checkout: string): string {
  return join(checkout, HOOKS_DIR);
}

export function portRequest(checkout: string): PortRequest | null {
  const hook = join(hooksDir(checkout), PORTS);
  if (!exists(hook)) return null;
  const text = readText(hook);
  if (text === null) throw refuse("invalid_ports", { hook, checkout, found: "cannot be read as a file" });
  const request = parsePortRequest(text);
  if (request === null)
    throw refuse("invalid_ports", { hook, checkout, found: `holds: ${JSON.stringify(text)}` });
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

export function hookIn(checkout: string, name: CommandHook): string | null {
  const hook = join(hooksDir(checkout), name);
  if (!exists(hook)) return null;
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

export function install(checkout: string, installed: Installed): readonly string[] {
  const dir = hooksDir(checkout);
  mkdirSync(dir, { recursive: true });
  return toWrite(installed).map(({ name, text, mode }) => {
    const hook = join(dir, name);
    writeFileSync(hook, text);
    chmodSync(hook, mode);
    return hook;
  });
}
