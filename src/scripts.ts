import { spawnSync } from "node:child_process";
import { accessSync, constants, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { refuser, systemErrorCode } from "./coded-error";
import { type Exit, exitOf } from "./exit";
import { note } from "./log";
import { type Block, PORT_LIMIT, type PortRequest, parsePortRequest } from "./ports";
import type { WorktreeName } from "./project";

export const SETUP = "scripts/worktree-setup.sh";
export const TEARDOWN = "scripts/worktree-teardown.sh";
const PORTS = "scripts/worktree-ports";

type ScriptEnv = {
  readonly name: WorktreeName | null;
  readonly path: string | null;
  readonly primary: string;
  readonly block: Block | null;
};

const refuse = refuser<{
  readonly script_not_executable: { readonly script: string };
  readonly script_unrunnable: { readonly script: string; readonly detail: string };
  readonly invalid_ports: { readonly file: string; readonly found: string };
}>({
  script_not_executable: {
    message: ({ script }) => `${script} exists but is not executable`,
    resolve: ({ script }) =>
      `chmod +x ${script}, or delete it when it is not needed, then run the command again`,
  },
  script_unrunnable: {
    message: ({ script, detail }) => `${script} could not start: ${detail}`,
    resolve: () => "fix the script's interpreter line, then run the command again",
  },
  invalid_ports: {
    message: ({ file, found }) => `${file} must hold one whole number of ports ${PORT_LIMIT}, and ${found}`,
    resolve: ({ file }) =>
      `write the number of ports the worktree needs into ${file}, or delete it when it needs none, then run the command again`,
  },
});

export function portRequest(checkout: string): PortRequest | null {
  const file = join(checkout, PORTS);
  if (!exists(file)) return null;
  const text = readText(file);
  if (text === null) throw refuse("invalid_ports", { file, found: "cannot be read as a file" });
  const request = parsePortRequest(text);
  if (request === null) throw refuse("invalid_ports", { file, found: `holds: ${JSON.stringify(text)}` });
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

export function scriptIn(checkout: string, relative: typeof SETUP | typeof TEARDOWN): string | null {
  const script = join(checkout, relative);
  if (!exists(script)) return null;
  if (!isExecutable(script)) throw refuse("script_not_executable", { script });
  return script;
}

export function runScript(script: string, cwd: string, { name, path, primary, block }: ScriptEnv): Exit {
  note(`running ${script} in ${cwd}`);
  const { WORKTREE_NAME: _name, WORKTREE_PATH: _path, WORKTREE_PORT: _port, ...env } = process.env;
  const named = name === null ? {} : { WORKTREE_NAME: name };
  const located = path === null ? {} : { WORKTREE_PATH: path };
  const ported = block === null ? {} : { WORKTREE_PORT: String(block[0]) };
  const run = spawnSync(script, [], {
    cwd,
    env: { ...env, ...named, ...located, ...ported, WORKTREE_PRIMARY: primary },
    stdio: ["ignore", 2, 2],
  });
  if (run.error) throw refuse("script_unrunnable", { script, detail: run.error.message });
  return exitOf(run);
}
