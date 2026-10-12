import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  caseSensitiveFilesystem,
  type Fixture,
  fixture,
  git,
  recorded,
  recording,
  refusal,
  removeScratchDirs,
  SETUP_RECORD,
  script,
  TEARDOWN_RECORD,
} from "./repo.test-support";
import { create, init, list, prune, remove } from "./worktrees";

afterAll(removeScratchDirs);

function stateKind(f: Fixture, name: string): string | undefined {
  return list(f.project).find((item) => item.state.name === name)?.state.kind;
}

const TOUCH_TEARDOWN_RECORD = `touch "${TEARDOWN_RECORD}"`;

describe("create", () => {
  test("creates the worktree on its own branch, runs setup there, and returns the path", () => {
    const f = fixture();
    const path = f.path("task-a");
    expect(create(f.project, f.name("task-a"))).toBe(path);
    expect(recorded(f.setupRecord)).toEqual(["task-a", path, f.dir, path]);
    expect(git(f.dir, ["branch", "--show-current"])).toBe("main");
    expect(git(path, ["branch", "--show-current"])).toBe("task-a");
    expect(list(f.project)).toEqual([
      {
        path,
        state: { kind: "ready", name: f.name("task-a"), worktree: { path, branch: "task-a", locked: false } },
      },
    ]);
  });

  test("a rerun returns the path without running setup again", () => {
    const f = fixture();
    const path = create(f.project, f.name("task-a"));
    rmSync(f.setupRecord);
    expect(create(f.project, f.name("task-a"))).toBe(path);
    expect(existsSync(f.setupRecord)).toBe(false);
  });

  test("checks out an existing branch instead of creating one", () => {
    const f = fixture();
    git(f.dir, ["branch", "task-b"]);
    git(f.dir, ["commit", "-q", "--allow-empty", "-m", "ahead"]);
    create(f.project, f.name("task-b"));
    expect(git(f.path("task-b"), ["rev-parse", "HEAD"])).toBe(git(f.dir, ["rev-parse", "task-b"]));
  });

  test("a failed setup keeps the worktree pending, and a rerun resumes it", () => {
    const f = fixture({ setup: "exit 7" });
    const name = f.name("task-a");
    const failed = refusal(() => create(f.project, name));
    expect(failed.code).toBe("setup_failed");
    expect(failed.message).toBe(
      `scripts/worktree-setup.sh exited 7 in ${f.path("task-a")}; setup is pending`,
    );
    expect(failed.resolve).toBe("fix what the script reported, then run the command again to resume");
    expect(stateKind(f, "task-a")).toBe("pending");
    expect(refusal(() => create(f.project, name)).code).toBe("setup_failed");
    script(f.path("task-a"), "worktree-setup.sh", recording(SETUP_RECORD));
    expect(create(f.project, name)).toBe(f.path("task-a"));
    expect(stateKind(f, "task-a")).toBe("ready");
  });

  test("a setup that commits and then fails keeps its commit on the branch", () => {
    const f = fixture({
      setup: "printf retained > setup-result; git add setup-result; git commit -qm x; exit 7",
    });
    expect(refusal(() => create(f.project, f.name("task-a"))).code).toBe("setup_failed");
    expect(git(f.dir, ["show", "task-a:setup-result"])).toBe("retained");
  });

  test("a setup script whose interpreter is missing is refused as unrunnable, and the worktree stays pending", () => {
    const f = fixture();
    const setup = join(f.dir, "scripts", "worktree-setup.sh");
    rmSync(setup);
    writeFileSync(setup, "#!/nonexistent/interpreter\nexit 0\n");
    chmodSync(setup, 0o755);
    git(f.dir, ["commit", "-qam", "setup with a missing interpreter"]);
    const refused = refusal(() => create(f.project, f.name("task-a")));
    expect(refused.code).toBe("script_unrunnable");
    expect(refused.resolve).toBe("fix the script's interpreter line, then run the command again");
    expect(stateKind(f, "task-a")).toBe("pending");
  });

  test("a project without a setup script gets a ready worktree", () => {
    const f = fixture();
    rmSync(join(f.dir, "scripts"), { recursive: true });
    git(f.dir, ["commit", "-qam", "no scripts"]);
    expect(create(f.project, f.name("task-a"))).toBe(f.path("task-a"));
    expect(stateKind(f, "task-a")).toBe("ready");
  });

  test("a setup script that is not executable leaves the worktree pending until it is fixed", () => {
    const f = fixture();
    const name = f.name("task-a");
    const setup = join(f.path("task-a"), "scripts", "worktree-setup.sh");
    rmSync(join(f.dir, "scripts", "worktree-setup.sh"));
    writeFileSync(join(f.dir, "scripts", "worktree-setup.sh"), "#!/bin/sh\nexit 0\n");
    git(f.dir, ["commit", "-qam", "setup not executable"]);
    const refused = refusal(() => create(f.project, name));
    expect(refused.code).toBe("script_not_executable");
    expect(refused.resolve).toBe(
      `chmod +x ${setup}, or delete it when it is not needed, then run the command again`,
    );
    expect(stateKind(f, "task-a")).toBe("pending");
    chmodSync(setup, 0o755);
    expect(create(f.project, name)).toBe(f.path("task-a"));
  });

  test("a file where the worktree goes is refused as unmanaged and listed, while a non-name file is hidden", () => {
    const f = fixture();
    const path = f.path("task-e");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "not a dir");
    writeFileSync(join(dirname(path), ".DS_Store"), "");
    expect(refusal(() => create(f.project, f.name("task-e"))).code).toBe("unmanaged");
    expect(list(f.project)).toEqual([{ path, state: { kind: "unmanaged", name: "task-e", worktree: null } }]);
  });

  test("a registered name whose path is a file reads as unlisted everywhere", () => {
    const f = fixture();
    const name = f.name("task-a");
    const path = create(f.project, name);
    git(f.dir, ["worktree", "remove", "--force", path]);
    writeFileSync(path, "not a dir");
    expect(list(f.project)).toEqual([{ path, state: { kind: "unlisted", name } }]);
    expect(refusal(() => create(f.project, name)).code).toBe("not_a_worktree");
  });

  test("a directory the tool did not create is refused, not reused", () => {
    const f = fixture();
    mkdirSync(f.path("task-plain"), { recursive: true });
    const refused = refusal(() => create(f.project, f.name("task-plain")));
    expect(refused.code).toBe("unmanaged");
    expect(refused.resolve).toBe(
      `remove it yourself, with git worktree remove ${f.path("task-plain")} when git lists it, or pick another name`,
    );
  });

  test("a branch checked out elsewhere is git's refusal, and registers nothing", () => {
    const f = fixture();
    const refused = refusal(() => create(f.project, f.name("main")));
    expect(refused.code).toBe("git_refused");
    expect(refused.message).toStartWith("git worktree add");
    expect(list(f.project)).toEqual([]);
  });

  test("a worktree deleted by hand is orphaned until prune", () => {
    const f = fixture();
    const name = f.name("task-a");
    const path = create(f.project, name);
    rmSync(path, { recursive: true });
    expect(list(f.project)).toEqual([
      { path, state: { kind: "orphaned", name, worktree: { path, branch: "task-a", locked: false } } },
    ]);
    expect(refusal(() => create(f.project, name)).code).toBe("orphaned");
    expect(refusal(() => remove(f.project, name, true)).code).toBe("orphaned");
  });

  test("a registered directory git does not list is refused, never set up", () => {
    const f = fixture();
    const name = f.name("task-a");
    const path = create(f.project, name);
    git(f.dir, ["worktree", "remove", "--force", path]);
    mkdirSync(path);
    rmSync(f.setupRecord);
    const refused = refusal(() => create(f.project, name));
    expect(refused.code).toBe("not_a_worktree");
    expect(refused.resolve).toBe("remove the directory, then agent-worktrees prune");
    expect(existsSync(f.setupRecord)).toBe(false);
    expect(refusal(() => remove(f.project, name, true)).code).toBe("not_a_worktree");
    expect(list(f.project)).toEqual([{ path, state: { kind: "unlisted", name } }]);
  });

  test("a name differing only in case from an existing one is refused before anything is written", () => {
    const f = fixture();
    const path = create(f.project, f.name("task-a"));
    const collided = refusal(() => create(f.project, f.name("Task-A")));
    expect(collided.code).toBe("case_collision");
    expect(collided.message).toBe("Task-A differs only in case from the existing task-a");
    expect(collided.resolve).toBe("use the name task-a, or pick a name that differs in more than case");
    expect(refusal(() => remove(f.project, f.name("Task-A"), true)).code).toBe("not_registered");
    expect(git(f.dir, ["branch", "--list", "Task-A"])).toBe("");
    expect(list(f.project)).toEqual([
      {
        path,
        state: { kind: "ready", name: f.name("task-a"), worktree: { path, branch: "task-a", locked: false } },
      },
    ]);
  });
});

