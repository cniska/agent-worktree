import { spawnSync } from "node:child_process";
import { accessSync, constants, lstatSync } from "node:fs";
import { join } from "node:path";
import { refuser } from "./coded-error";
import { type Exit, exitOf } from "./exit";
import { note } from "./log";
import type { WorktreeName } from "./project";

export const SETUP = "scripts/worktree-setup.sh";
export const TEARDOWN = "scripts/worktree-teardown.sh";

type ScriptEnv = {
  readonly name: WorktreeName | null;
  readonly path: string | null;
  readonly primary: string;
};

const refuse = refuser<{
  readonly script_not_executable: { readonly script: string };
  readonly script_unrunnable: { readonly script: string; readonly detail: string };
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
});

const NOT_EXECUTABLE = new Set(["EACCES", "ENOENT", "ENOTDIR", "ELOOP"]);

function isAccessRefusal(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    NOT_EXECUTABLE.has(error.code)
  );
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

export function runScript(script: string, cwd: string, { name, path, primary }: ScriptEnv): Exit {
  note(`running ${script} in ${cwd}`);
  const { WORKTREE_NAME: _name, WORKTREE_PATH: _path, ...env } = process.env;
  const named = name === null ? {} : { WORKTREE_NAME: name };
  const located = path === null ? {} : { WORKTREE_PATH: path };
  const run = spawnSync(script, [], {
    cwd,
    env: { ...env, ...named, ...located, WORKTREE_PRIMARY: primary },
    stdio: ["ignore", 2, 2],
  });
  if (run.error) throw refuse("script_unrunnable", { script, detail: run.error.message });
  return exitOf(run);
}
