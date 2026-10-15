import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataDir } from "./paths";
import { type Block, blockOfUnits, type Unit } from "./ports";
import {
  blockAt,
  caseSensitiveFilesystem,
  type Fixture,
  firstFreeRun,
  firstFreeUnit,
  fixture,
  freeUnits,
  git,
  HOOKS,
  hook,
  projectAt,
  recorded,
  recording,
  refusal,
  rejection,
  removeScratchDirs,
  repo,
  requestPorts,
  SETUP_RECORD,
  TEARDOWN_RECORD,
  unitAt,
  withRemote,
} from "./repo.test-support";
import { create, init, list, prune, remove } from "./worktrees";

afterAll(removeScratchDirs);

function stateKind(f: Fixture, name: string): string | undefined {
  return list(f.project).find((item) => item.state.name === name)?.state.kind;
}

const TOUCH_TEARDOWN_RECORD = `touch "${TEARDOWN_RECORD}"`;

describe("create", () => {
  test("creates the worktree on its own branch, runs setup there, and returns the path", async () => {
    const f = fixture({ ports: 10 });
    const firstFree = await firstFreeUnit();
    const path = f.path("task-a");
    expect(await create(f.project, f.name("task-a"), f.dir)).toBe(path);
    expect(recorded(f.setupRecord)).toEqual(["task-a", path, f.dir, path]);
    expect(git(f.dir, ["branch", "--show-current"])).toBe("main");
    expect(git(path, ["branch", "--show-current"])).toBe("task-a");
    expect(list(f.project)).toEqual([
      {
        path,
        state: {
          kind: "ready",
          name: f.name("task-a"),
          worktree: { path, branch: "task-a", locked: false },
          block: blockAt(firstFree),
        },
      },
    ]);
  });

  test("a rerun returns the path without running setup again", async () => {
    const f = fixture();
    const path = await create(f.project, f.name("task-a"), f.dir);
    rmSync(f.setupRecord);
    expect(await create(f.project, f.name("task-a"), f.dir)).toBe(path);
    expect(existsSync(f.setupRecord)).toBe(false);
  });

  test("checks out an existing branch instead of creating one", async () => {
    const f = fixture();
    git(f.dir, ["branch", "task-b"]);
    git(f.dir, ["commit", "-q", "--allow-empty", "-m", "ahead"]);
    await create(f.project, f.name("task-b"), f.dir);
    expect(git(f.path("task-b"), ["rev-parse", "HEAD"])).toBe(git(f.dir, ["rev-parse", "task-b"]));
  });

  test("a failed setup keeps the worktree pending, and a rerun resumes it", async () => {
    const f = fixture({ setup: "exit 7" });
    const name = f.name("task-a");
    const failed = await rejection(() => create(f.project, name, f.dir));
    expect(failed.code).toBe("setup_failed");
    expect(failed.message).toBe(
      `${join(f.path("task-a"), HOOKS, "setup")} exited 7 in ${f.path("task-a")}; setup is pending`,
    );
    expect(failed.resolve).toBe("fix what the hook reported, then run the command again to resume");
    expect(stateKind(f, "task-a")).toBe("pending");
    expect((await rejection(() => create(f.project, name, f.dir))).code).toBe("setup_failed");
    hook(f.path("task-a"), "setup", recording(SETUP_RECORD));
    expect(await create(f.project, name, f.dir)).toBe(f.path("task-a"));
    expect(stateKind(f, "task-a")).toBe("ready");
  });

  test("a setup that commits and then fails keeps its commit on the branch", async () => {
    const f = fixture({
      setup: "printf retained > setup-result; git add setup-result; git commit -qm x; exit 7",
    });
    expect((await rejection(() => create(f.project, f.name("task-a"), f.dir))).code).toBe("setup_failed");
    expect(git(f.dir, ["show", "task-a:setup-result"])).toBe("retained");
  });

  test("a setup hook whose interpreter is missing is refused as unrunnable, and the worktree stays pending", async () => {
    const f = fixture();
    const setup = join(f.dir, HOOKS, "setup");
    rmSync(setup);
    writeFileSync(setup, "#!/nonexistent/interpreter\nexit 0\n");
    chmodSync(setup, 0o755);
    git(f.dir, ["commit", "-qam", "setup with a missing interpreter"]);
    const refused = await rejection(() => create(f.project, f.name("task-a"), f.dir));
    expect(refused.code).toBe("hook_unrunnable");
    expect(refused.resolve).toBe("fix the hook's interpreter line, then run the command again");
    expect(stateKind(f, "task-a")).toBe("pending");
  });

  test("a project without a setup hook gets a ready worktree", async () => {
    const f = fixture();
    rmSync(join(f.dir, HOOKS), { recursive: true });
    git(f.dir, ["commit", "-qam", "no hooks"]);
    expect(await create(f.project, f.name("task-a"), f.dir)).toBe(f.path("task-a"));
    expect(stateKind(f, "task-a")).toBe("ready");
  });

  test("a setup hook that is not executable leaves the worktree pending until it is fixed", async () => {
    const f = fixture();
    const name = f.name("task-a");
    const setup = join(f.path("task-a"), HOOKS, "setup");
    rmSync(join(f.dir, HOOKS, "setup"));
    writeFileSync(join(f.dir, HOOKS, "setup"), "#!/bin/sh\nexit 0\n");
    git(f.dir, ["commit", "-qam", "setup not executable"]);
    const refused = await rejection(() => create(f.project, name, f.dir));
    expect(refused.code).toBe("hook_not_executable");
    expect(refused.resolve).toBe(
      `chmod +x ${setup}, or delete it when it is not needed, then run the command again`,
    );
    expect(stateKind(f, "task-a")).toBe("pending");
    chmodSync(setup, 0o755);
    expect(await create(f.project, name, f.dir)).toBe(f.path("task-a"));
  });

  test("a file where the worktree goes is refused as unmanaged and listed, while a non-name file is hidden", async () => {
    const f = fixture();
    const path = f.path("task-e");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "not a dir");
    writeFileSync(join(dirname(path), ".DS_Store"), "");
    expect((await rejection(() => create(f.project, f.name("task-e"), f.dir))).code).toBe("unmanaged");
    expect(list(f.project)).toEqual([{ path, state: { kind: "unmanaged", name: "task-e", worktree: null } }]);
  });

  test("a registered name whose path is a file reads as unlisted everywhere", async () => {
    const f = fixture({ ports: 10 });
    const firstFree = await firstFreeUnit();
    const name = f.name("task-a");
    const path = await create(f.project, name, f.dir);
    git(f.dir, ["worktree", "remove", "--force", path]);
    writeFileSync(path, "not a dir");
    expect(list(f.project)).toEqual([{ path, state: { kind: "unlisted", name, block: blockAt(firstFree) } }]);
    expect((await rejection(() => create(f.project, name, f.dir))).code).toBe("not_a_worktree");
  });

  test("a directory the tool did not create is refused, not reused", async () => {
    const f = fixture();
    mkdirSync(f.path("task-plain"), { recursive: true });
    const refused = await rejection(() => create(f.project, f.name("task-plain"), f.dir));
    expect(refused.code).toBe("unmanaged");
    expect(refused.resolve).toBe(
      `remove it yourself, with git worktree remove ${f.path("task-plain")} when git lists it, or pick another name`,
    );
  });

  test("a branch checked out elsewhere is git's refusal, and registers nothing", async () => {
    const f = fixture();
    const refused = await rejection(() => create(f.project, f.name("main"), f.dir));
    expect(refused.code).toBe("git_refused");
    expect(refused.message).toStartWith("git worktree add");
    expect(list(f.project)).toEqual([]);
  });

  test("a worktree deleted by hand is orphaned until prune", async () => {
    const f = fixture({ ports: 10 });
    const firstFree = await firstFreeUnit();
    const name = f.name("task-a");
    const path = await create(f.project, name, f.dir);
    rmSync(path, { recursive: true });
    expect(list(f.project)).toEqual([
      {
        path,
        state: {
          kind: "orphaned",
          name,
          worktree: { path, branch: "task-a", locked: false },
          block: blockAt(firstFree),
        },
      },
    ]);
    expect((await rejection(() => create(f.project, name, f.dir))).code).toBe("orphaned");
    expect(refusal(() => remove(f.project, name, true)).code).toBe("orphaned");
  });

  test("a registered directory git does not list is refused, never set up", async () => {
    const f = fixture({ ports: 10 });
    const firstFree = await firstFreeUnit();
    const name = f.name("task-a");
    const path = await create(f.project, name, f.dir);
    git(f.dir, ["worktree", "remove", "--force", path]);
    mkdirSync(path);
    rmSync(f.setupRecord);
    const refused = await rejection(() => create(f.project, name, f.dir));
    expect(refused.code).toBe("not_a_worktree");
    expect(refused.resolve).toBe("remove the directory, then agent-worktree prune");
    expect(existsSync(f.setupRecord)).toBe(false);
    expect(refusal(() => remove(f.project, name, true)).code).toBe("not_a_worktree");
    expect(list(f.project)).toEqual([{ path, state: { kind: "unlisted", name, block: blockAt(firstFree) } }]);
  });

  test("a name differing only in case from an existing one is refused before anything is written", async () => {
    const f = fixture({ ports: 10 });
    const firstFree = await firstFreeUnit();
    const path = await create(f.project, f.name("task-a"), f.dir);
    const collided = await rejection(() => create(f.project, f.name("Task-A"), f.dir));
    expect(collided.code).toBe("case_collision");
    expect(collided.message).toBe("Task-A differs only in case from the existing task-a");
    expect(collided.resolve).toBe("use the name task-a, or pick a name that differs in more than case");
    expect(refusal(() => remove(f.project, f.name("Task-A"), true)).code).toBe("not_registered");
    expect(git(f.dir, ["branch", "--list", "Task-A"])).toBe("");
    expect(list(f.project)).toEqual([
      {
        path,
        state: {
          kind: "ready",
          name: f.name("task-a"),
          worktree: { path, branch: "task-a", locked: false },
          block: blockAt(firstFree),
        },
      },
    ]);
  });
});

