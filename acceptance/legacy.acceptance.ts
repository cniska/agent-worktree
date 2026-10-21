import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  git,
  hookEvent,
  installHook,
  type Listed,
  ls,
  type Project,
  project,
  recorded,
  recording,
  refused,
  removeScratchDirs,
  run,
  succeeded,
  type World,
  world,
} from "./harness";

afterEach(removeScratchDirs);

function earlier(w: World, p: Project, name: string): string {
  const path = join(p.dir, ".claude", "worktrees", name);
  git(w, p.dir, ["worktree", "add", "-q", path, "-b", name]);
  mkdirSync(join(p.dir, ".git", "agent-worktrees", name), { recursive: true });
  writeFileSync(join(p.dir, ".git", "agent-worktrees", name, "ready"), "");
  return path;
}

test("AC-21 a worktree in the earlier location is listed as legacy and refused by every command", () => {
  const w = world();
  const p = project(w);
  const record = join(w.root, "teardown-record");
  installHook(w, p.dir, "teardown", recording(record));
  const old = earlier(w, p, "task-a");
  const target = p.path("task-a");
  const listed: readonly Listed[] = [
    { name: "task-a", state: "legacy (move or drop)", branch: "task-a", path: old },
  ];
  expect(ls(w, p.dir)).toEqual(listed);
  const legacy = {
    message: `task-a is at ${old}, inside the primary checkout, where agent-worktree no longer keeps worktrees`,
    act: `keep it with mkdir -p ${dirname(target)} && git worktree move ${old} ${target}, then agent-worktree init in ${target}; or drop it with git worktree remove ${old}, then agent-worktree prune`,
  };
  expect(refused(run(w, p.dir, ["create", "task-a"]), "create")).toEqual(legacy);
  expect(refused(run(w, old, ["init"]), "init")).toEqual(legacy);
  expect(refused(run(w, p.dir, ["remove", "task-a"]), "remove")).toEqual(legacy);
  expect(refused(run(w, p.dir, ["remove", "--force", "task-a"]), "remove")).toEqual(legacy);
  const stdin = hookEvent({ hook_event_name: "WorktreeRemove", worktree_path: old });
  expect(refused(run(w, old, ["hook"], { stdin }), "hook")).toEqual(legacy);
  expect(existsSync(old)).toBe(true);
  expect(succeeded(run(w, p.dir, ["prune"]))).toEqual([]);
  expect(recorded(record)).toEqual([]);
  expect(ls(w, p.dir)).toEqual(listed);
});

test("AC-22 the keep and drop acts converge a worktree in the earlier location", () => {
  const w = world();
  const p = project(w);
  const record = join(w.root, "teardown-record");
  installHook(w, p.dir, "teardown", recording(record));
  const kept = earlier(w, p, "task-a");
  const target = p.path("task-a");
  mkdirSync(dirname(target), { recursive: true });
  git(w, p.dir, ["worktree", "move", kept, target]);
  expect(succeeded(run(w, target, ["init"]))).toEqual([]);
  expect(ls(w, p.dir)).toEqual([{ name: "task-a", state: "ready", branch: "task-a", path: target }]);

  const dropped = earlier(w, p, "task-b");
  git(w, p.dir, ["worktree", "remove", dropped]);
  expect(succeeded(run(w, p.dir, ["prune"], { env: { WORKTREE_PATH: "/inherited" } }))).toEqual([]);
  expect(recorded(record)).toEqual([{ name: "task-b", path: "unset", primary: p.dir, cwd: p.dir }]);
  expect(ls(w, p.dir).map(({ name }) => name)).toEqual(["task-a"]);

  const deleted = earlier(w, p, "task-c");
  rmSync(deleted, { recursive: true });
  expect(succeeded(run(w, p.dir, ["prune"]))).toEqual([]);
  expect(recorded(record)).toEqual([
    { name: "task-b", path: "unset", primary: p.dir, cwd: p.dir },
    { name: "task-c", path: deleted, primary: p.dir, cwd: p.dir },
  ]);
  expect(ls(w, p.dir).map(({ name }) => name)).toEqual(["task-a"]);
});

test("AC-23 an unregistered directory in the earlier location is not agent-worktree's", () => {
  const w = world();
  const p = project(w);
  const record = join(w.root, "teardown-record");
  installHook(w, p.dir, "teardown", recording(record));
  const stray = join(p.dir, ".claude", "worktrees", "task-a");
  git(w, p.dir, ["worktree", "add", "-q", stray, "-b", "task-a"]);
  expect(ls(w, p.dir)).toEqual([]);
  expect(succeeded(run(w, p.dir, ["prune"]))).toEqual([]);
  expect(existsSync(stray)).toBe(true);
  expect(git(w, p.dir, ["worktree", "list", "--porcelain"])).toContain(stray);
  expect(recorded(record)).toEqual([]);
});
