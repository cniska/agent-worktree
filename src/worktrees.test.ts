import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Block, blocks, isBound } from "./ports";
import {
  caseSensitiveFilesystem,
  type Fixture,
  fixture,
  git,
  projectAt,
  recorded,
  recording,
  refusal,
  removeScratchDirs,
  repo,
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
        block: f.firstFreeBlock,
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
    expect(list(f.project)).toEqual([
      { path, state: { kind: "unmanaged", name: "task-e", worktree: null }, block: null },
    ]);
  });

  test("a registered name whose path is a file reads as unlisted everywhere", () => {
    const f = fixture();
    const name = f.name("task-a");
    const path = create(f.project, name);
    git(f.dir, ["worktree", "remove", "--force", path]);
    writeFileSync(path, "not a dir");
    expect(list(f.project)).toEqual([{ path, state: { kind: "unlisted", name }, block: f.firstFreeBlock }]);
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
      {
        path,
        state: { kind: "orphaned", name, worktree: { path, branch: "task-a", locked: false } },
        block: f.firstFreeBlock,
      },
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
    expect(refused.resolve).toBe("remove the directory, then agent-worktree prune");
    expect(existsSync(f.setupRecord)).toBe(false);
    expect(refusal(() => remove(f.project, name, true)).code).toBe("not_a_worktree");
    expect(list(f.project)).toEqual([{ path, state: { kind: "unlisted", name }, block: f.firstFreeBlock }]);
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
        block: f.firstFreeBlock,
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
        { path: stray, state: { kind: "unmanaged", name: "Task-A", worktree: null }, block: null },
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
      "commit or discard them, or run agent-worktree remove --force task-a to drop them",
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
    expect(list(f.project)).toEqual([
      { path, state: { kind: "orphaned", name, worktree: null }, block: f.firstFreeBlock },
    ]);
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
    expect(refused.resolve).toBe("fix what the script reported, then run agent-worktree prune again");
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

  test("reads a registration where releases named agent-worktrees wrote it, so the rename orphans none", () => {
    const f = fixture();
    git(f.dir, ["worktree", "add", "-q", f.path("task-a"), "-b", "task-a"]);
    mkdirSync(join(f.dir, ".git", "agent-worktrees", "task-a"), { recursive: true });
    writeFileSync(join(f.dir, ".git", "agent-worktrees", "task-a", "ready"), "");
    expect(stateKind(f, "task-a")).toBe("ready");
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
        },
        block: null,
      },
    ]);
  });

  test("refuses create, init and remove, naming how to keep it and how to drop it", () => {
    const f = fixture();
    const old = legacy(f, "task-a");
    const refused = refusal(() => create(f.project, f.name("task-a")));
    expect(refused.code).toBe("legacy_location");
    expect(refused.message).toBe(
      `task-a is at ${old}, inside the primary checkout, where agent-worktree no longer keeps worktrees`,
    );
    expect(refused.resolve).toBe(
      `keep it with mkdir -p ${dirname(f.path("task-a"))} && git worktree move ${old} ${f.path("task-a")}, then agent-worktree init in ${f.path("task-a")}; or drop it with git worktree remove ${old}, then agent-worktree prune`,
    );
    expect(refusal(() => init(f.project, old)).code).toBe("legacy_location");
    expect(refusal(() => remove(f.project, f.name("task-a"), false)).code).toBe("legacy_location");
    expect(refusal(() => remove(f.project, f.name("task-a"), true)).code).toBe("legacy_location");
    expect(existsSync(old)).toBe(true);
  });

  test("is left registered by prune, with no teardown", () => {
    const f = fixture({ teardown: TOUCH_TEARDOWN_RECORD });
    legacy(f, "task-a");
    prune(f.project);
    expect(stateKind(f, "task-a")).toBe("legacy");
    expect(existsSync(f.teardownRecord)).toBe(false);
  });

  test("reads ready where it belongs once moved there and set up again", () => {
    const f = fixture();
    const old = legacy(f, "task-a");
    mkdirSync(dirname(f.path("task-a")), { recursive: true });
    git(f.dir, ["worktree", "move", old, f.path("task-a")]);
    init(f.project, f.path("task-a"));
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
      prune(f.project);
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
    prune(f.project);
    expect(recorded(f.teardownRecord)).toEqual(["task-a", old, f.dir, f.dir]);
    expect(list(f.project)).toEqual([]);
  });

  test("is not one agent-worktree registered when the directory is not", () => {
    const f = fixture({ teardown: TOUCH_TEARDOWN_RECORD });
    const stray = join(f.dir, ".claude", "worktrees", "task-a");
    git(f.dir, ["worktree", "add", "-q", stray, "-b", "task-a"]);
    prune(f.project);
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
  return list(f.project).find((item) => item.state.name === name)?.block;
}

function freeBlocks(): readonly Block[] {
  return blocks().filter((block) => !isBound(block));
}

function holding<T>(ports: readonly number[], run: () => T): T {
  const held = ports.flatMap((port) => {
    try {
      return [Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } })];
    } catch {
      return [];
    }
  });
  try {
    return run();
  } finally {
    for (const listener of held) listener.stop(true);
  }
}

