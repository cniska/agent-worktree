import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { git, keyOf, ls, project, removeScratchDirs, repo, run, succeeded, world } from "./harness";

afterEach(removeScratchDirs);

test("AC-1 create and path print the worktree's place under XDG_DATA_HOME, outside the primary", () => {
  const w = world();
  const p = project(w);
  const [created = ""] = succeeded(run(w, p.dir, ["create", "task-a"]));
  expect(created).toStartWith(`${w.data}/repo-`);
  expect(created).toEndWith("/task-a");
  expect(created.startsWith(`${p.dir}/`)).toBe(false);
  expect(existsSync(join(created, "README.md"))).toBe(true);
  expect(succeeded(run(w, p.dir, ["path", "task-a"]))).toEqual([created]);
});

test("AC-2 an unset, empty or relative XDG_DATA_HOME falls back to HOME, and an unset or empty HOME to the account's home", () => {
  const w = world();
  const dir = repo(w);
  const underHome = (home: string) => `${home}/.local/share/agent-worktree/`;
  const pathWith = (env: Record<string, string>, unset: readonly string[] = []) => {
    const [printed = ""] = succeeded(run(w, dir, ["path", "task-a"], { env, unset }));
    return printed;
  };
  expect(pathWith({}, ["XDG_DATA_HOME"])).toStartWith(underHome(w.home));
  expect(pathWith({ XDG_DATA_HOME: "" })).toStartWith(underHome(w.home));
  expect(pathWith({ XDG_DATA_HOME: "relative/data" })).toStartWith(underHome(w.home));
  const account = userInfo().homedir;
  expect(pathWith({}, ["XDG_DATA_HOME", "HOME"])).toStartWith(underHome(account));
  expect(pathWith({ HOME: "" }, ["XDG_DATA_HOME"])).toStartWith(underHome(account));
});

test("AC-51 an XDG_DATA_HOME reached through a symlink places the worktree at the resolved path, and remove removes it", () => {
  const w = world();
  const p = project(w);
  const linked = join(w.root, "linked-data");
  symlinkSync(join(w.root, "data"), linked);
  const env = { XDG_DATA_HOME: linked };
  const [created = ""] = succeeded(run(w, p.dir, ["create", "task-a"], { env }));
  expect(created).toStartWith(`${w.data}/repo-`);
  expect(created).toEndWith("/task-a");
  succeeded(run(w, p.dir, ["remove", "task-a"], { env }));
  expect(existsSync(created)).toBe(false);
});

test("AC-3 the key is the same from the primary and its worktree, and differs for two clones named alike", () => {
  const w = world();
  const first = project(w);
  const [created = ""] = succeeded(run(w, first.dir, ["create", "task-a"]));
  const key = keyOf(w, created);
  expect(key).toMatch(/^repo-./);
  expect(succeeded(run(w, created, ["path", "task-b"]))).toEqual([join(w.data, key, "task-b")]);
  const second = repo(w, join(w.root, "elsewhere", "repo"));
  const [other = ""] = succeeded(run(w, second, ["path", "task-a"]));
  expect(keyOf(w, other)).toMatch(/^repo-./);
  expect(dirname(other)).not.toBe(dirname(created));
});

test("AC-4 a registration an earlier release wrote under .git/agent-worktrees reads as ready", () => {
  const w = world();
  const p = project(w);
  const path = p.path("task-a");
  mkdirSync(dirname(path), { recursive: true });
  git(w, p.dir, ["worktree", "add", "-q", path, "-b", "task-a"]);
  mkdirSync(join(p.dir, ".git", "agent-worktrees", "task-a"), { recursive: true });
  writeFileSync(join(p.dir, ".git", "agent-worktrees", "task-a", "ready"), "");
  expect(ls(w, p.dir)).toEqual([{ name: "task-a", state: "ready", branch: "task-a", path }]);
});
