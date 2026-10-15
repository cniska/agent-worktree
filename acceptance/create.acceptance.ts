import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  git,
  HOOKS,
  installHook,
  ls,
  project,
  recorded,
  recording,
  refused,
  removeScratch,
  repo,
  run,
  succeeded,
  world,
} from "./harness";

afterEach(removeScratch);

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
  expect(succeeded(run(w, p.dir, ["create", "task-a"]))).toEqual([path]);
  expect(git(w, path, ["branch", "--show-current"])).toBe("task-a");
  expect(git(w, path, ["rev-parse", "HEAD"])).toBe(head);
  expect(recorded(record)).toEqual([{ name: "task-a", path, primary: p.dir, cwd: path }]);
  expect(ls(w, p.dir)).toEqual([{ name: "task-a", state: "ready", branch: "task-a", path }]);
  expect(succeeded(run(w, p.dir, ["create", "task-a"]))).toEqual([path]);
  expect(recorded(record)).toHaveLength(1);
  git(w, p.dir, ["branch", "task-b"]);
  const branched = git(w, p.dir, ["rev-parse", "task-b"]);
  writeFileSync(join(p.dir, "later"), "later\n");
  git(w, p.dir, ["add", "later"]);
  git(w, p.dir, ["commit", "-q", "-m", "later"]);
  expect(succeeded(run(w, p.dir, ["create", "task-b"]))).toEqual([p.path("task-b")]);
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
  expect(ls(w, p.dir)).toEqual([{ name: "task-a", state: "setup pending", branch: "task-a", path }]);
  writeFileSync(join(path, "work"), "kept\n");
  writeFileSync(fixed, "");
  expect(succeeded(run(w, p.dir, ["create", "task-a"]))).toEqual([path]);
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
  expect(succeeded(run(w, p.dir, ["create", "task-u"]))).toEqual([unmanaged]);

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
  expect(succeeded(run(w, p.dir, ["create", "task-o"]))).toEqual([orphaned]);

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
  expect(succeeded(run(w, p.dir, ["create", "task-n"]))).toEqual([unlisted]);
});

test("AC-9 init sets up the primary, a pending task worktree, and refuses any other checkout", () => {
  const w = world();
  const p = project(w);
  const record = join(w.root, "setup-record");
  const fixed = join(w.root, "fixed");
  installHook(w, p.dir, "setup", `[ -f "${fixed}" ] || exit 3\n${recording(record)}`);
  writeFileSync(fixed, "");
  expect(succeeded(run(w, p.dir, ["init"], { env: { WORKTREE_NAME: "inherited" } }))).toEqual([]);
  expect(recorded(record)).toEqual([{ name: "unset", path: p.dir, primary: p.dir, cwd: p.dir }]);
  rmSync(fixed);
  const path = p.path("task-a");
  expect(refused(run(w, p.dir, ["create", "task-a"]), "create")).toEqual({
    message: `${join(path, HOOKS, "setup")} exited 3 in ${path}; setup is pending`,
    act: "fix what the hook reported, then run the command again to resume",
  });
  expect(ls(w, p.dir)).toEqual([{ name: "task-a", state: "setup pending", branch: "task-a", path }]);
  writeFileSync(fixed, "");
  expect(succeeded(run(w, path, ["init"]))).toEqual([]);
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
