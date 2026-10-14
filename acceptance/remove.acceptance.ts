import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  bareRemote,
  git,
  ls,
  project,
  recorded,
  recording,
  refused,
  removeScratch,
  run,
  script,
  succeeded,
  world,
} from "./harness";

afterEach(removeScratch);

test("AC-10 remove tears down in the primary, removes the worktree and keeps a branch no remote tracks", () => {
  const w = world();
  const p = project(w);
  const record = join(w.root, "teardown-record");
  script(w, p.dir, "worktree-teardown.sh", recording(record));
  const path = p.path("task-a");
  succeeded(run(w, p.dir, ["create", "task-a"]));
  expect(succeeded(run(w, p.dir, ["remove", "task-a"]))).toEqual([
    "branch task-a kept, no default branch tracked for origin",
  ]);
  expect(recorded(record)).toEqual([{ name: "task-a", path, primary: p.dir, cwd: p.dir }]);
  expect(existsSync(path)).toBe(false);
  expect(git(w, p.dir, ["branch", "--list", "task-a"])).toBe("task-a");
  expect(ls(w, p.dir)).toEqual([]);
  succeeded(run(w, p.dir, ["create", "task-d"]));
  git(w, p.path("task-d"), ["checkout", "-q", "--detach"]);
  expect(succeeded(run(w, p.dir, ["remove", "task-d"]))).toEqual(["detached"]);
  expect(existsSync(p.path("task-d"))).toBe(false);
});

function commitIn(w: ReturnType<typeof world>, checkout: string, file: string): void {
  writeFileSync(join(checkout, file), `${file}\n`);
  git(w, checkout, ["add", file]);
  git(w, checkout, ["commit", "-q", "-m", file]);
}

function branches(w: ReturnType<typeof world>, dir: string): string {
  return git(w, dir, ["for-each-ref", "--format=%(refname:short)", "refs/heads/task-*"]);
}

test("AC-40 remove and prune delete a branch merged into origin's default branch and keep an unmerged one", () => {
  const w = world();
  const p = project(w);
  bareRemote(w, p.dir);
  for (const name of ["task-a", "task-b", "task-c", "task-d"]) succeeded(run(w, p.dir, ["create", name]));
  commitIn(w, p.path("task-a"), "merged");
  git(w, p.dir, ["merge", "-q", "--ff-only", "task-a"]);
  git(w, p.dir, ["push", "-q", "origin", "main"]);
  expect(succeeded(run(w, p.dir, ["remove", "task-a"]))).toEqual([
    "branch task-a deleted, merged into origin/main",
  ]);
  commitIn(w, p.path("task-b"), "unmerged");
  writeFileSync(join(p.path("task-b"), "untracked"), "work\n");
  expect(succeeded(run(w, p.dir, ["remove", "--force", "task-b"]))).toEqual([
    "branch task-b kept, not merged into origin/main",
  ]);
  commitIn(w, p.path("task-c"), "squashed");
  git(w, p.dir, ["merge", "-q", "--squash", "task-c"]);
  git(w, p.dir, ["commit", "-q", "-m", "squashed"]);
  git(w, p.dir, ["push", "-q", "origin", "main"]);
  rmSync(p.path("task-c"), { recursive: true });
  rmSync(p.path("task-d"), { recursive: true });
  const pruned = run(w, p.dir, ["prune"]);
  expect(succeeded(pruned)).toEqual([]);
  expect(pruned.stderr).toContain("agent-worktree: branch task-c kept, not merged into origin/main\n");
  expect(pruned.stderr).toContain("agent-worktree: branch task-d deleted, merged into origin/main\n");
  expect(branches(w, p.dir)).toBe("task-b\ntask-c");
  expect(ls(w, p.dir)).toEqual([]);
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
    "branch task-dirty kept, no default branch tracked for origin",
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
    "branch task-sub kept, no default branch tracked for origin",
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
  script(w, p.dir, "worktree-teardown.sh", `[ -f "${fixed}" ] || exit 4`);
  const path = p.path("task-a");
  succeeded(run(w, p.dir, ["create", "task-a"]));
  expect(refused(run(w, p.dir, ["remove", "task-a"]), "remove")).toEqual({
    message: "scripts/worktree-teardown.sh exited 4 for task-a; the worktree is kept",
    act: "fix what the script reported and run the command again, or run agent-worktree remove --force task-a to remove the worktree anyway",
  });
  expect(ls(w, p.dir)).toEqual([{ name: "task-a", state: "ready", branch: "task-a", path }]);
  expect(succeeded(run(w, p.dir, ["remove", "--force", "task-a"]))).toEqual([
    "branch task-a kept, no default branch tracked for origin",
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
  script(
    w,
    p.dir,
    "worktree-teardown.sh",
    `[ "$WORKTREE_NAME" = task-b ] && [ ! -f "${fixed}" ] && exit 4\n${recording(record)}`,
  );
  for (const name of ["task-a", "task-b"]) {
    succeeded(run(w, p.dir, ["create", name]));
    rmSync(p.path(name), { recursive: true });
  }
  expect(refused(run(w, p.dir, ["prune"]), "prune")).toEqual({
    message: "scripts/worktree-teardown.sh failed for task-b, which stay registered",
    act: "fix what the script reported, then run agent-worktree prune again",
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