describe("port blocks", () => {
  test("each worktree gets the lowest free block, and its scripts get its first port", () => {
    const f = fixture({ setup: PORT_RECORD, teardown: PORT_RECORD });
    const [first, second] = freeBlocks();
    create(f.project, f.name("task-a"));
    create(f.project, f.name("task-b"));
    expect(blockOf(f, "task-a")).toBe(first);
    expect(blockOf(f, "task-b")).toBe(second);
    expect(portRecord(f)).toEqual([String(first), String(second)]);
    remove(f.project, f.name("task-a"), false);
    expect(portRecord(f)).toEqual([String(first), String(second), String(first)]);
    create(f.project, f.name("task-c"));
    expect(blockOf(f, "task-c")).toBe(first);
  });

  test("the primary gets no block and no inherited port", () => {
    const f = fixture({ setup: PORT_RECORD });
    process.env.WORKTREE_PORT = "1";
    try {
      init(f.project, f.dir);
    } finally {
      delete process.env.WORKTREE_PORT;
    }
    expect(portRecord(f)).toEqual(["unset"]);
  });

  test("a block with a port bound by another program is skipped", () => {
    const f = fixture();
    const [first, second] = freeBlocks();
    if (first === undefined) throw new Error("no free block");
    holding([first + 9], () => create(f.project, f.name("task-a")));
    expect(blockOf(f, "task-a")).toBe(second);
  });

  test("a block another project holds is skipped, and prune frees it once that project is gone", () => {
    const f = fixture();
    const [first, second] = freeBlocks();
    const other = projectAt(repo());
    create(other, f.name("task-a"));
    create(f.project, f.name("task-a"));
    expect(blockOf(f, "task-a")).toBe(second);
    rmSync(dirname(other.primary), { recursive: true, force: true });
    prune(f.project);
    create(f.project, f.name("task-b"));
    expect(blockOf(f, "task-b")).toBe(first);
  });

  test("with no free block create refuses, keeps setup pending, and resumes once one is freed", () => {
    const f = fixture({ setup: PORT_RECORD });
    const free = freeBlocks();
    const refused = holding(free, () => refusal(() => create(f.project, f.name("task-a"))));
    expect(refused.code).toBe("no_free_ports");
    expect(refused.message).toBe(
      "no port block from 24000 to 24999 is free for task-a: worktrees hold some and other programs bind the rest; setup is pending",
    );
    expect(refused.resolve).toBe(
      "remove a worktree you are done with, or run agent-worktree prune to free the blocks of worktrees that are gone, then run the command again",
    );
    expect(stateKind(f, "task-a")).toBe("pending");
    expect(portRecord(f)).toEqual([]);
    create(f.project, f.name("task-a"));
    expect(stateKind(f, "task-a")).toBe("ready");
    expect(portRecord(f)).toEqual([String(free[0])]);
  });

  test("init gives a registered worktree with no block one", () => {
    const f = fixture({ setup: PORT_RECORD });
    const path = f.path("task-a");
    git(f.dir, ["worktree", "add", "-q", path, "-b", "task-a"]);
    mkdirSync(join(f.dir, ".git", "agent-worktrees", "task-a"), { recursive: true });
    writeFileSync(join(f.dir, ".git", "agent-worktrees", "task-a", "ready"), "");
    expect(blockOf(f, "task-a")).toBeNull();
    init(f.project, path);
    expect(blockOf(f, "task-a")).toBe(f.firstFreeBlock);
    expect(portRecord(f)).toEqual([String(f.firstFreeBlock)]);
  });

  test("a worktree forced out past a failed teardown keeps its block until prune tears it down", () => {
    const f = fixture({ teardown: "exit 3" });
    const name = f.name("task-a");
    const path = create(f.project, name);
    remove(f.project, name, true);
    expect(blockOf(f, "task-a")).toBe(f.firstFreeBlock);
    script(f.dir, "worktree-teardown.sh", PORT_RECORD);
    prune(f.project);
    expect(portRecord(f)).toEqual([String(f.firstFreeBlock)]);
    expect(existsSync(path)).toBe(false);
    create(f.project, f.name("task-b"));
    expect(blockOf(f, "task-b")).toBe(f.firstFreeBlock);
  });
});
