import { afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const INHERITED_GIT_STATE = [
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_WORK_TREE",
  "GIT_PREFIX",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_AUTHOR_DATE",
  "GIT_COMMITTER_DATE",
];

for (const name of INHERITED_GIT_STATE) delete process.env[name];

process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_AUTHOR_NAME = "T";
process.env.GIT_AUTHOR_EMAIL = "t@example.com";
process.env.GIT_COMMITTER_NAME = "T";
process.env.GIT_COMMITTER_EMAIL = "t@example.com";

const scratchHome = realpathSync(mkdtempSync(join(tmpdir(), "agent-worktree-home-")));

const SCRATCH_DIRS = {
  HOME: "home",
  XDG_CONFIG_HOME: "config",
  XDG_DATA_HOME: "data",
  XDG_STATE_HOME: "state",
} as const;

for (const [variable, dir] of Object.entries(SCRATCH_DIRS)) {
  const path = join(scratchHome, dir);
  mkdirSync(path);
  process.env[variable] = path;
}

afterAll(() => rmSync(scratchHome, { recursive: true, force: true }));
