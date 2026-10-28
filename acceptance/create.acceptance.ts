import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  bareRemote,
  commitIn,
  errorOf,
  git,
  HOOKS,
  halfMadeGit,
  installHook,
  ls,
  printedPath,
  project,
  recorded,
  recording,
  refused,
  removed,
  removeScratchDirs,
  repo,
  run,
  succeeded,
  usageRefused,
  world,
} from "./harness";

afterEach(removeScratchDirs);

test("AC-5 create refuses each invalid name, a case collision, an unsupported layout and a non-checkout", () => {
  const w = world();
  const p = project(w);
  for (const raw of [".", "..", "a/b", "a b", "a..b", "x.lock", "task@{1}"])
    expect(refused(run(w, p.dir, ["create", raw]), "create")).toEqual({
      message: `${raw} is not a worktree name`,
      act: "name the worktree with one path segment of letters, digits, dots, underscores and dashes that git accepts as a branch name, and run the command again",
    });
  succeeded(run(w, p.dir, ["create", "task-a"]));
  expect(refused(run(w, p.dir, ["create", "Task-A"]), "create")).toEqual({
    message: "Task-A differs only in case from the existing task-a",
    act: "use the name task-a, or pick a name that differs in more than case",
  });
  const unsupported =
    "run agent-worktree in a plain clone; a submodule, a bare repository and a separate git dir are not supported";
  const sub = repo(w, join(w.root, "upstream", "sub"));
  git(w, p.dir, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "vendored"]);
  expect(refused(run(w, join(p.dir, "vendored"), ["create", "task-b"]), "create")).toEqual({
    message: `${join(p.dir, ".git", "modules", "vendored")} is not a .git directory inside the primary checkout`,
    act: unsupported,
  });
  const separate = join(w.root, "separate", "repo");
  git(w, w.root, [
    "init",
    "-q",
    "-b",
    "main",
    `--separate-git-dir=${join(w.root, "elsewhere.git")}`,
    separate,
  ]);
  expect(refused(run(w, separate, ["create", "task-b"]), "create")).toEqual({
    message: `${join(w.root, "elsewhere.git")} is not a .git directory inside the primary checkout`,
    act: unsupported,
  });
  const outside = join(w.root, "outside");
  mkdirSync(outside);
  expect(refused(run(w, outside, ["create", "task-b"]), "create")).toEqual({
    message: `${outside} is not inside a git checkout`,
    act: "cd into the project's checkout and run the command again",
  });
});

test("AC-6 create makes the worktree on its branch, sets it up once, and lists it ready", () => {
  const w = world();
  const p = project(w);
  const record = join(w.root, "setup-record");
  installHook(w, p.dir, "setup", recording(record));
  const path = p.path("task-a");
  const head = git(w, p.dir, ["rev-parse", "HEAD"]);
  expect(printedPath(run(w, p.dir, ["create", "task-a"]))).toBe(path);
  expect(git(w, path, ["branch", "--show-current"])).toBe("task-a");
  expect(git(w, path, ["rev-parse", "HEAD"])).toBe(head);
  expect(recorded(record)).toEqual([{ name: "task-a", path, primary: p.dir, cwd: path }]);
  expect(ls(w, p.dir)).toEqual([{ name: "task-a", state: "ready", branch: "task-a", path }]);
  expect(printedPath(run(w, p.dir, ["create", "task-a"]))).toBe(path);
  expect(recorded(record)).toHaveLength(1);
  git(w, p.dir, ["branch", "task-b"]);
  const branched = git(w, p.dir, ["rev-parse", "task-b"]);
  writeFileSync(join(p.dir, "later"), "later\n");
  git(w, p.dir, ["add", "later"]);
  git(w, p.dir, ["commit", "-q", "-m", "later"]);
  expect(printedPath(run(w, p.dir, ["create", "task-b"]))).toBe(p.path("task-b"));
  expect(git(w, p.path("task-b"), ["branch", "--show-current"])).toBe("task-b");
  expect(git(w, p.path("task-b"), ["rev-parse", "HEAD"])).toBe(branched);
  expect(recorded(record)).toEqual([
    { name: "task-a", path, primary: p.dir, cwd: path },
    { name: "task-b", path: p.path("task-b"), primary: p.dir, cwd: p.path("task-b") },
  ]);
  expect(ls(w, p.dir)).toEqual([
    { name: "task-a", state: "ready", branch: "task-a", path },
    { name: "task-b", state: "ready", branch: "task-b", path: p.path("task-b") },
  ]);
});