describe("remove", () => {
  test.skipIf(!caseSensitiveFilesystem())(
    "removes a worktree beside a stray directory that differs only in case",
    () => {
      const f = fixture();
      const path = create(f.project, f.name("task-a"));
      const stray = f.path("Task-A");
      mkdirSync(stray);
      expect(refusal(() => remove(f.project, f.name("Task-A"), true)).code).toBe("unmanaged");
      expect(remove(f.project, f.name("task-a"), false).path).toBe(path);
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

  test("removes the worktree, keeps the branch, and returns the worktree it had", () => {
    const f = fixture();
    const path = create(f.project, f.name("task-a"));
    expect(remove(f.project, f.name("task-a"), false)).toEqual({ path, branch: "task-a", locked: false });
    expect(existsSync(path)).toBe(false);
    expect(git(f.dir, ["branch", "--list", "task-a"])).toBe("task-a");
    expect(list(f.project)).toEqual([]);
  });

  test("returns a null branch for a detached worktree", () => {
    const f = fixture();
    const path = create(f.project, f.name("task-a"));
    git(path, ["checkout", "-q", "--detach"]);
    expect(remove(f.project, f.name("task-a"), false).branch).toBeNull();
  });

  test("runs the primary's teardown in the primary, with the name, before removal", () => {
    const f = fixture();
    const path = create(f.project, f.name("task-f"));
    script(
      f.dir,
      "worktree-teardown.sh",
      `${recording(TEARDOWN_RECORD)}; [ -d "$WORKTREE_PATH" ] && echo present >> "${TEARDOWN_RECORD}"`,
    );
    script(path, "worktree-teardown.sh", `echo worker > "${TEARDOWN_RECORD}"; exit 1`);
    remove(f.project, f.name("task-f"), false);
    expect(recorded(f.teardownRecord)).toEqual(["task-f", path, f.dir, f.dir, "present"]);
  });

  test("keeps the entry when git refuses the removal after a clean teardown, and forces nothing", () => {
    const f = fixture({ teardown: 'touch "$WORKTREE_PATH/left"' });
    const name = f.name("task-a");
    const path = create(f.project, name);
    const refused = refusal(() => remove(f.project, name, false));
    expect(refused.code).toBe("git_refused");
    expect(refused.message).toStartWith(`git worktree remove ${path} refused:`);
    expect(existsSync(join(path, "left"))).toBe(true);
    expect(stateKind(f, "task-a")).toBe("ready");
  });

  test("refuses a dirty worktree before teardown runs, and --force drops the changes", () => {
    const f = fixture({ teardown: TOUCH_TEARDOWN_RECORD });
    const name = f.name("task-a");
    const path = create(f.project, name);
    writeFileSync(join(path, "scratch"), "untracked");
    const refused = refusal(() => remove(f.project, name, false));
    expect(refused.code).toBe("dirty");
    expect(refused.resolve).toBe(
      "commit or discard them, or run agent-worktrees remove --force task-a to drop them",
    );
    expect(existsSync(f.teardownRecord)).toBe(false);
    expect(existsSync(path)).toBe(true);
    remove(f.project, name, true);
    expect(existsSync(f.teardownRecord)).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  test("refuses a locked worktree before teardown runs, even by force", () => {
    const f = fixture({ teardown: TOUCH_TEARDOWN_RECORD });
    const name = f.name("task-a");
    const path = create(f.project, name);
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

  test("refuses a worktree with submodules before teardown runs, and --force removes it", () => {
    const f = fixture({ teardown: TOUCH_TEARDOWN_RECORD });
    const name = f.name("task-a");
    const path = create(f.project, name);
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

  test("a failed teardown keeps the worktree until --force, which keeps the entry for prune", () => {
    const f = fixture({ teardown: "exit 3" });
    const name = f.name("task-c");
    const path = create(f.project, name);
    const refused = refusal(() => remove(f.project, name, false));
    expect(refused.code).toBe("teardown_failed");
    expect(refused.message).toBe("scripts/worktree-teardown.sh exited 3 for task-c; the worktree is kept");
    expect(existsSync(path)).toBe(true);
    remove(f.project, name, true);
    expect(existsSync(path)).toBe(false);
    expect(list(f.project)).toEqual([{ path, state: { kind: "orphaned", name, worktree: null } }]);
  });

  test("a signal-killed teardown keeps the worktree", () => {
    const f = fixture({ teardown: "kill -9 $$" });
    const name = f.name("task-d");
    const path = create(f.project, name);
    const refused = refusal(() => remove(f.project, name, false));
    expect(refused.code).toBe("teardown_failed");
    expect(refused.message).toBe(
      "scripts/worktree-teardown.sh was killed by SIGKILL for task-d; the worktree is kept",
    );
    expect(existsSync(path)).toBe(true);
  });

  test("a teardown script that is not executable is refused, and the worktree is kept", () => {
    const f = fixture();
    const name = f.name("task-a");
    const path = create(f.project, name);
    const teardown = join(f.dir, "scripts", "worktree-teardown.sh");
    writeFileSync(teardown, "#!/bin/sh\nexit 0\n");
    const refused = refusal(() => remove(f.project, name, true));
    expect(refused.code).toBe("script_not_executable");
    expect(refused.resolve).toBe(
      `chmod +x ${teardown}, or delete it when it is not needed, then run the command again`,
    );
    expect(existsSync(path)).toBe(true);
  });

  test("a teardown script that is a dangling symlink is refused, not skipped", () => {
    const f = fixture();
    const name = f.name("task-a");
    const path = create(f.project, name);
    symlinkSync(join(f.dir, "nowhere"), join(f.dir, "scripts", "worktree-teardown.sh"));
    expect(refusal(() => remove(f.project, name, true)).code).toBe("script_not_executable");
    expect(existsSync(path)).toBe(true);
    expect(stateKind(f, "task-a")).toBe("ready");
  });

  test("removes without a teardown script, ignoring one the worktree carries", () => {
    const f = fixture();
    const path = create(f.project, f.name("task-g"));
    script(path, "worktree-teardown.sh", TOUCH_TEARDOWN_RECORD);
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

describe("prune", () => {
  test("does nothing in a repo with nothing to prune", () => {
    const f = fixture();
    prune(f.project);
    expect(list(f.project)).toEqual([]);
  });

  test("tears down a worktree deleted by hand, after which the name can be created again", () => {
    const f = fixture({ teardown: recording(TEARDOWN_RECORD) });
    const name = f.name("task-a");
    const path = create(f.project, name);
    rmSync(path, { recursive: true });
    prune(f.project);
    expect(recorded(f.teardownRecord)).toEqual(["task-a", path, f.dir, f.dir]);
    expect(list(f.project)).toEqual([]);
    expect(git(f.dir, ["worktree", "list", "--porcelain"])).not.toContain(path);
    expect(create(f.project, name)).toBe(path);
  });

  test("tears down only the orphan, leaving a ready worktree beside it ready", () => {
    const f = fixture({ teardown: recording(TEARDOWN_RECORD) });
    create(f.project, f.name("task-a"));
    const orphan = create(f.project, f.name("task-b"));
    rmSync(orphan, { recursive: true });
    prune(f.project);
    expect(recorded(f.teardownRecord)).toEqual(["task-b", orphan, f.dir, f.dir]);
    expect(list(f.project).map((item) => [item.state.name, item.state.kind])).toEqual([["task-a", "ready"]]);
  });

  test("keeps every entry whose teardown fails, refuses with their names, and converges once it passes", () => {
    const f = fixture({ teardown: "exit 3" });
    for (const name of ["task-c", "task-d"]) {
      create(f.project, f.name(name));
      remove(f.project, f.name(name), true);
    }
    const refused = refusal(() => prune(f.project));
    expect(refused.code).toBe("teardowns_failed");
    expect(refused.message).toBe(
      "scripts/worktree-teardown.sh failed for task-c, task-d, which stay registered",
    );
    expect(refused.resolve).toBe("fix what the script reported, then run agent-worktrees prune again");
    expect(stateKind(f, "task-c")).toBe("orphaned");
    expect(stateKind(f, "task-d")).toBe("orphaned");
    script(f.dir, "worktree-teardown.sh", "exit 0");
    prune(f.project);
    expect(list(f.project)).toEqual([]);
  });
});

describe("list", () => {
  test("sorts registered and unmanaged directories together by name", () => {
    const f = fixture();
    create(f.project, f.name("task-z"));
    mkdirSync(f.path("task-b"));
    mkdirSync(join(dirname(f.path("task-b")), "user+feature"));
    expect(list(f.project).map((item) => [item.state.name, item.state.kind])).toEqual([
      ["task-b", "unmanaged"],
      ["task-z", "ready"],
      ["user+feature", "unmanaged"],
    ]);
  });
});

describe("init", () => {
  test("runs setup in the primary with no worktree name", () => {
    const f = fixture();
    init(f.project, f.dir);
    expect(recorded(f.setupRecord)).toEqual(["unset", f.dir, f.dir, f.dir]);
    expect(list(f.project)).toEqual([]);
  });

  test("runs setup in a pending task worktree and marks it ready", () => {
    const f = fixture({ setup: "exit 7" });
    const name = f.name("task-a");
    const path = f.path("task-a");
    expect(refusal(() => create(f.project, name)).code).toBe("setup_failed");
    script(path, "worktree-setup.sh", recording(SETUP_RECORD));
    init(f.project, path);
    expect(recorded(f.setupRecord)).toEqual(["task-a", path, f.dir, path]);
    expect(stateKind(f, "task-a")).toBe("ready");
  });

  test("refuses a worktree the tool does not manage, wherever it is", () => {
    const f = fixture();
    const other = join(dirname(f.dir), "other");
    git(f.dir, ["worktree", "add", "-q", other, "-b", "other"]);
    const elsewhere = refusal(() => init(f.project, other));
    expect(elsewhere.code).toBe("not_a_managed_checkout");
    expect(elsewhere.message).toBe(`${other} is neither the primary checkout nor a registered task worktree`);
    const unmanaged = f.path("task-plain");
    git(f.dir, ["worktree", "add", "-q", unmanaged, "-b", "task-plain"]);
    expect(refusal(() => init(f.project, unmanaged)).code).toBe("not_a_managed_checkout");
  });

  test("reports a failed setup", () => {
    const f = fixture({ setup: "exit 2" });
    expect(refusal(() => init(f.project, f.dir)).message).toBe(
      `scripts/worktree-setup.sh exited 2 in ${f.dir}; setup is pending`,
    );
  });
});
