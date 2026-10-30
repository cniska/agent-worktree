import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { doctor, type Check } from "./doctor";
import { blockOf } from "./ledger";
import { blockText } from "./ports";
import {
  blockAt,
  firstFreeUnit,
  fixture,
  git,
  HOOKS,
  hook,
  rejection,
  removeScratchDirs,
  scratchDir,
} from "./repo.test-support";
import { create } from "./worktrees";

afterAll(removeScratchDirs);

function binWith(programs: readonly string[]): string {
  const bin = scratchDir();
  for (const program of programs) {
    writeFileSync(join(bin, program), "#!/bin/sh\n");
    chmodSync(join(bin, program), 0o755);
  }
  return bin;
}

function failing(checks: readonly Check[]): readonly Check[] {
  return checks.filter((check) => check.state !== "ok");
}

function named(checks: readonly Check[], name: string): Check | undefined {
  return checks.find((check) => check.name === name);
}

const RERUN = "then run agent-worktree doctor again";

describe("doctor", () => {
  test("passes every check in a project whose hooks and worktrees are sound", async () => {
    const f = fixture({ ports: 10 });
    const bin = binWith(["git", "agent-worktree"]);
    const first = await firstFreeUnit();
    await create(f.project, f.name("task-a"), { here: f.dir, from: null });
    const checks = doctor({ cwd: f.dir, searchPath: [bin] });
    expect(checks).toEqual([
      { name: "git", state: "ok", detail: `found at ${join(bin, "git")}`, fix: null },
      { name: "agent-worktree", state: "ok", detail: `found at ${join(bin, "agent-worktree")}`, fix: null },
      {
        name: "port blocks",
        state: "ok",
        detail: "no port block is held by a worktree that is gone",
        fix: null,
      },
      { name: "project", state: "ok", detail: `${f.dir} is a checkout of ${f.dir}`, fix: null },
      {
        name: "setup hook",
        state: "ok",
        detail: `${join(f.dir, HOOKS, "setup")} runs in each checkout it sets up`,
        fix: null,
      },
      {
        name: "teardown hook",
        state: "ok",
        detail: `none in ${f.dir}: worktrees get no teardown`,
        fix: null,
      },
      { name: "ports hook", state: "ok", detail: "each worktree asks for 10 ports", fix: null },
      { name: "task-a worktree", state: "ok", detail: `ready at ${f.path("task-a")}`, fix: null },
      {
        name: "task-a ports",
        state: "ok",
        detail: `holds port block ${blockText(blockAt(first))} for the 10 ports its project asks for`,
        fix: null,
      },
    ]);
  });

  test("fails without git, warns without agent-worktree, and leaves the project unchecked", () => {
    const f = fixture();
    const bin = binWith([]);
    mkdirSync(join(bin, "git"));
    mkdirSync(join(bin, "agent-worktree"));
    expect(doctor({ cwd: f.dir, searchPath: [bin] })).toEqual([
      {
        name: "git",
        state: "fail",
        detail: `not found in ${bin}; every agent-worktree command runs git`,
        fix: `install git and put it on PATH, ${RERUN}`,
      },
      {
        name: "agent-worktree",
        state: "warn",
        detail: `not found in ${bin}; the plugin's WorktreeCreate and WorktreeRemove hooks run agent-worktree hook, so without it every Claude Code worktree fails to create`,
        fix: `install agent-worktree on the PATH Claude Code starts with, ${RERUN} under that PATH`,
      },
      {
        name: "port blocks",
        state: "ok",
        detail: "no port block is held by a worktree that is gone",
        fix: null,
      },
      {
        name: "project",
        state: "warn",
        detail: "unchecked: git is not on PATH",
        fix: `put git on PATH, ${RERUN}`,
      },
    ]);
    expect(named(doctor({ cwd: f.dir, searchPath: [] }), "git")?.detail).toBe(
      "PATH names no directory; every agent-worktree command runs git",
    );
  });

  test("outside a checkout, warns that no project check ran", () => {
    const outside = scratchDir();
    const checks = doctor({ cwd: outside, searchPath: [binWith(["git", "agent-worktree"])] });
    expect(failing(checks)).toEqual([
      {
        name: "project",
        state: "warn",
        detail: `${outside} is not inside a git checkout, so no project check ran`,
        fix: "run agent-worktree doctor in the project's checkout to check its hooks and worktrees",
      },
    ]);
  });

  test("fails a setup hook that is not executable and a ports hook that holds no count", () => {
    const f = fixture();
    const setup = join(f.dir, HOOKS, "setup");
    rmSync(setup);
    writeFileSync(setup, "#!/bin/sh\nexit 0\n");
    writeFileSync(join(f.dir, HOOKS, "ports"), "ten\n");
    git(f.dir, ["add", HOOKS]);
    git(f.dir, ["commit", "-qm", "broken hooks"]);
    expect(failing(doctor({ cwd: f.dir, searchPath: [binWith(["git", "agent-worktree"])] }))).toEqual([
      {
        name: "setup hook",
        state: "fail",
        detail: `${setup} exists but is not executable`,
        fix: `chmod +x ${setup}, or delete it when it is not needed, then run the command again`,
      },
      {
        name: "ports hook",
        state: "fail",
        detail: `${join(f.dir, HOOKS, "ports")} must hold one whole number of ports from 1 to 1000, and holds: "ten\\n"`,
        fix: `run agent-worktree install --ports <n> in ${f.dir} with the number of ports the worktree needs, or delete ${join(f.dir, HOOKS, "ports")} when it needs none, then run the command again`,
      },
    ]);
  });

  test("warns of a pending, an orphaned and an unmanaged worktree, each with its fix", async () => {
    const f = fixture();
    await create(f.project, f.name("task-b"), { here: f.dir, from: null });
    rmSync(f.path("task-b"), { recursive: true });
    hook(f.dir, "setup", "exit 1");
    expect(
      (await rejection(() => create(f.project, f.name("task-a"), { here: f.dir, from: null }))).code,
    ).toBe("setup_failed");
    mkdirSync(f.path("task-c"));
    const checks = failing(doctor({ cwd: f.dir, searchPath: [binWith(["git", "agent-worktree"])] }));
    expect(checks).toEqual([
      {
        name: "task-a worktree",
        state: "warn",
        detail: `its setup has not finished at ${f.path("task-a")}`,
        fix: `run agent-worktree create task-a to resume its setup, ${RERUN}`,
      },
      {
        name: "task-b worktree",
        state: "warn",
        detail: "task-b is registered but its worktree is gone, so its teardown never ran",
        fix: "run agent-worktree prune, then the command again",
      },
      {
        name: "task-c worktree",
        state: "warn",
        detail: `${f.path("task-c")} exists but agent-worktree did not create it`,
        fix: `remove it yourself, with git worktree remove ${f.path("task-c")} when git lists it, or pick another name`,
      },
    ]);
  });

  test("warns of a block that no longer fits the request and of one held by a gone entry", async () => {
    const f = fixture({ ports: 10 });
    const first = await firstFreeUnit();
    const path = await create(f.project, f.name("task-a"), { here: f.dir, from: null });
    writeFileSync(join(path, HOOKS, "ports"), "20\n");
    const gone = await create(f.project, f.name("task-b"), { here: f.dir, from: null });
    const goneBlock = blockOf(f.project, f.name("task-b"));
    const entry = join(f.dir, ".git", "agent-worktrees", "task-b");
    rmSync(entry, { recursive: true });
    git(f.dir, ["worktree", "remove", "--force", gone]);
    const checks = failing(doctor({ cwd: f.dir, searchPath: [binWith(["git", "agent-worktree"])] }));
    if (goneBlock === null) throw new Error("task-b holds no block");
    expect(checks).toEqual([
      {
        name: "port blocks",
        state: "warn",
        detail: `${blockText(goneBlock)} is held by ${entry}, which is gone`,
        fix: `run agent-worktree prune in any project's checkout, which frees every such block, ${RERUN}`,
      },
      {
        name: "task-a ports",
        state: "warn",
        detail: `holds port block ${blockText(blockAt(first))}, which is not one run of the 20 ports its project asks for`,
        fix: `run agent-worktree init in ${path}, ${RERUN}`,
      },
    ]);
  });
});