test("AC-7 a failed setup leaves the worktree pending, and the rerun resumes it", () => {
  const w = world();
  const p = project(w);
  const record = join(w.root, "setup-record");
  const fixed = join(w.root, "fixed");
  installHook(w, p.dir, "setup", `[ -f "${fixed}" ] || exit 3\n${recording(record)}`);
  const path = p.path("task-a");
  expect(refused(run(w, p.dir, ["create", "task-a"]), "create")).toEqual({
    message: `${join(path, HOOKS, "setup")} exited 3 in ${path}; setup is pending`,
    act: "fix what the hook reported, then run the command again to resume",
  });
  expect(ls(w, p.dir)).toEqual([{ name: "task-a", state: "pending", branch: "task-a", path }]);
  writeFileSync(join(path, "work"), "kept\n");
  writeFileSync(fixed, "");
  expect(printedPath(run(w, p.dir, ["create", "task-a"]))).toBe(path);
  expect(existsSync(join(path, "work"))).toBe(true);
  expect(recorded(record)).toEqual([{ name: "task-a", path, primary: p.dir, cwd: path }]);
  expect(ls(w, p.dir)).toEqual([{ name: "task-a", state: "ready", branch: "task-a", path }]);
});

test("AC-8 create and remove refuse unmanaged, orphaned and unlisted worktrees until their act is done", () => {
  const w = world();
  const p = project(w);
  const unmanaged = p.path("task-u");
  mkdirSync(unmanaged, { recursive: true });
  const unmanagedRefusal = {
    message: `${unmanaged} exists but agent-worktree did not create it`,
    act: `remove it yourself, with git worktree remove ${unmanaged} when git lists it, or pick another name`,
  };
  expect(refused(run(w, p.dir, ["create", "task-u"]), "create")).toEqual(unmanagedRefusal);
  expect(refused(run(w, p.dir, ["remove", "--force", "task-u"]), "remove")).toEqual(unmanagedRefusal);
  expect(existsSync(unmanaged)).toBe(true);
  rmSync(unmanaged, { recursive: true });
  expect(printedPath(run(w, p.dir, ["create", "task-u"]))).toBe(unmanaged);

  const orphaned = p.path("task-o");
  succeeded(run(w, p.dir, ["create", "task-o"]));
  rmSync(orphaned, { recursive: true });
  const orphanedRefusal = {
    message: "task-o is registered but its worktree is gone, so its teardown never ran",
    act: "run agent-worktree prune, then the command again",
  };
  expect(refused(run(w, p.dir, ["create", "task-o"]), "create")).toEqual(orphanedRefusal);
  expect(refused(run(w, p.dir, ["remove", "task-o"]), "remove")).toEqual(orphanedRefusal);
  succeeded(run(w, p.dir, ["prune"]));
  expect(printedPath(run(w, p.dir, ["create", "task-o"]))).toBe(orphaned);

  const unlisted = p.path("task-n");
  succeeded(run(w, p.dir, ["create", "task-n"]));
  rmSync(unlisted, { recursive: true });
  git(w, p.dir, ["worktree", "prune"]);
  mkdirSync(unlisted);
  const unlistedRefusal = {
    message: `task-n is registered but git does not list ${unlisted} as a worktree`,
    act: "remove the directory, then agent-worktree prune",
  };
  expect(refused(run(w, p.dir, ["create", "task-n"]), "create")).toEqual(unlistedRefusal);
  expect(refused(run(w, p.dir, ["remove", "task-n"]), "remove")).toEqual(unlistedRefusal);
  rmSync(unlisted, { recursive: true });
  succeeded(run(w, p.dir, ["prune"]));
  expect(printedPath(run(w, p.dir, ["create", "task-n"]))).toBe(unlisted);
});

