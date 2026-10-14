import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export type Env = Readonly<Record<string, string | undefined>>;

const DATA_NAME = "agent-worktree";

function homeDir(env: Env): string {
  const home = env.HOME;
  return home !== undefined && home.trim() !== "" ? home : homedir();
}

function xdgBase(env: Env, variable: string, fallback: readonly string[]): string {
  const value = env[variable];
  return value !== undefined && isAbsolute(value) ? value : join(homeDir(env), ...fallback);
}

export function dataDir(env: Env = process.env): string {
  return join(xdgBase(env, "XDG_DATA_HOME", [".local", "share"]), DATA_NAME);
}
