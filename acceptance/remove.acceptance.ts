import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  bareRemote,
  commitIn,
  git,
  HOOKS,
  installHook,
  ls,
  project,
  recorded,
  recording,
  refused,
  removeScratch,
  run,
  succeeded,
  world,
} from "./harness";

afterEach(removeScratch);

test("AC-10 remove tears down in the primary, removes the worktree and keeps a branch no remote tracks", () => {
  const w = world();
  const p = project(w);
  const record = join(w.root, "teardown-record");
  installHook(w, p.dir, "teardown", recording(record));
  const path = p.path("task-a");
  succeeded(run(w, p.dir, ["create", "task-a"]));
  expect(succeeded(run(w, p.dir, ["remove", "task-a"]))).toEqual(["branch task-a kept, no remote origin"]);
  expect(recorded(record)).toEqual([{ name: "task-a", path, primary: p.dir, cwd: p.dir }]);
  expect(existsSync(path)).toBe(false);
  expect(git(w, p.dir, ["branch", "--list", "task-a"])).toBe("task-a");
  expect(ls(w, p.dir)).toEqual([]);
  succeeded(run(w, p.dir, ["create", "task-d"]));
  git(w, p.path("task-d"), ["checkout", "-q", "--detach"]);
  expect(succeeded(run(w, p.dir, ["remove", "task-d"]))).toEqual(["detached"]);
  expect(existsSync(p.path("task-d"))).toBe(false);
});

function branches(w: ReturnType<typeof world>, dir: string): string {
  return git(w, dir, ["for-each-ref", "--format=%(refname:short)", "refs/heads/task-*"]);
}

