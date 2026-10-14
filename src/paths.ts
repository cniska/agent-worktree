import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

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
