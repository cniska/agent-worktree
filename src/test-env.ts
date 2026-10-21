import { afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GIT_KEY_PREFIX = "GIT_";

export function isolateGit(env: NodeJS.ProcessEnv): void {
  for (const name of Object.keys(env)) if (name.startsWith(GIT_KEY_PREFIX)) delete env[name];
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_AUTHOR_NAME = "T";
  env.GIT_AUTHOR_EMAIL = "t@example.com";
  env.GIT_COMMITTER_NAME = "T";
  env.GIT_COMMITTER_EMAIL = "t@example.com";
}

isolateGit(process.env);

const scratchHome = realpathSync(mkdtempSync(join(tmpdir(), "agent-worktree-home-")));

const SCRATCH_DIRS = {
  HOME: "home",
  XDG_CONFIG_HOME: "config",
  XDG_DATA_HOME: "data",
  XDG_STATE_HOME: "state",
} as const;

type ScratchVariable = keyof typeof SCRATCH_DIRS;

export const ownerEnv: Readonly<Record<ScratchVariable, string | undefined>> = {
  HOME: process.env.HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  XDG_STATE_HOME: process.env.XDG_STATE_HOME,
};

for (const [variable, dir] of Object.entries(SCRATCH_DIRS)) {
  const path = join(scratchHome, dir);
  mkdirSync(path);
  process.env[variable] = path;
}

afterAll(() => rmSync(scratchHome, { recursive: true, force: true }));