test("AC-9 init sets up the primary, a pending task worktree, and refuses any other checkout", () => {
  const w = world();
  const p = project(w);
  const record = join(w.root, "setup-record");
  const fixed = join(w.root, "fixed");
  installHook(w, p.dir, "setup", `[ -f "${fixed}" ] || exit 3\n${recording(record)}`);
  writeFileSync(fixed, "");
  expect(succeeded(run(w, p.dir, ["init"], { env: { WORKTREE_NAME: "inherited" } }))).toBeNull();
  expect(recorded(record)).toEqual([{ name: "unset", path: p.dir, primary: p.dir, cwd: p.dir }]);
  rmSync(fixed);
  const path = p.path("task-a");
  expect(refused(run(w, p.dir, ["create", "task-a"]), "create")).toEqual({
    message: `${join(path, HOOKS, "setup")} exited 3 in ${path}; setup is pending`,
    act: "fix what the hook reported, then run the command again to resume",
  });
  expect(ls(w, p.dir)).toEqual([{ name: "task-a", state: "pending", branch: "task-a", path }]);
  writeFileSync(fixed, "");
  expect(succeeded(run(w, path, ["init"]))).toBeNull();
  expect(recorded(record)).toEqual([
    { name: "unset", path: p.dir, primary: p.dir, cwd: p.dir },
    { name: "task-a", path, primary: p.dir, cwd: path },
  ]);
  expect(ls(w, p.dir)).toEqual([{ name: "task-a", state: "ready", branch: "task-a", path }]);
  const other = p.path("other");
  git(w, p.dir, ["worktree", "add", "-q", other, "-b", "other"]);
  expect(refused(run(w, other, ["init"]), "init")).toEqual({
    message: `${other} is neither the primary checkout nor a registered task worktree`,
    act: "cd into the primary checkout or a worktree agent-worktree created, and run init there",
  });
});

type W = ReturnType<typeof world>;

function aheadOnRemote(w: W, bare: string, file: string): string {
  const other = join(w.root, "clones", `other-${file}`);
  git(w, w.root, ["clone", "-q", bare, other]);
  return pushed(w, other, file);
}

function pushed(w: W, clone: string, file: string): string {
  const tip = commitIn(w, clone, file);
  git(w, clone, ["push", "-q", "origin", "HEAD:main"]);
  return tip;
}

function upstreamOf(w: W, dir: string, branch: string): string {
  return git(w, dir, ["for-each-ref", "--format=%(upstream)", `refs/heads/${branch}`]);
}

test("AC-52 create cuts a new branch from origin's default branch as fetched now, with no upstream, and remove deletes it once landed", () => {
  const w = world();
  const p = project(w);
  const bare = bareRemote(w, p.dir);
  commitIn(w, p.dir, "local-only");
  const remoteTip = aheadOnRemote(w, bare, "remote-only");
  const path = p.path("task-a");
  expect(printedPath(run(w, p.dir, ["create", "task-a"]))).toBe(path);
  expect(git(w, path, ["rev-parse", "HEAD"])).toBe(remoteTip);
  expect(upstreamOf(w, p.dir, "task-a")).toBe("");
  commitIn(w, path, "work");
  git(w, path, ["push", "-q", "-u", "origin", "task-a"]);
  git(w, path, ["push", "-q", "origin", "task-a:main"]);
  expect(removed(run(w, p.dir, ["remove", "task-a"]))).toEqual({
    name: "task-a",
    branch: "task-a",
    outcome: "deleted",
    landing: "merged",
    into: "origin/main",
    remoteBranch: "origin/task-a",
  });
  expect(git(w, p.dir, ["branch", "--list", "task-a"])).toBe("");
});

