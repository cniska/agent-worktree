import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";

type Env = Readonly<Record<string, string | undefined>>;

const DATA_NAME = "agent-worktree";

function homeDir(env: Env): string {
  const home = env.HOME;
  return home !== undefined && home.trim() !== "" ? home : homedir();
}

export function dataDir(env: Env = process.env): string {
  const base = env.XDG_DATA_HOME;
  if (base !== undefined && isAbsolute(base)) return join(base, DATA_NAME);
  return join(homeDir(env), ".local", "share", DATA_NAME);
}

export function resolvedPath(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(path);
  return parent === path ? path : join(resolvedPath(parent), basename(path));
}
