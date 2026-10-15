import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { version } from "../package.json";
import { compiledBinary, project, removeScratch, runOnPath, succeeded, toolsOnly, world } from "./harness";

afterEach(removeScratch);

const BUILD_TIMEOUT_MS = 60_000;

test(
  "AC-48 the release binary, alone on PATH with git, prints its version, then creates and removes a worktree",
  () => {
    const w = world();
    const p = project(w);
    const binary = compiledBinary(join(w.root, "build"));
    const alone = `${dirname(binary)}:${toolsOnly(w, ["git"])}`;

    expect(runOnPath(w, w.root, alone, ["--version"])).toEqual({
      exitCode: 0,
      stdout: `${version}\n`,
      stderr: "",
    });
    expect(succeeded(runOnPath(w, p.dir, alone, ["create", "task-a"]))).toEqual([p.path("task-a")]);
    expect(existsSync(p.path("task-a"))).toBe(true);
    expect(succeeded(runOnPath(w, p.dir, alone, ["remove", "task-a"]))).toEqual([
      "branch task-a kept, no remote origin",
    ]);
    expect(existsSync(p.path("task-a"))).toBe(false);
  },
  BUILD_TIMEOUT_MS,
);