test("AC-53 create --from cuts from the ref as the checkout it runs in names it, with no upstream and no fetch", () => {
  const w = world();
  const p = project(w);
  const bare = bareRemote(w, p.dir);
  const tagged = commitIn(w, p.dir, "tagged");
  git(w, p.dir, ["tag", "v1"]);
  commitIn(w, p.dir, "after-tag");
  expect(printedPath(run(w, p.dir, ["create", "--from", "v1", "task-a"]))).toBe(p.path("task-a"));
  expect(git(w, p.path("task-a"), ["rev-parse", "HEAD"])).toBe(tagged);
  expect(upstreamOf(w, p.dir, "task-a")).toBe("");
  const inTask = commitIn(w, p.path("task-a"), "in-task");
  expect(printedPath(run(w, p.path("task-a"), ["create", "--from", "HEAD", "task-b"]))).toBe(
    p.path("task-b"),
  );
  expect(git(w, p.path("task-b"), ["rev-parse", "HEAD"])).toBe(inTask);
  const stale = git(w, p.dir, ["rev-parse", "origin/main"]);
  aheadOnRemote(w, bare, "unfetched");
  expect(printedPath(run(w, p.dir, ["create", "--from", "origin/main", "task-c"]))).toBe(p.path("task-c"));
  expect(git(w, p.path("task-c"), ["rev-parse", "HEAD"])).toBe(stale);
  expect(git(w, p.dir, ["rev-parse", "origin/main"])).toBe(stale);
  expect(upstreamOf(w, p.dir, "task-c")).toBe("");
  expect(refused(run(w, p.dir, ["create", "--from", "nowhere", "task-d"]), "create")).toEqual({
    message: `nowhere names no commit in ${p.dir}`,
    act: "name a branch, tag or commit that exists there, and run the command again",
  });
  expect(usageRefused(run(w, p.dir, ["create", "--from", "", "task-d"]), "create")).toEqual({
    message: "agent-worktree create --from takes a ref, and got none",
    act: "agent-worktree create [--from <ref>] <name>",
  });
  expect(existsSync(p.path("task-d"))).toBe(false);
  expect(git(w, p.dir, ["branch", "--list", "task-d"])).toBe("");
  expect(ls(w, p.dir).map(({ name }) => name)).toEqual(["task-a", "task-b", "task-c"]);
});

test("AC-54 with no remote or an empty one create cuts from HEAD noting why, and an unreachable one is refused until --from", () => {
  const w = world();
  const p = project(w);
  const head = git(w, p.dir, ["rev-parse", "HEAD"]);
  const local = run(w, p.dir, ["create", "task-a"]);
  expect(printedPath(local)).toBe(p.path("task-a"));
  expect(local.stderr).toContain("agent-worktree: branch task-a cut from HEAD, no remote origin\n");
  expect(git(w, p.path("task-a"), ["rev-parse", "HEAD"])).toBe(head);
  const empty = join(w.root, "remotes", "empty.git");
  git(w, w.root, ["init", "-q", "--bare", "-b", "main", empty]);
  git(w, p.dir, ["remote", "add", "origin", empty]);
  const unborn = run(w, p.dir, ["create", "task-b"]);
  expect(printedPath(unborn)).toBe(p.path("task-b"));
  expect(unborn.stderr).toContain(
    "agent-worktree: branch task-b cut from HEAD, origin has no default branch\n",
  );
  expect(git(w, p.path("task-b"), ["rev-parse", "HEAD"])).toBe(head);
  git(w, p.dir, ["remote", "set-url", "origin", join(w.root, "remotes", "missing.git")]);
  const unreached = refused(run(w, p.dir, ["create", "task-c"]), "create");
  expect(unreached.message).toStartWith("origin could not be reached to cut task-c: ");
  expect(unreached.act).toBe(
    "run the command again once origin can be reached, or run agent-worktree create --from HEAD task-c to cut from the HEAD of the checkout it runs in",
  );
  expect(existsSync(p.path("task-c"))).toBe(false);
  expect(git(w, p.dir, ["branch", "--list", "task-c"])).toBe("");
  expect(printedPath(run(w, p.dir, ["create", "--from", "HEAD", "task-c"]))).toBe(p.path("task-c"));
  expect(git(w, p.path("task-c"), ["rev-parse", "HEAD"])).toBe(head);
});