describe("remove", () => {
  test.skipIf(!caseSensitiveFilesystem())(
    "removes a worktree beside a stray directory that differs only in case",
    async () => {
      const f = fixture({ ports: 10 });
      const path = await create(f.project, f.name("task-a"), f.dir);
      const stray = f.path("Task-A");
      mkdirSync(stray);
      expect(refusal(() => remove(f.project, f.name("Task-A"), true)).code).toBe("unmanaged");
      remove(f.project, f.name("task-a"), false);
      expect(existsSync(path)).toBe(false);
      expect(list(f.project)).toEqual([
        { path: stray, state: { kind: "unmanaged", name: "Task-A", worktree: null } },
      ]);
    },
  );

  test("refuses a git worktree it did not create with the act that removes it, and leaves it in place", () => {
    const f = fixture({ teardown: TOUCH_TEARDOWN_RECORD });
    const path = f.path("task-plain");
    git(f.dir, ["worktree", "add", "-q", path, "-b", "task-plain"]);
    const refused = refusal(() => remove(f.project, f.name("task-plain"), true));
    expect(refused.code).toBe("unmanaged");
    expect(refused.resolve).toBe(
      `remove it yourself, with git worktree remove ${path} when git lists it, or pick another name`,
    );
    expect(existsSync(path)).toBe(true);
    expect(existsSync(f.teardownRecord)).toBe(false);
    expect(stateKind(f, "task-plain")).toBe("unmanaged");
  });

  test("removes the worktree and keeps the branch when there is no remote", async () => {
    const f = fixture();
    const path = await create(f.project, f.name("task-a"), f.dir);
    expect(remove(f.project, f.name("task-a"), false)).toEqual({
      kind: "no_remote",
      branch: "task-a",
      remote: "origin",
    });
    expect(existsSync(path)).toBe(false);
    expect(git(f.dir, ["branch", "--list", "task-a"])).toBe("task-a");
    expect(list(f.project)).toEqual([]);
  });

  test("returns detached for a detached worktree", async () => {
    const f = fixture();
    const path = await create(f.project, f.name("task-a"), f.dir);
    git(path, ["checkout", "-q", "--detach"]);
    expect(remove(f.project, f.name("task-a"), false)).toEqual({ kind: "detached" });
  });

  test("runs the primary's teardown in the primary, with the name, before removal", async () => {
    const f = fixture();
    const path = await create(f.project, f.name("task-f"), f.dir);
    hook(
      f.dir,
      "teardown",
      `${recording(TEARDOWN_RECORD)}; [ -d "$WORKTREE_PATH" ] && echo present >> "${TEARDOWN_RECORD}"`,
    );
    hook(path, "teardown", `echo worker > "${TEARDOWN_RECORD}"; exit 1`);
    remove(f.project, f.name("task-f"), false);
    expect(recorded(f.teardownRecord)).toEqual(["task-f", path, f.dir, f.dir, "present"]);
  });

  test("keeps the entry when git refuses the removal after a clean teardown, and forces nothing", async () => {
    const f = fixture({ teardown: 'touch "$WORKTREE_PATH/left"' });
    const name = f.name("task-a");
    const path = await create(f.project, name, f.dir);
    const refused = refusal(() => remove(f.project, name, false));
    expect(refused.code).toBe("git_refused");
    expect(refused.message).toStartWith(`git worktree remove ${path} refused:`);
    expect(existsSync(join(path, "left"))).toBe(true);
    expect(stateKind(f, "task-a")).toBe("ready");
  });

  test("refuses a dirty worktree before teardown runs, and --force drops the changes", async () => {
    const f = fixture({ teardown: TOUCH_TEARDOWN_RECORD });
    const name = f.name("task-a");
    const path = await create(f.project, name, f.dir);
    writeFileSync(join(path, "scratch"), "untracked");
    const refused = refusal(() => remove(f.project, name, false));
    expect(refused.code).toBe("dirty");
    expect(refused.resolve).toBe(
      "commit or discard them, or run agent-worktree remove --force task-a to drop them",
    );
    expect(existsSync(f.teardownRecord)).toBe(false);
    expect(existsSync(path)).toBe(true);
    remove(f.project, name, true);
    expect(existsSync(f.teardownRecord)).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  test("refuses a locked worktree before teardown runs, even by force", async () => {
    const f = fixture({ teardown: TOUCH_TEARDOWN_RECORD });
    const name = f.name("task-a");
    const path = await create(f.project, name, f.dir);
    git(f.dir, ["worktree", "lock", path]);
    const refused = refusal(() => remove(f.project, name, true));
    expect(refused.code).toBe("locked");
    expect(refused.resolve).toBe(
      `run git worktree unlock ${path} when the lock's reason is over, then the command again`,
    );
    expect(existsSync(f.teardownRecord)).toBe(false);
    git(f.dir, ["worktree", "unlock", path]);
    remove(f.project, name, false);
    expect(existsSync(f.teardownRecord)).toBe(true);
  });

  test("refuses a worktree with submodules before teardown runs, and --force removes it", async () => {
    const f = fixture({ teardown: TOUCH_TEARDOWN_RECORD });
    const name = f.name("task-a");
    const path = await create(f.project, name, f.dir);
    git(path, [
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${git(path, ["rev-parse", "HEAD"])},vendored`,
    ]);
    git(path, ["commit", "-qm", "submodule"]);
    const refused = refusal(() => remove(f.project, name, false));
    expect(refused.code).toBe("submodules");
    expect(existsSync(f.teardownRecord)).toBe(false);
    remove(f.project, name, true);
    expect(existsSync(path)).toBe(false);
  });

  test("a failed teardown keeps the worktree until --force, which keeps the entry for prune", async () => {
    const f = fixture({ ports: 10, teardown: "exit 3" });
    const firstFree = await firstFreeUnit();
    const name = f.name("task-c");
    const path = await create(f.project, name, f.dir);
    const refused = refusal(() => remove(f.project, name, false));
    expect(refused.code).toBe("teardown_failed");
    expect(refused.message).toBe(
      `${join(f.dir, HOOKS, "teardown")} exited 3 for task-c; the worktree is kept`,
    );
    expect(existsSync(path)).toBe(true);
    remove(f.project, name, true);
    expect(existsSync(path)).toBe(false);
    expect(list(f.project)).toEqual([
      { path, state: { kind: "orphaned", name, worktree: null, block: blockAt(firstFree) } },
    ]);
  });

  test("a signal-killed teardown keeps the worktree", async () => {
    const f = fixture({ teardown: "kill -9 $$" });
    const name = f.name("task-d");
    const path = await create(f.project, name, f.dir);
    const refused = refusal(() => remove(f.project, name, false));
    expect(refused.code).toBe("teardown_failed");
    expect(refused.message).toBe(
      `${join(f.dir, HOOKS, "teardown")} was killed by SIGKILL for task-d; the worktree is kept`,
    );
    expect(existsSync(path)).toBe(true);
  });

  test("a teardown hook that is not executable is refused, and the worktree is kept", async () => {
    const f = fixture();
    const name = f.name("task-a");
    const path = await create(f.project, name, f.dir);
    const teardown = join(f.dir, HOOKS, "teardown");
    writeFileSync(teardown, "#!/bin/sh\nexit 0\n");
    const refused = refusal(() => remove(f.project, name, true));
    expect(refused.code).toBe("hook_not_executable");
    expect(refused.resolve).toBe(
      `chmod +x ${teardown}, or delete it when it is not needed, then run the command again`,
    );
    expect(existsSync(path)).toBe(true);
  });

  test("a teardown hook that is a dangling symlink is refused, not skipped", async () => {
    const f = fixture();
    const name = f.name("task-a");
    const path = await create(f.project, name, f.dir);
    symlinkSync(join(f.dir, "nowhere"), join(f.dir, HOOKS, "teardown"));
    expect(refusal(() => remove(f.project, name, true)).code).toBe("hook_not_executable");
    expect(existsSync(path)).toBe(true);
    expect(stateKind(f, "task-a")).toBe("ready");
  });

  test("removes without a teardown hook, ignoring one the worktree carries", async () => {
    const f = fixture();
    const path = await create(f.project, f.name("task-g"), f.dir);
    hook(path, "teardown", TOUCH_TEARDOWN_RECORD);
    remove(f.project, f.name("task-g"), false);
    expect(existsSync(f.teardownRecord)).toBe(false);
    expect(existsSync(path)).toBe(false);
  });

  test("refuses a name that is not registered", () => {
    const f = fixture();
    const refused = refusal(() => remove(f.project, f.name("no-such"), false));
    expect(refused.code).toBe("not_registered");
    expect(refused.message).toBe(`no-such is not a registered worktree at ${f.path("no-such")}`);
  });
});

function commitIn(checkout: string, file: string): string {
  writeFileSync(join(checkout, file), file);
  git(checkout, ["add", file]);
  git(checkout, ["commit", "-q", "-m", file]);
  return git(checkout, ["rev-parse", "HEAD"]);
}

function branches(f: Fixture): string {
  return git(f.dir, ["for-each-ref", "--format=%(refname:short)", "refs/heads/task-*"]);
}

describe("the branch of a removed worktree", () => {
  test("is deleted here and on the remote once it landed", async () => {
    const f = fixture();
    const bare = withRemote(f.dir, "origin");
    const path = await create(f.project, f.name("task-a"), f.dir);
    commitIn(path, "work");
    git(path, ["push", "-q", "-u", "origin", "task-a"]);
    git(path, ["push", "-q", "origin", "task-a:main"]);
    expect(remove(f.project, f.name("task-a"), false)).toEqual({
      kind: "deleted",
      branch: "task-a",
      landing: "merged",
      into: "refs/remotes/origin/main",
      upstream: "refs/remotes/origin/task-a",
    });
    expect(branches(f)).toBe("");
    expect(git(bare, ["for-each-ref", "--format=%(refname)", "refs/heads"])).toBe("refs/heads/main");
  });

  test("is kept when it has not landed, even by force", async () => {
    const f = fixture();
    withRemote(f.dir, "origin");
    const path = await create(f.project, f.name("task-a"), f.dir);
    commitIn(path, "work");
    writeFileSync(join(path, "scratch"), "untracked");
    expect(remove(f.project, f.name("task-a"), true)).toEqual({
      kind: "unmerged",
      branch: "task-a",
      into: "refs/remotes/origin/main",
    });
    expect(branches(f)).toBe("task-a");
  });

  test("is settled by prune for a worktree deleted by hand", async () => {
    const f = fixture();
    withRemote(f.dir, "origin");
    const merged = await create(f.project, f.name("task-a"), f.dir);
    const unmerged = await create(f.project, f.name("task-b"), f.dir);
    commitIn(unmerged, "work");
    rmSync(merged, { recursive: true });
    rmSync(unmerged, { recursive: true });
    prune(f.project, f.dir);
    expect(branches(f)).toBe("task-b");
    expect(list(f.project)).toEqual([]);
  });
});

describe("prune", () => {
  test("does nothing in a repo with nothing to prune", () => {
    const f = fixture();
    prune(f.project, f.dir);
    expect(list(f.project)).toEqual([]);
  });

  test("tears down a worktree deleted by hand, after which the name can be created again", async () => {
    const f = fixture({ teardown: recording(TEARDOWN_RECORD) });
    const name = f.name("task-a");
    const path = await create(f.project, name, f.dir);
    rmSync(path, { recursive: true });
    prune(f.project, f.dir);
    expect(recorded(f.teardownRecord)).toEqual(["task-a", path, f.dir, f.dir]);
    expect(list(f.project)).toEqual([]);
    expect(git(f.dir, ["worktree", "list", "--porcelain"])).not.toContain(path);
    expect(await create(f.project, name, f.dir)).toBe(path);
  });

  test("tears down only the orphan, leaving a ready worktree beside it ready", async () => {
    const f = fixture({ teardown: recording(TEARDOWN_RECORD) });
    await create(f.project, f.name("task-a"), f.dir);
    const orphan = await create(f.project, f.name("task-b"), f.dir);
    rmSync(orphan, { recursive: true });
    prune(f.project, f.dir);
    expect(recorded(f.teardownRecord)).toEqual(["task-b", orphan, f.dir, f.dir]);
    expect(list(f.project).map((item) => [item.state.name, item.state.kind])).toEqual([["task-a", "ready"]]);
  });

  test("keeps every entry whose teardown fails, refuses with their names, and converges once it passes", async () => {
    const f = fixture({ teardown: "exit 3" });
    for (const name of ["task-c", "task-d"]) {
      await create(f.project, f.name(name), f.dir);
      remove(f.project, f.name(name), true);
    }
    const refused = refusal(() => prune(f.project, f.dir));
    expect(refused.code).toBe("removals_failed");
    expect(refused.message).toBe(
      `could not remove task-c (${join(f.dir, HOOKS, "teardown")} exited 3), task-d (${join(f.dir, HOOKS, "teardown")} exited 3), which stay registered`,
    );
    expect(refused.resolve).toBe("fix what each cause names, then run agent-worktree prune again");
    expect(stateKind(f, "task-c")).toBe("orphaned");
    expect(stateKind(f, "task-d")).toBe("orphaned");
    hook(f.dir, "teardown", "exit 0");
    prune(f.project, f.dir);
    expect(list(f.project)).toEqual([]);
  });
});

function land(path: string, branch: string): void {
  commitIn(path, `${branch}-work`);
  git(path, ["pull", "-q", "--no-rebase", "--no-edit", "origin", "main"]);
  git(path, ["push", "-q", "-u", "origin", branch]);
  git(path, ["push", "-q", "origin", `${branch}:main`]);
}

describe("prune of a worktree whose branch landed", () => {
  test("tears it down, removes it, and deletes its branch here and on the remote", async () => {
    const f = fixture({ teardown: recording(TEARDOWN_RECORD) });
    const bare = withRemote(f.dir, "origin");
    const path = await create(f.project, f.name("task-a"), f.dir);
    land(path, "task-a");
    prune(f.project, f.dir);
    expect(recorded(f.teardownRecord)).toEqual(["task-a", path, f.dir, f.dir]);
    expect(list(f.project)).toEqual([]);
    expect(existsSync(path)).toBe(false);
    expect(branches(f)).toBe("");
    expect(git(bare, ["for-each-ref", "--format=%(refname)", "refs/heads"])).toBe("refs/heads/main");
  });

  test("keeps one never pushed, one dirty, one unmerged, one locked and the one prune runs in", async () => {
    const f = fixture({ teardown: TOUCH_TEARDOWN_RECORD });
    withRemote(f.dir, "origin");
    const fresh = await create(f.project, f.name("task-a"), f.dir);
    const dirty = await create(f.project, f.name("task-b"), f.dir);
    land(dirty, "task-b");
    writeFileSync(join(dirty, "scratch"), "untracked");
    const unmerged = await create(f.project, f.name("task-c"), f.dir);
    commitIn(unmerged, "work");
    git(unmerged, ["push", "-q", "-u", "origin", "task-c"]);
    const locked = await create(f.project, f.name("task-d"), f.dir);
    land(locked, "task-d");
    git(f.dir, ["worktree", "lock", locked]);
    const here = await create(f.project, f.name("task-e"), f.dir);
    land(here, "task-e");
    prune(f.project, here);
    expect(existsSync(f.teardownRecord)).toBe(false);
    expect(list(f.project).map((item) => [item.state.name, item.state.kind])).toEqual([
      ["task-a", "ready"],
      ["task-b", "ready"],
      ["task-c", "ready"],
      ["task-d", "ready"],
      ["task-e", "ready"],
    ]);
    expect([fresh, dirty, unmerged, locked, here].every((path) => existsSync(path))).toBe(true);
  });

  test("keeps one git refuses to remove after its teardown, refusing with why, and removes the next", async () => {
    const f = fixture({ teardown: '[ "$WORKTREE_NAME" = task-a ] && touch "$WORKTREE_PATH/left"; exit 0' });
    withRemote(f.dir, "origin");
    const refusedPath = await create(f.project, f.name("task-a"), f.dir);
    land(refusedPath, "task-a");
    const removedPath = await create(f.project, f.name("task-b"), f.dir);
    land(removedPath, "task-b");
    const refused = refusal(() => prune(f.project, f.dir));
    expect(refused.code).toBe("removals_failed");
    expect(refused.message).toStartWith(
      `could not remove task-a (git worktree remove ${refusedPath} refused: `,
    );
    expect(stateKind(f, "task-a")).toBe("ready");
    expect(existsSync(join(refusedPath, "left"))).toBe(true);
    expect(existsSync(removedPath)).toBe(false);
    expect(branches(f)).toBe("task-a");
  });

  test("keeps one whose teardown fails, refusing with its name", async () => {
    const f = fixture({ teardown: "exit 3" });
    withRemote(f.dir, "origin");
    const path = await create(f.project, f.name("task-a"), f.dir);
    land(path, "task-a");
    const refused = refusal(() => prune(f.project, f.dir));
    expect(refused.code).toBe("removals_failed");
    expect(refused.message).toBe(
      `could not remove task-a (${join(f.dir, HOOKS, "teardown")} exited 3), which stay registered`,
    );
    expect(stateKind(f, "task-a")).toBe("ready");
    expect(branches(f)).toBe("task-a");
  });
});

describe("list", () => {
  test("sorts registered and unmanaged directories together by name", async () => {
    const f = fixture();
    await create(f.project, f.name("task-z"), f.dir);
    mkdirSync(f.path("task-b"));
    mkdirSync(join(dirname(f.path("task-b")), "user+feature"));
    expect(list(f.project).map((item) => [item.state.name, item.state.kind])).toEqual([
      ["task-b", "unmanaged"],
      ["task-z", "ready"],
      ["user+feature", "unmanaged"],
    ]);
  });

  test("reads a registration where releases named agent-worktrees wrote it, so the rename orphans none", () => {
    const f = fixture();
    git(f.dir, ["worktree", "add", "-q", f.path("task-a"), "-b", "task-a"]);
    mkdirSync(join(f.dir, ".git", "agent-worktrees", "task-a"), { recursive: true });
    writeFileSync(join(f.dir, ".git", "agent-worktrees", "task-a", "ready"), "");
    expect(stateKind(f, "task-a")).toBe("ready");
  });
});

describe("init", () => {
  test("runs setup in the primary with no worktree name", async () => {
    const f = fixture();
    await init(f.project, f.dir);
    expect(recorded(f.setupRecord)).toEqual(["unset", f.dir, f.dir, f.dir]);
    expect(list(f.project)).toEqual([]);
  });

  test("runs setup in a pending task worktree and marks it ready", async () => {
    const f = fixture({ setup: "exit 7" });
    const name = f.name("task-a");
    const path = f.path("task-a");
    expect((await rejection(() => create(f.project, name, f.dir))).code).toBe("setup_failed");
    hook(path, "setup", recording(SETUP_RECORD));
    await init(f.project, path);
    expect(recorded(f.setupRecord)).toEqual(["task-a", path, f.dir, path]);
    expect(stateKind(f, "task-a")).toBe("ready");
  });

  test("refuses a worktree the tool does not manage, wherever it is", async () => {
    const f = fixture();
    const other = join(dirname(f.dir), "other");
    git(f.dir, ["worktree", "add", "-q", other, "-b", "other"]);
    const elsewhere = await rejection(() => init(f.project, other));
    expect(elsewhere.code).toBe("not_a_managed_checkout");
    expect(elsewhere.message).toBe(`${other} is neither the primary checkout nor a registered task worktree`);
    const unmanaged = f.path("task-plain");
    git(f.dir, ["worktree", "add", "-q", unmanaged, "-b", "task-plain"]);
    expect((await rejection(() => init(f.project, unmanaged))).code).toBe("not_a_managed_checkout");
  });

  test("reports a failed setup", async () => {
    const f = fixture({ setup: "exit 2" });
    expect((await rejection(() => init(f.project, f.dir))).message).toBe(
      `${join(f.dir, HOOKS, "setup")} exited 2 in ${f.dir}; setup is pending`,
    );
  });
});

describe("a worktree in the earlier location", () => {
  function legacy(f: Fixture, raw: string): string {
    const path = join(f.dir, ".claude", "worktrees", raw);
    git(f.dir, ["worktree", "add", "-q", path, "-b", raw]);
    mkdirSync(join(f.dir, ".git", "agent-worktrees", raw), { recursive: true });
    writeFileSync(join(f.dir, ".git", "agent-worktrees", raw, "ready"), "");
    return path;
  }

  test("is listed where it is", () => {
    const f = fixture();
    const old = legacy(f, "task-a");
    expect(list(f.project)).toEqual([
      {
        path: old,
        state: {
          kind: "legacy",
          name: f.name("task-a"),
          worktree: { path: old, branch: "task-a", locked: false },
          block: null,
        },
      },
    ]);
  });

  test("refuses create, init and remove, naming how to keep it and how to drop it", async () => {
    const f = fixture();
    const old = legacy(f, "task-a");
    const refused = await rejection(() => create(f.project, f.name("task-a"), f.dir));
    expect(refused.code).toBe("legacy_location");
    expect(refused.message).toBe(
      `task-a is at ${old}, inside the primary checkout, where agent-worktree no longer keeps worktrees`,
    );
    expect(refused.resolve).toBe(
      `keep it with mkdir -p ${dirname(f.path("task-a"))} && git worktree move ${old} ${f.path("task-a")}, then agent-worktree init in ${f.path("task-a")}; or drop it with git worktree remove ${old}, then agent-worktree prune`,
    );
    expect((await rejection(() => init(f.project, old))).code).toBe("legacy_location");
    expect(refusal(() => remove(f.project, f.name("task-a"), false)).code).toBe("legacy_location");
    expect(refusal(() => remove(f.project, f.name("task-a"), true)).code).toBe("legacy_location");
    expect(existsSync(old)).toBe(true);
  });

  test("is left registered by prune, with no teardown", () => {
    const f = fixture({ teardown: TOUCH_TEARDOWN_RECORD });
    legacy(f, "task-a");
    prune(f.project, f.dir);
    expect(stateKind(f, "task-a")).toBe("legacy");
    expect(existsSync(f.teardownRecord)).toBe(false);
  });

  test("reads ready where it belongs once moved there and set up again", async () => {
    const f = fixture();
    const old = legacy(f, "task-a");
    mkdirSync(dirname(f.path("task-a")), { recursive: true });
    git(f.dir, ["worktree", "move", old, f.path("task-a")]);
    await init(f.project, f.path("task-a"));
    expect(recorded(f.setupRecord)).toEqual(["task-a", f.path("task-a"), f.dir, f.path("task-a")]);
    expect(list(f.project).map((item) => [item.path, item.state.kind])).toEqual([
      [f.path("task-a"), "ready"],
    ]);
  });

  test("is torn down with no path and unregistered by prune once git removed it", () => {
    const f = fixture({ teardown: recording(TEARDOWN_RECORD) });
    const old = legacy(f, "task-a");
    git(f.dir, ["worktree", "remove", old]);
    process.env.WORKTREE_PATH = "/inherited";
    try {
      prune(f.project, f.dir);
    } finally {
      delete process.env.WORKTREE_PATH;
    }
    expect(recorded(f.teardownRecord)).toEqual(["task-a", "unset", f.dir, f.dir]);
    expect(list(f.project)).toEqual([]);
  });

  test("is torn down where git last listed it once its directory was deleted", () => {
    const f = fixture({ teardown: recording(TEARDOWN_RECORD) });
    const old = legacy(f, "task-a");
    rmSync(old, { recursive: true });
    prune(f.project, f.dir);
    expect(recorded(f.teardownRecord)).toEqual(["task-a", old, f.dir, f.dir]);
    expect(list(f.project)).toEqual([]);
  });

  test("is not one agent-worktree registered when the directory is not", () => {
    const f = fixture({ teardown: TOUCH_TEARDOWN_RECORD });
    const stray = join(f.dir, ".claude", "worktrees", "task-a");
    git(f.dir, ["worktree", "add", "-q", stray, "-b", "task-a"]);
    prune(f.project, f.dir);
    expect(list(f.project)).toEqual([]);
    expect(existsSync(stray)).toBe(true);
    expect(existsSync(f.teardownRecord)).toBe(false);
  });
});

const PORT_RECORD = `printf '%s\\n' "\${WORKTREE_PORT-unset}" >> "$WORKTREE_PRIMARY/../port-record"`;

function portRecord(f: Fixture): readonly string[] {
  const path = join(dirname(f.dir), "port-record");
  return existsSync(path) ? recorded(path) : [];
}

function blockOf(f: Fixture, name: string): Block | null | undefined {
  const state = list(f.project).find((item) => item.state.name === name)?.state;
  if (state === undefined) return undefined;
  return state.kind === "unmanaged" ? null : state.block;
}

function firstUnitOf(f: Fixture, name: string): Unit | null | undefined {
  const block = blockOf(f, name);
  return block === undefined || block === null ? block : block[0];
}

function claimsDir(): string {
  return join(dataDir(), "ports");
}

async function holding<T>(ports: readonly number[], run: () => Promise<T>): Promise<T> {
  const held = ports.flatMap((port) => {
    try {
      return [Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } })];
    } catch {
      return [];
    }
  });
  try {
    return await run();
  } finally {
    for (const listener of held) listener.stop(true);
  }
}

describe("port blocks", () => {
  test("each worktree gets the lowest free block, and its hooks get its first port", async () => {
    const f = fixture({ ports: 10, setup: PORT_RECORD, teardown: PORT_RECORD });
    const [first, second] = await freeUnits();
    await create(f.project, f.name("task-a"), f.dir);
    await create(f.project, f.name("task-b"), f.dir);
    expect(firstUnitOf(f, "task-a")).toBe(first);
    expect(firstUnitOf(f, "task-b")).toBe(second);
    expect(portRecord(f)).toEqual([String(first), String(second)]);
    remove(f.project, f.name("task-a"), false);
    expect(portRecord(f)).toEqual([String(first), String(second), String(first)]);
    await create(f.project, f.name("task-c"), f.dir);
    expect(firstUnitOf(f, "task-c")).toBe(first);
  });

  test("the primary gets no block and no inherited port", async () => {
    const f = fixture({ ports: 10, setup: PORT_RECORD });
    process.env.WORKTREE_PORT = "1";
    try {
      await init(f.project, f.dir);
    } finally {
      delete process.env.WORKTREE_PORT;
    }
    expect(portRecord(f)).toEqual(["unset"]);
  });

  test("a block with a port another program listens on is skipped", async () => {
    const f = fixture({ ports: 10 });
    const [first, second] = await freeUnits();
    if (first === undefined) throw new Error("no free block");
    await holding([first + 9], () => create(f.project, f.name("task-a"), f.dir));
    expect(firstUnitOf(f, "task-a")).toBe(second);
  });

  test("a block another project holds is skipped, and prune frees it once that project is gone", async () => {
    const f = fixture({ ports: 10 });
    const [first, second] = await freeUnits();
    const other = projectAt(repo());
    requestPorts(other.primary, "10\n");
    await create(other, f.name("task-a"), other.primary);
    await create(f.project, f.name("task-a"), f.dir);
    expect(firstUnitOf(f, "task-a")).toBe(second);
    rmSync(dirname(other.primary), { recursive: true, force: true });
    prune(f.project, f.dir);
    await create(f.project, f.name("task-b"), f.dir);
    expect(firstUnitOf(f, "task-b")).toBe(first);
  });

  test("with no free block create refuses, keeps setup pending, and resumes once one is freed", async () => {
    const f = fixture({ ports: 10, setup: PORT_RECORD });
    const free = await freeUnits();
    const refused = await holding(free, () => rejection(() => create(f.project, f.name("task-a"), f.dir)));
    expect(refused.code).toBe("no_free_ports");
    expect(refused.message).toBe(
      "no block of 10 ports from 24000 to 24999 is free for task-a: worktrees hold some and other programs listen on the rest; setup is pending",
    );
    expect(refused.resolve).toBe(
      "remove a worktree you are done with, fix a teardown that failed for a worktree that is gone, or run agent-worktree prune in another clone whose gone worktrees hold blocks, then run the command again",
    );
    expect(stateKind(f, "task-a")).toBe("pending");
    expect(portRecord(f)).toEqual([]);
    await create(f.project, f.name("task-a"), f.dir);
    expect(stateKind(f, "task-a")).toBe("ready");
    expect(portRecord(f)).toEqual([String(free[0])]);
  });

  test("with no free block create first prunes a worktree whose branch landed and takes its block", async () => {
    const f = fixture({ ports: 10, setup: PORT_RECORD, teardown: TOUCH_TEARDOWN_RECORD });
    withRemote(f.dir, "origin");
    const free = await freeUnits();
    const landed = await create(f.project, f.name("task-a"), f.dir);
    land(landed, "task-a");
    await holding(free.slice(1), () => create(f.project, f.name("task-b"), f.dir));
    expect(existsSync(f.teardownRecord)).toBe(true);
    expect(existsSync(landed)).toBe(false);
    expect(list(f.project).map((item) => item.state.name)).toEqual(["task-b"]);
    expect(firstUnitOf(f, "task-b")).toBe(free[0]);
  });

  test("with no free block create never removes the worktree it sets up, even when its branch landed", async () => {
    const f = fixture({ ports: 10, setup: PORT_RECORD });
    withRemote(f.dir, "origin");
    const free = await freeUnits();
    const path = f.path("task-a");
    git(f.dir, ["worktree", "add", "-q", "-b", "task-a", join(f.dir, "..", "staging")]);
    land(join(f.dir, "..", "staging"), "task-a");
    git(f.dir, ["worktree", "remove", join(f.dir, "..", "staging")]);
    const refused = await holding(free, () => rejection(() => create(f.project, f.name("task-a"), f.dir)));
    expect(refused.code).toBe("no_free_ports");
    expect(existsSync(path)).toBe(true);
    expect(stateKind(f, "task-a")).toBe("pending");
  });

  test("init gives a registered worktree with no block one", async () => {
    const f = fixture({ ports: 10, setup: PORT_RECORD });
    const firstFree = await firstFreeUnit();
    const path = f.path("task-a");
    git(f.dir, ["worktree", "add", "-q", path, "-b", "task-a"]);
    mkdirSync(join(f.dir, ".git", "agent-worktrees", "task-a"), { recursive: true });
    writeFileSync(join(f.dir, ".git", "agent-worktrees", "task-a", "ready"), "");
    expect(firstUnitOf(f, "task-a")).toBeNull();
    await init(f.project, path);
    expect(firstUnitOf(f, "task-a")).toBe(firstFree);
    expect(portRecord(f)).toEqual([String(firstFree)]);
  });

  test("create takes over the block of a worktree whose directory is gone, tearing it down as prune would", async () => {
    const f = fixture({ ports: 10, teardown: PORT_RECORD });
    const firstFree = await firstFreeUnit();
    const gone = await create(f.project, f.name("task-a"), f.dir);
    rmSync(gone, { recursive: true, force: true });
    await create(f.project, f.name("task-b"), f.dir);
    expect(portRecord(f)).toEqual([String(firstFree)]);
    expect(list(f.project).map((item) => [item.state.name, item.state.kind])).toEqual([["task-b", "ready"]]);
    expect(firstUnitOf(f, "task-b")).toBe(firstFree);
  });

  test("create takes over the block of a deleted clone without a prune", async () => {
    const f = fixture({ ports: 10 });
    const firstFree = await firstFreeUnit();
    const other = projectAt(repo());
    requestPorts(other.primary, "10\n");
    await create(other, f.name("task-a"), other.primary);
    rmSync(dirname(other.primary), { recursive: true, force: true });
    await create(f.project, f.name("task-a"), f.dir);
    expect(firstUnitOf(f, "task-a")).toBe(firstFree);
  });

  test("create leaves the block of a gone worktree whose teardown fails, and takes the next", async () => {
    const f = fixture({ ports: 10, teardown: "exit 3" });
    const [first, second] = await freeUnits();
    const gone = await create(f.project, f.name("task-a"), f.dir);
    rmSync(gone, { recursive: true, force: true });
    await create(f.project, f.name("task-b"), f.dir);
    expect(stateKind(f, "task-a")).toBe("orphaned");
    expect(firstUnitOf(f, "task-a")).toBe(first);
    expect(firstUnitOf(f, "task-b")).toBe(second);
  });

  test("create keeps the blocks of worktrees that are still there", async () => {
    const f = fixture({ ports: 10, teardown: PORT_RECORD });
    const [first, second] = await freeUnits();
    await create(f.project, f.name("task-a"), f.dir);
    await create(f.project, f.name("task-b"), f.dir);
    expect(portRecord(f)).toEqual([]);
    expect([firstUnitOf(f, "task-a"), firstUnitOf(f, "task-b")]).toEqual([first, second]);
  });

  test("a worktree forced out past a failed teardown keeps its block until prune tears it down", async () => {
    const f = fixture({ ports: 10, teardown: "exit 3" });
    const firstFree = await firstFreeUnit();
    const name = f.name("task-a");
    const path = await create(f.project, name, f.dir);
    remove(f.project, name, true);
    expect(firstUnitOf(f, "task-a")).toBe(firstFree);
    hook(f.dir, "teardown", PORT_RECORD);
    prune(f.project, f.dir);
    expect(portRecord(f)).toEqual([String(firstFree)]);
    expect(existsSync(path)).toBe(false);
    await create(f.project, f.name("task-b"), f.dir);
    expect(firstUnitOf(f, "task-b")).toBe(firstFree);
  });
});

describe("port requests", () => {
  test("a project that asks for no ports gets no block, even with every unit in use", async () => {
    const f = fixture({ setup: PORT_RECORD });
    const free = await freeUnits();
    await holding(free, () => create(f.project, f.name("task-a"), f.dir));
    expect(stateKind(f, "task-a")).toBe("ready");
    expect(blockOf(f, "task-a")).toBeNull();
    expect(portRecord(f)).toEqual(["unset"]);
  });

  test("a project that asks for 20 ports gets two consecutive free units", async () => {
    const f = fixture({ setup: PORT_RECORD, ports: 20 });
    const first = await firstFreeRun(2);
    await create(f.project, f.name("task-a"), f.dir);
    expect(blockOf(f, "task-a")).toEqual(blockAt(first, 2));
    expect(portRecord(f)).toEqual([String(first)]);
  });

  test("a run skips past a unit another program listens on to the lowest run after it", async () => {
    const f = fixture({ ports: 20 });
    const first = await firstFreeRun(4);
    await holding([first + 15], () => create(f.project, f.name("task-a"), f.dir));
    expect(blockOf(f, "task-a")).toEqual(blockAt(unitAt(first, 2), 2));
  });

  test("creates started at once each get a run of their own, and leave no unit unaccounted for", async () => {
    const f = fixture({ ports: 20 });
    const names = ["task-a", "task-b", "task-c", "task-d", "task-e", "task-f"];
    await Promise.all(names.map((name) => create(f.project, f.name(name), f.dir)));
    const blocks = names.map((name) => blockOf(f, name));
    for (const block of blocks) expect(block === null || block === undefined ? 0 : block.length).toBe(2);
    const held = blocks.flatMap((block) => block ?? []);
    expect(new Set(held).size).toBe(names.length * 2);
    expect(readdirSync(claimsDir()).filter((entry) => !entry.startsWith("."))).toHaveLength(names.length * 2);
  });

  test("inits of one worktree started at once agree on one block", async () => {
    const f = fixture({ ports: 10, setup: PORT_RECORD });
    const path = await create(f.project, f.name("task-a"), f.dir);
    requestPorts(path, "30\n");
    await Promise.all([init(f.project, path), init(f.project, path)]);
    const block = blockOf(f, "task-a");
    expect(block?.length).toBe(3);
    const [, second, third] = portRecord(f);
    expect([second, third]).toEqual([String(block?.[0]), String(block?.[0])]);
  });

  test("creates started at once take over a deleted clone's run of three, and both get one", async () => {
    const f = fixture({ ports: 10 });
    const first = await firstFreeRun(3);
    const other = projectAt(repo());
    requestPorts(other.primary, "30\n");
    await create(other, f.name("task-a"), other.primary);
    expect(blockOf({ ...f, project: other }, "task-a")).toEqual(blockAt(first, 3));
    rmSync(dirname(other.primary), { recursive: true, force: true });
    await Promise.all([
      create(f.project, f.name("task-a"), f.dir),
      create(f.project, f.name("task-b"), f.dir),
    ]);
    const firsts = [firstUnitOf(f, "task-a"), firstUnitOf(f, "task-b")].sort();
    expect(firsts).toEqual([first, unitAt(first, 1)]);
  });

  test("prune frees a gone holder's units that are not one run, noting each run", async () => {
    const f = fixture({ ports: 30 });
    const first = await firstFreeRun(3);
    const other = projectAt(repo());
    requestPorts(other.primary, "30\n");
    await create(other, f.name("task-a"), other.primary);
    rmSync(join(claimsDir(), String(unitAt(first, 1))));
    expect(blockOf({ ...f, project: other }, "task-a")).toEqual(blockOfUnits([first, unitAt(first, 2)]));
    rmSync(dirname(other.primary), { recursive: true, force: true });
    prune(f.project, f.dir);
    await create(f.project, f.name("task-a"), f.dir);
    expect(blockOf(f, "task-a")).toEqual(blockAt(first, 3));
  });

  test("init mends a block whose units are no longer one run", async () => {
    const f = fixture({ ports: 30 });
    const first = await firstFreeRun(3);
    const path = await create(f.project, f.name("task-a"), f.dir);
    rmSync(join(claimsDir(), String(unitAt(first, 1))));
    expect(blockOf(f, "task-a")).toEqual(blockOfUnits([first, unitAt(first, 2)]));
    await init(f.project, path);
    expect(blockOf(f, "task-a")).toEqual(blockAt(first, 3));
  });

  test("a request that cannot be read as a file is refused and claims nothing", async () => {
    const f = fixture({ setup: PORT_RECORD });
    mkdirSync(join(f.dir, HOOKS, "ports", "x"), { recursive: true });
    writeFileSync(join(f.dir, HOOKS, "ports", "x", "keep"), "");
    git(f.dir, ["add", HOOKS]);
    git(f.dir, ["commit", "-q", "-m", "ports dir"]);
    const refused = await rejection(() => create(f.project, f.name("task-a"), f.dir));
    const file = join(f.path("task-a"), HOOKS, "ports");
    expect(refused.code).toBe("invalid_ports");
    expect(refused.message).toBe(
      `${file} must hold one whole number of ports from 1 to 1000, and cannot be read as a file`,
    );
    expect(stateKind(f, "task-a")).toBe("pending");
    expect(blockOf(f, "task-a")).toBeNull();
    expect(portRecord(f)).toEqual([]);
  });

  test.each(["0\n", "-1\n", "ten\n", "10 20\n", "1001\n", "", "\n10\n"])(
    "a request of %p is refused and claims nothing",
    async (text) => {
      const f = fixture({ setup: PORT_RECORD });
      requestPorts(f.dir, text);
      const refused = await rejection(() => create(f.project, f.name("task-a"), f.dir));
      const file = join(f.path("task-a"), HOOKS, "ports");
      expect(refused.code).toBe("invalid_ports");
      expect(refused.message).toBe(
        `${file} must hold one whole number of ports from 1 to 1000, and holds: ${JSON.stringify(text)}`,
      );
      expect(refused.resolve).toBe(
        `run agent-worktree install --ports <n> in ${f.path("task-a")} with the number of ports the worktree needs, or delete ${file} when it needs none, then run the command again`,
      );
      expect(stateKind(f, "task-a")).toBe("pending");
      expect(blockOf(f, "task-a")).toBeNull();
      expect(portRecord(f)).toEqual([]);
    },
  );

  test("init gives back the block of a worktree whose project no longer asks for ports, and resizes a changed request", async () => {
    const f = fixture({ ports: 10 });
    const first = await firstFreeUnit();
    const path = await create(f.project, f.name("task-a"), f.dir);
    expect(blockOf(f, "task-a")).toEqual(blockAt(first));
    requestPorts(path, "20\n");
    await init(f.project, path);
    expect(blockOf(f, "task-a")?.length).toBe(2);
    rmSync(join(path, HOOKS, "ports"));
    await init(f.project, path);
    expect(blockOf(f, "task-a")).toBeNull();
  });
});
