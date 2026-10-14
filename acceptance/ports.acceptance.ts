import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  blockText,
  freeBlocks,
  git,
  holding,
  ls,
  lsPorts,
  onLoopback,
  portRecording,
  portsRecorded,
  project,
  refused,
  removeScratch,
  repo,
  run,
  runAsync,
  runAtOnce,
  script,
  succeeded,
  world,
} from "./harness";

afterEach(removeScratch);

test("AC-30 each worktree gets the lowest free block as WORKTREE_PORT, shown by ls; the primary gets none", async () => {
  const w = world();
  const p = project(w);
  const record = join(w.root, "ports");
  script(w, p.dir, "worktree-setup.sh", portRecording(record));
  const [first, second] = await freeBlocks();
  const created = run(w, p.dir, ["create", "task-a"]);
  succeeded(created);
  expect(created.stderr).toContain(`agent-worktree: port block ${blockText(first)} for task-a\n`);
  succeeded(run(w, p.dir, ["create", "task-b"]));
  expect(portsRecorded(record)).toEqual([String(first), String(second)]);
  expect(lsPorts(w, p.dir)).toEqual({ "task-a": blockText(first), "task-b": blockText(second) });
  succeeded(run(w, p.dir, ["init"], { env: { WORKTREE_PORT: "24000" } }));
  expect(portsRecorded(record)).toEqual([String(first), String(second), "unset"]);
});

test("AC-31 remove gives teardown the block and frees it for the next create", async () => {
  const w = world();
  const p = project(w);
  const record = join(w.root, "ports");
  script(w, p.dir, "worktree-teardown.sh", portRecording(record));
  const [first] = await freeBlocks();
  succeeded(run(w, p.dir, ["create", "task-a"]));
  succeeded(run(w, p.dir, ["create", "task-b"]));
  expect(succeeded(run(w, p.dir, ["remove", "task-a"]))).toEqual(["branch task-a kept"]);
  expect(portsRecorded(record)).toEqual([String(first)]);
  succeeded(run(w, p.dir, ["create", "task-c"]));
  expect(lsPorts(w, p.dir)["task-c"]).toBe(blockText(first));
});

test("AC-32 a block with a port another program listens on, on any address, is skipped, seen by connecting", async () => {
  const w = world();
  const p = project(w);
  const [first, second, third] = await freeBlocks();
  const everyAddress = [
    { hostname: "0.0.0.0", port: first + 9 },
    { hostname: "::", port: second },
  ];
  const connected = await holding(everyAddress, async (held) => {
    succeeded(await runAsync(w, p.dir, ["create", "task-a"]));
    return held.map((each) => each.connections() > 0);
  });
  expect(connected).toEqual([true, true]);
  expect(lsPorts(w, p.dir)).toEqual({ "task-a": blockText(third) });
});

test("AC-33 clones share the machine's blocks, and prune frees a deleted clone's block", async () => {
  const w = world();
  const gone = repo(w, join(w.root, "clones", "gone"));
  const kept = repo(w, join(w.root, "clones", "kept"));
  const [first, second] = await freeBlocks();
  succeeded(run(w, gone, ["create", "task-a"]));
  succeeded(run(w, kept, ["create", "task-a"]));
  expect(lsPorts(w, kept)).toEqual({ "task-a": blockText(second) });
  rmSync(gone, { recursive: true, force: true });
  const pruned = run(w, kept, ["prune"]);
  succeeded(pruned);
  expect(pruned.stderr).toContain(
    `agent-worktree: port block ${blockText(first)} freed from ${join(gone, ".git", "agent-worktrees", "task-a")}, which is gone\n`,
  );
  succeeded(run(w, kept, ["create", "task-b"]));
  expect(lsPorts(w, kept)).toEqual({ "task-a": blockText(second), "task-b": blockText(first) });
});

test("AC-34 creates started at once each get a different block", async () => {
  const w = world();
  const p = project(w);
  const names = ["task-a", "task-b", "task-c", "task-d", "task-e", "task-f"];
  const ran = await runAtOnce(
    w,
    p.dir,
    names.map((name) => ["create", name]),
  );
  expect(ran.map((each) => succeeded(each))).toEqual(names.map((name) => [p.path(name)]));
  const blocks = Object.values(lsPorts(w, p.dir));
  expect(blocks).toHaveLength(names.length);
  expect(new Set(blocks).size).toBe(names.length);
});

test("AC-35 with no free block create refuses and keeps setup pending, then resumes once one is free", async () => {
  const w = world();
  const p = project(w);
  const record = join(w.root, "ports");
  script(w, p.dir, "worktree-setup.sh", portRecording(record));
  const free = await freeBlocks();
  const ran = await holding(onLoopback(free), () => runAsync(w, p.dir, ["create", "task-a"]));
  expect(refused(ran, "create")).toEqual({
    message:
      "no port block from 24000 to 24999 is free for task-a: worktrees hold some and other programs listen on the rest; setup is pending",
    act: "remove a worktree you are done with, or run agent-worktree prune to free the blocks of worktrees that are gone, then run the command again",
  });
  expect(ls(w, p.dir)).toEqual([
    { name: "task-a", state: "setup pending", branch: "task-a", path: p.path("task-a") },
  ]);
  expect(lsPorts(w, p.dir)).toEqual({ "task-a": "-" });
  expect(portsRecorded(record)).toEqual([]);
  succeeded(run(w, p.dir, ["create", "task-a"]));
  expect(portsRecorded(record)).toEqual([String(free[0])]);
  expect(ls(w, p.dir)).toEqual([
    { name: "task-a", state: "ready", branch: "task-a", path: p.path("task-a") },
  ]);
});

test("AC-36 init gives a registration with no block one", async () => {
  const w = world();
  const p = project(w);
  const record = join(w.root, "ports");
  script(w, p.dir, "worktree-setup.sh", portRecording(record));
  const path = p.path("task-a");
  mkdirSync(dirname(path), { recursive: true });
  git(w, p.dir, ["worktree", "add", "-q", path, "-b", "task-a"]);
  mkdirSync(join(p.dir, ".git", "agent-worktrees", "task-a"), { recursive: true });
  writeFileSync(join(p.dir, ".git", "agent-worktrees", "task-a", "ready"), "");
  expect(lsPorts(w, p.dir)).toEqual({ "task-a": "-" });
  const [first] = await freeBlocks();
  succeeded(run(w, path, ["init"]));
  expect(portsRecorded(record)).toEqual([String(first)]);
  expect(lsPorts(w, p.dir)).toEqual({ "task-a": blockText(first) });
});

test("AC-37 a worktree forced out past a failed teardown keeps its block until prune tears it down", async () => {
  const w = world();
  const p = project(w);
  const record = join(w.root, "ports");
  script(w, p.dir, "worktree-teardown.sh", "exit 3");
  const [first] = await freeBlocks();
  succeeded(run(w, p.dir, ["create", "task-a"]));
  succeeded(run(w, p.dir, ["remove", "--force", "task-a"]));
  expect(lsPorts(w, p.dir)).toEqual({ "task-a": blockText(first) });
  script(w, p.dir, "worktree-teardown.sh", portRecording(record));
  succeeded(run(w, p.dir, ["prune"]));
  expect(portsRecorded(record)).toEqual([String(first)]);
  succeeded(run(w, p.dir, ["create", "task-b"]));
  expect(lsPorts(w, p.dir)).toEqual({ "task-b": blockText(first) });
});