test("AC-55 create --from refuses an existing branch, and is ignored, noted, on a worktree it already made", () => {
  const w = world();
  const p = project(w);
  git(w, p.dir, ["branch", "task-a"]);
  expect(refused(run(w, p.dir, ["create", "--from", "HEAD", "task-a"]), "create")).toEqual({
    message: "--from HEAD would cut task-a, but branch task-a already exists",
    act: "drop --from to check out the existing branch, or pick another name",
  });
  expect(existsSync(p.path("task-a"))).toBe(false);
  expect(ls(w, p.dir)).toEqual([]);
  const record = join(w.root, "setup-record");
  const fixed = join(w.root, "fixed");
  installHook(w, p.dir, "setup", `[ -f "${fixed}" ] || exit 3\n${recording(record)}`);
  const path = p.path("task-b");
  refused(run(w, p.dir, ["create", "--from", "HEAD", "task-b"]), "create");
  writeFileSync(fixed, "");
  const resumed = run(w, p.dir, ["create", "--from", "HEAD", "task-b"]);
  expect(printedPath(resumed)).toBe(path);
  expect(resumed.stderr).toContain("agent-worktree: worktree task-b exists, so --from HEAD is ignored\n");
  expect(recorded(record)).toEqual([{ name: "task-b", path, primary: p.dir, cwd: path }]);
  expect(ls(w, p.dir)).toEqual([{ name: "task-b", state: "ready", branch: "task-b", path }]);
  const again = run(w, p.dir, ["create", "--from", "HEAD", "task-b"]);
  expect(printedPath(again)).toBe(path);
  expect(again.stderr).toContain("agent-worktree: worktree task-b exists, so --from HEAD is ignored\n");
  expect(recorded(record)).toEqual([{ name: "task-b", path, primary: p.dir, cwd: path }]);
});

test("AC-57 create, ls and remove wait out another worktree half made, and a worktree that stays half made fails ls with git's own error", () => {
  const w = world();
  const p = project(w);
  bareRemote(w, p.dir);
  git(w, p.dir, ["branch", "task-c"]);
  const during = (command: string, args: readonly string[]) => {
    const other = halfMadeGit(w, p.dir, command, "once");
    const ran = run(w, p.dir, args, { env: { PATH: other.path } });
    expect(other.runs()).toBe(2);
    return ran;
  };
  expect(printedPath(during("fetch", ["create", "task-a"]))).toBe(p.path("task-a"));
  expect(printedPath(during("worktree add", ["create", "task-b"]))).toBe(p.path("task-b"));
  expect(printedPath(during("worktree add", ["create", "task-c"]))).toBe(p.path("task-c"));
  succeeded(during("worktree list", ["ls"]));
  expect(removed(during("worktree remove", ["remove", "task-a"]))).toMatchObject({ name: "task-a" });
  expect(ls(w, p.dir).map((item) => item.name)).toEqual(["task-b", "task-c"]);
  const stuck = halfMadeGit(w, p.dir, "worktree list", "always");
  const ran = run(w, p.dir, ["ls"], { env: { PATH: stuck.path } });
  expect(errorOf(ran, "ls").message).toStartWith(
    "git worktree list --porcelain exited 128: fatal: failed to read .git/worktrees/other/commondir: ",
  );
  expect(stuck.runs()).toBe(50);
});