function remoteHeads(w: ReturnType<typeof world>, bare: string): string {
  return git(w, bare, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
}

function squashIn(w: ReturnType<typeof world>, dir: string, branch: string): void {
  git(w, dir, ["pull", "-q", "--ff-only", "origin", "main"]);
  git(w, dir, ["merge", "-q", "--squash", branch]);
  git(w, dir, ["commit", "-q", "-m", `squashed ${branch}`]);
  git(w, dir, ["push", "-q", "origin", "main", `:${branch}`]);
}

test("AC-40 remove deletes a merged branch here and on origin, and keeps an unmerged one", () => {
  const w = world();
  const p = project(w);
  const bare = bareRemote(w, p.dir);
  for (const name of ["task-a", "task-b"]) succeeded(run(w, p.dir, ["create", name]));
  commitIn(w, p.path("task-a"), "merged");
  git(w, p.path("task-a"), ["push", "-q", "-u", "origin", "task-a"]);
  git(w, p.path("task-a"), ["push", "-q", bare, "task-a:main"]);
  expect(succeeded(run(w, p.dir, ["remove", "task-a"]))).toEqual([
    "branch task-a deleted, merged into origin/main, and origin/task-a deleted",
  ]);
  expect(remoteHeads(w, bare)).toBe("main");
  commitIn(w, p.path("task-b"), "unmerged");
  writeFileSync(join(p.path("task-b"), "untracked"), "work\n");
  expect(succeeded(run(w, p.dir, ["remove", "--force", "task-b"]))).toEqual([
    "branch task-b kept, not merged into origin/main",
  ]);
  expect(branches(w, p.dir)).toBe("task-b");
});

test("AC-40 remove deletes a squash-merged branch whose origin branch is gone, and keeps one with a commit since", () => {
  const w = world();
  const p = project(w);
  bareRemote(w, p.dir);
  for (const name of ["task-c", "task-e"]) succeeded(run(w, p.dir, ["create", name]));
  commitIn(w, p.path("task-c"), "squashed");
  git(w, p.path("task-c"), ["push", "-q", "-u", "origin", "task-c"]);
  squashIn(w, p.dir, "task-c");
  expect(succeeded(run(w, p.dir, ["remove", "task-c"]))).toEqual([
    "branch task-c deleted, squash-merged into origin/main",
  ]);
  commitIn(w, p.path("task-e"), "squashed-then-more");
  git(w, p.path("task-e"), ["push", "-q", "-u", "origin", "task-e"]);
  squashIn(w, p.dir, "task-e");
  commitIn(w, p.path("task-e"), "more");
  expect(succeeded(run(w, p.dir, ["remove", "task-e"]))).toEqual([
    "branch task-e kept, not merged into origin/main",
  ]);
  expect(branches(w, p.dir)).toBe("task-e");
});

test("AC-40 prune settles the branches of worktrees deleted by hand, and an unreachable origin keeps a branch, naming why", () => {
  const w = world();
  const p = project(w);
  bareRemote(w, p.dir);
  for (const name of ["task-d", "task-f"]) succeeded(run(w, p.dir, ["create", name]));
  commitIn(w, p.path("task-f"), "unmerged");
  rmSync(p.path("task-d"), { recursive: true });
  rmSync(p.path("task-f"), { recursive: true });
  const pruned = run(w, p.dir, ["prune"]);
  expect(succeeded(pruned)).toEqual([]);
  expect(pruned.stderr).toContain("agent-worktree: branch task-d deleted, merged into origin/main\n");
  expect(pruned.stderr).toContain("agent-worktree: branch task-f kept, not merged into origin/main\n");
  expect(branches(w, p.dir)).toBe("task-f");
  expect(ls(w, p.dir)).toEqual([]);
  succeeded(run(w, p.dir, ["create", "task-g"]));
  git(w, p.dir, ["remote", "set-url", "origin", join(w.root, "remotes", "missing.git")]);
  const [unreached = ""] = succeeded(run(w, p.dir, ["remove", "task-g"]));
  expect(unreached).toStartWith("branch task-g kept, origin could not be reached: ");
  expect(branches(w, p.dir)).toBe("task-f\ntask-g");
});

function land(w: ReturnType<typeof world>, checkout: string, branch: string): void {
  commitIn(w, checkout, `${branch}-work`);
  git(w, checkout, ["pull", "-q", "--no-rebase", "--no-edit", "origin", "main"]);
  git(w, checkout, ["push", "-q", "-u", "origin", branch]);
  git(w, checkout, ["push", "-q", "origin", `${branch}:main`]);
}

test("AC-42 prune removes a clean worktree whose pushed branch landed, and keeps the rest", () => {
  const w = world();
  const p = project(w);
  const bare = bareRemote(w, p.dir);
  const record = join(w.root, "teardown-record");
  installHook(w, p.dir, "teardown", recording(record));
  const names = ["task-a", "task-b", "task-c", "task-d", "task-e", "task-f"];
  for (const name of names) succeeded(run(w, p.dir, ["create", name]));
  land(w, p.path("task-a"), "task-a");
  land(w, p.path("task-c"), "task-c");
  writeFileSync(join(p.path("task-c"), "untracked"), "work\n");
  commitIn(w, p.path("task-d"), "unmerged");
  git(w, p.path("task-d"), ["push", "-q", "-u", "origin", "task-d"]);
  land(w, p.path("task-e"), "task-e");
  git(w, p.dir, ["worktree", "lock", p.path("task-e")]);
  land(w, p.path("task-f"), "task-f");
  const pruned = run(w, p.path("task-f"), ["prune"]);
  expect(succeeded(pruned)).toEqual([]);
  expect(pruned.stderr).toContain("agent-worktree: worktree task-a removed, its branch landed\n");
  expect(pruned.stderr).toContain(
    "agent-worktree: branch task-a deleted, merged into origin/main, and origin/task-a deleted\n",
  );
  expect(recorded(record).map(({ name }) => name)).toEqual(["task-a"]);
  expect(existsSync(p.path("task-a"))).toBe(false);
  expect(remoteHeads(w, bare)).toBe("main\ntask-c\ntask-d\ntask-e\ntask-f");
  expect(ls(w, p.dir).map(({ name, state }) => [name, state])).toEqual(
    names.slice(1).map((name) => [name, "ready"]),
  );
});

test("AC-11 remove refuses dirty and submodule worktrees without force, and locked ones always", () => {
  const w = world();
  const p = project(w);
  const dirty = p.path("task-dirty");
  succeeded(run(w, p.dir, ["create", "task-dirty"]));
  writeFileSync(join(dirty, "untracked"), "work\n");
  expect(refused(run(w, p.dir, ["remove", "task-dirty"]), "remove")).toEqual({
    message: `task-dirty has uncommitted or untracked files in ${dirty}`,
    act: "commit or discard them, or run agent-worktree remove --force task-dirty to drop them",
  });
  expect(existsSync(join(dirty, "untracked"))).toBe(true);
  expect(succeeded(run(w, p.dir, ["remove", "--force", "task-dirty"]))).toEqual([
    "branch task-dirty kept, no remote origin",
  ]);
  expect(existsSync(dirty)).toBe(false);

  const vendored = p.path("task-sub");
  succeeded(run(w, p.dir, ["create", "task-sub"]));
  const head = git(w, vendored, ["rev-parse", "HEAD"]);
  git(w, vendored, ["update-index", "--add", "--cacheinfo", `160000,${head},vendored`]);
  git(w, vendored, ["commit", "-q", "-m", "submodule"]);
  expect(refused(run(w, p.dir, ["remove", "task-sub"]), "remove")).toEqual({
    message: `task-sub contains submodules in ${vendored}, which git removes only by force`,
    act: "run agent-worktree remove --force task-sub",
  });
  expect(existsSync(vendored)).toBe(true);
  expect(succeeded(run(w, p.dir, ["remove", "--force", "task-sub"]))).toEqual([
    "branch task-sub kept, no remote origin",
  ]);
  expect(existsSync(vendored)).toBe(false);

  const locked = p.path("task-lock");
  succeeded(run(w, p.dir, ["create", "task-lock"]));
  git(w, p.dir, ["worktree", "lock", locked]);
  const lockedRefusal = {
    message: `task-lock is locked at ${locked}`,
    act: `run git worktree unlock ${locked} when the lock's reason is over, then the command again`,
  };
  expect(refused(run(w, p.dir, ["remove", "task-lock"]), "remove")).toEqual(lockedRefusal);
  expect(refused(run(w, p.dir, ["remove", "--force", "task-lock"]), "remove")).toEqual(lockedRefusal);
  expect(existsSync(locked)).toBe(true);
});

test("AC-12 a failed teardown keeps the worktree, force removes it, and prune finishes it", () => {
  const w = world();
  const p = project(w);
  const fixed = join(w.root, "fixed");
  installHook(w, p.dir, "teardown", `[ -f "${fixed}" ] || exit 4`);
  const path = p.path("task-a");
  succeeded(run(w, p.dir, ["create", "task-a"]));
  expect(refused(run(w, p.dir, ["remove", "task-a"]), "remove")).toEqual({
    message: `${join(p.dir, HOOKS, "teardown")} exited 4 for task-a; the worktree is kept`,
    act: "fix what the hook reported and run the command again, or run agent-worktree remove --force task-a to remove the worktree anyway",
  });
  expect(ls(w, p.dir)).toEqual([{ name: "task-a", state: "ready", branch: "task-a", path }]);
  expect(succeeded(run(w, p.dir, ["remove", "--force", "task-a"]))).toEqual([
    "branch task-a kept, no remote origin",
  ]);
  expect(existsSync(path)).toBe(false);
  expect(ls(w, p.dir).map(({ name, state }) => [name, state])).toEqual([["task-a", "orphaned (prune)"]]);
  writeFileSync(fixed, "");
  expect(succeeded(run(w, p.dir, ["prune"]))).toEqual([]);
  expect(ls(w, p.dir)).toEqual([]);
});

test("AC-13 remove refuses a name that is not registered", () => {
  const w = world();
  const p = project(w);
  expect(refused(run(w, p.dir, ["remove", "task-a"]), "remove")).toEqual({
    message: `task-a is not a registered worktree at ${p.path("task-a")}`,
    act: "run agent-worktree ls to see the registered names",
  });
});

test("AC-14 prune names the worktrees whose teardown failed and unregisters the rest", () => {
  const w = world();
  const p = project(w);
  const fixed = join(w.root, "fixed");
  const record = join(w.root, "teardown-record");
  installHook(
    w,
    p.dir,
    "teardown",
    `[ "$WORKTREE_NAME" = task-b ] && [ ! -f "${fixed}" ] && exit 4\n${recording(record)}`,
  );
  for (const name of ["task-a", "task-b"]) {
    succeeded(run(w, p.dir, ["create", name]));
    rmSync(p.path(name), { recursive: true });
  }
  expect(refused(run(w, p.dir, ["prune"]), "prune")).toEqual({
    message: `could not remove task-b (${join(p.dir, HOOKS, "teardown")} exited 4), which stay registered`,
    act: "fix what each cause names, then run agent-worktree prune again",
  });
  expect(recorded(record).map(({ name }) => name)).toEqual(["task-a"]);
  expect(ls(w, p.dir).map(({ name, state }) => [name, state])).toEqual([["task-b", "orphaned (prune)"]]);
  expect(git(w, p.dir, ["worktree", "list", "--porcelain"])).not.toContain(p.path("task-a"));
  writeFileSync(fixed, "");
  expect(succeeded(run(w, p.dir, ["prune"]))).toEqual([]);
  expect(recorded(record).map(({ name }) => name)).toEqual(["task-a", "task-b"]);
  expect(ls(w, p.dir)).toEqual([]);
  expect(git(w, p.dir, ["worktree", "list", "--porcelain"])).not.toContain(p.path("task-b"));
});

test("AC-15 ls lists every worktree sorted by name, or notes there are none", () => {
  const w = world();
  const p = project(w);
  expect(run(w, p.dir, ["ls"])).toEqual({
    exitCode: 0,
    stdout: "",
    stderr: "agent-worktree: no task worktrees\n",
  });
  succeeded(run(w, p.dir, ["create", "task-c"]));
  succeeded(run(w, p.dir, ["create", "task-a"]));
  mkdirSync(p.path("task-b"));
  expect(ls(w, p.dir)).toEqual([
    { name: "task-a", state: "ready", branch: "task-a", path: p.path("task-a") },
    { name: "task-b", state: "unmanaged", branch: "unlisted", path: p.path("task-b") },
    { name: "task-c", state: "ready", branch: "task-c", path: p.path("task-c") },
  ]);
});
