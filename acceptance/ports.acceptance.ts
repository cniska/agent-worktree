import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  bareRemote,
  blockText,
  firstRun,
  freeUnits,
  git,
  HOOKS,
  holding,
  installHook,
  ls,
  lsPorts,
  onLoopback,
  portRecording,
  portsRecorded,
  printedPath,
  project,
  refused,
  removed,
  removeScratchDirs,
  repo,
  requestPorts,
  run,
  runAsync,
  runAtOnce,
  succeeded,
  world,
} from "./harness";

afterEach(removeScratchDirs);

test("AC-30 each worktree gets the lowest free block as WORKTREE_PORT, shown by ls; the primary gets none", async () => {
  const w = world();
  const p = project(w);
  requestPorts(w, p.dir, "10\n");
  const record = join(w.root, "ports");
  installHook(w, p.dir, "setup", portRecording(record));
  const [first, second] = await freeUnits();
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
  requestPorts(w, p.dir, "10\n");
  const record = join(w.root, "ports");
  installHook(w, p.dir, "teardown", portRecording(record));
  const [first] = await freeUnits();
  succeeded(run(w, p.dir, ["create", "task-a"]));
  succeeded(run(w, p.dir, ["create", "task-b"]));
  expect(removed(run(w, p.dir, ["remove", "task-a"]))).toEqual({
    name: "task-a",
    branch: "task-a",
    outcome: "no_remote",
    remote: "origin",
  });
  expect(portsRecorded(record)).toEqual([String(first)]);
  succeeded(run(w, p.dir, ["create", "task-c"]));
  expect(lsPorts(w, p.dir)["task-c"]).toBe(blockText(first));
});

test("AC-32 a block with a port another program listens on, on any address, is skipped, seen by connecting", async () => {
  const w = world();
  const p = project(w);
  requestPorts(w, p.dir, "10\n");
  const [first, second, third] = await freeUnits();
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
  requestPorts(w, gone, "10\n");
  const kept = repo(w, join(w.root, "clones", "kept"));
  requestPorts(w, kept, "10\n");
  const [first, second] = await freeUnits();
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

test("AC-34 creates started at once each get a block of their own, and inits of one worktree at once agree on one", async () => {
  const w = world();
  const p = project(w);
  requestPorts(w, p.dir, "20\n");
  const names = ["task-a", "task-b", "task-c", "task-d", "task-e", "task-f"];
  const ran = await runAtOnce(
    w,
    p.dir,
    names.map((name) => ["create", name]),
  );
  expect(ran.map(printedPath)).toEqual(names.map(p.path));
  const spans = Object.values(lsPorts(w, p.dir))
    .map((text) => (text ?? "").split("-").map(Number))
    .toSorted(([a = 0], [b = 0]) => a - b);
  expect(spans.map(([first = 0, last = 0]) => last - first)).toEqual(names.map(() => 19));
  expect(spans.every(([first = 0], index) => index === 0 || first > (spans[index - 1]?.[1] ?? 0))).toBe(true);
  const path = p.path("task-a");
  const record = join(w.root, "ports");
  installHook(w, path, "setup", portRecording(record));
  requestPorts(w, path, "30\n");
  const inits = await runAtOnce(w, path, [["init"], ["init"]]);
  for (const each of inits) succeeded(each);
  const [first, second] = portsRecorded(record);
  expect(portsRecorded(record)).toHaveLength(2);
  expect(first).toBe(second);
  expect(lsPorts(w, p.dir)["task-a"]).toBe(blockText(Number(first), 30));
});

test("AC-35 with no free block create refuses and keeps setup pending, then resumes once one is free", async () => {
  const w = world();
  const p = project(w);
  requestPorts(w, p.dir, "10\n");
  const record = join(w.root, "ports");
  installHook(w, p.dir, "setup", portRecording(record));
  const free = await freeUnits();
  const ran = await holding(onLoopback(free), () => runAsync(w, p.dir, ["create", "task-a"]));
  expect(refused(ran, "create")).toEqual({
    message:
      "no block of 10 ports from 24000 to 24999 is free for task-a: worktrees hold some and other programs listen on the rest; setup is pending",
    act: "remove a worktree you are done with, fix a teardown that failed for a worktree that is gone, or run agent-worktree prune in another clone whose gone worktrees hold blocks, then run the command again",
  });
  expect(ls(w, p.dir)).toEqual([
    { name: "task-a", state: "pending", branch: "task-a", path: p.path("task-a") },
  ]);
  expect(lsPorts(w, p.dir)).toEqual({ "task-a": null });
  expect(portsRecorded(record)).toEqual([]);
  succeeded(run(w, p.dir, ["create", "task-a"]));
  expect(portsRecorded(record)).toEqual([String(free[0])]);
  expect(ls(w, p.dir)).toEqual([
    { name: "task-a", state: "ready", branch: "task-a", path: p.path("task-a") },
  ]);
});

test("AC-43 with no free block create first removes a worktree whose branch landed and takes its block", async () => {
  const w = world();
  const p = project(w);
  requestPorts(w, p.dir, "10\n");
  const record = join(w.root, "ports");
  installHook(w, p.dir, "setup", portRecording(record));
  const teardown = join(w.root, "teardown");
  installHook(w, p.dir, "teardown", `touch "${teardown}"`);
  bareRemote(w, p.dir);
  const free = await freeUnits();
  succeeded(run(w, p.dir, ["create", "task-a"]));
  const landed = p.path("task-a");
  writeFileSync(join(landed, "work"), "work\n");
  git(w, landed, ["add", "work"]);
  git(w, landed, ["commit", "-q", "-m", "work"]);
  git(w, landed, ["push", "-q", "-u", "origin", "task-a"]);
  git(w, landed, ["push", "-q", "origin", "task-a:main"]);
  const ran = await holding(onLoopback(free.slice(1)), () => runAsync(w, p.dir, ["create", "task-b"]));
  expect(printedPath(ran)).toBe(p.path("task-b"));
  expect(existsSync(teardown)).toBe(true);
  expect(existsSync(landed)).toBe(false);
  expect(portsRecorded(record)).toEqual([String(free[0]), String(free[0])]);
  expect(lsPorts(w, p.dir)).toEqual({ "task-b": blockText(free[0], 10) });
});

test("AC-43 a landed worktree git refuses to remove is noted with why, and create still refuses for want of a block", async () => {
  const w = world();
  const p = project(w);
  requestPorts(w, p.dir, "10\n");
  installHook(w, p.dir, "teardown", 'touch "$WORKTREE_PATH/left"');
  bareRemote(w, p.dir);
  const free = await freeUnits();
  succeeded(run(w, p.dir, ["create", "task-a"]));
  const landed = p.path("task-a");
  writeFileSync(join(landed, "work"), "work\n");
  git(w, landed, ["add", "work"]);
  git(w, landed, ["commit", "-q", "-m", "work"]);
  git(w, landed, ["push", "-q", "-u", "origin", "task-a"]);
  git(w, landed, ["push", "-q", "origin", "task-a:main"]);
  const ran = await holding(onLoopback(free.slice(1)), () => runAsync(w, p.dir, ["create", "task-b"]));
  expect(refused(ran, "create").message).toStartWith("no block of 10 ports");
  expect(ran.stderr).toContain(
    `agent-worktree: worktree task-a not removed, though its branch landed: git worktree remove ${landed} refused: `,
  );
  expect(existsSync(join(landed, "left"))).toBe(true);
  expect(lsPorts(w, p.dir)).toEqual({ "task-a": blockText(free[0], 10), "task-b": null });
});

test("AC-36 init gives a registration with no block one, resizes it to a changed request, mends a broken one and frees it when the request goes", async () => {
  const w = world();
  const p = project(w);
  requestPorts(w, p.dir, "10\n");
  const record = join(w.root, "ports");
  installHook(w, p.dir, "setup", portRecording(record));
  const path = p.path("task-a");
  mkdirSync(dirname(path), { recursive: true });
  git(w, p.dir, ["worktree", "add", "-q", path, "-b", "task-a"]);
  mkdirSync(join(p.dir, ".git", "agent-worktrees", "task-a"), { recursive: true });
  writeFileSync(join(p.dir, ".git", "agent-worktrees", "task-a", "ready"), "");
  expect(lsPorts(w, p.dir)).toEqual({ "task-a": null });
  const free = await freeUnits();
  const [first] = free;
  succeeded(run(w, path, ["init"]));
  expect(portsRecorded(record)).toEqual([String(first)]);
  expect(lsPorts(w, p.dir)).toEqual({ "task-a": blockText(first) });
  requestPorts(w, path, "30\n");
  succeeded(run(w, path, ["init"]));
  const three = firstRun(free, 3);
  expect(lsPorts(w, p.dir)).toEqual({ "task-a": blockText(three, 30) });
  rmSync(join(w.data, "ports", String(three + 10)));
  expect(lsPorts(w, p.dir)).toEqual({ "task-a": `${blockText(three)},${blockText(three + 20)}` });
  succeeded(run(w, path, ["init"]));
  expect(lsPorts(w, p.dir)).toEqual({ "task-a": blockText(three, 30) });
  rmSync(join(path, HOOKS, "ports"));
  succeeded(run(w, path, ["init"]));
  expect(lsPorts(w, p.dir)).toEqual({ "task-a": null });
});

test("AC-37 a worktree forced out past a failed teardown keeps its block until prune tears it down", async () => {
  const w = world();
  const p = project(w);
  requestPorts(w, p.dir, "10\n");
  const record = join(w.root, "ports");
  installHook(w, p.dir, "teardown", "exit 3");
  const [first] = await freeUnits();
  succeeded(run(w, p.dir, ["create", "task-a"]));
  succeeded(run(w, p.dir, ["remove", "--force", "task-a"]));
  expect(lsPorts(w, p.dir)).toEqual({ "task-a": blockText(first) });
  installHook(w, p.dir, "teardown", portRecording(record));
  succeeded(run(w, p.dir, ["prune"]));
  expect(portsRecorded(record)).toEqual([String(first)]);
  succeeded(run(w, p.dir, ["create", "task-b"]));
  expect(lsPorts(w, p.dir)).toEqual({ "task-b": blockText(first) });
});

test("AC-38 create takes over the block of a worktree whose directory is gone, running its teardown first", async () => {
  const w = world();
  const p = project(w);
  requestPorts(w, p.dir, "10\n");
  const record = join(w.root, "ports");
  installHook(w, p.dir, "teardown", portRecording(record));
  const [first] = await freeUnits();
  succeeded(run(w, p.dir, ["create", "task-a"]));
  rmSync(p.path("task-a"), { recursive: true, force: true });
  const created = run(w, p.dir, ["create", "task-b"]);
  succeeded(created);
  expect(created.stderr).toContain(
    `agent-worktree: port block ${blockText(first)} freed from task-a, whose worktree is gone\n`,
  );
  expect(portsRecorded(record)).toEqual([String(first)]);
  expect(lsPorts(w, p.dir)).toEqual({ "task-b": blockText(first) });
});

test("AC-38 a gone worktree whose teardown fails keeps its block, and create takes the next", async () => {
  const w = world();
  const p = project(w);
  requestPorts(w, p.dir, "10\n");
  installHook(w, p.dir, "teardown", "exit 3");
  const [first, second] = await freeUnits();
  succeeded(run(w, p.dir, ["create", "task-a"]));
  rmSync(p.path("task-a"), { recursive: true, force: true });
  succeeded(run(w, p.dir, ["create", "task-b"]));
  expect(lsPorts(w, p.dir)).toEqual({ "task-a": blockText(first), "task-b": blockText(second) });
});

test("AC-39 create takes over a deleted clone's block without a prune", async () => {
  const w = world();
  const gone = repo(w, join(w.root, "clones", "gone"));
  requestPorts(w, gone, "10\n");
  const kept = repo(w, join(w.root, "clones", "kept"));
  requestPorts(w, kept, "10\n");
  const [first] = await freeUnits();
  succeeded(run(w, gone, ["create", "task-a"]));
  rmSync(gone, { recursive: true, force: true });
  const created = run(w, kept, ["create", "task-a"]);
  succeeded(created);
  expect(created.stderr).toContain(
    `agent-worktree: port block ${blockText(first)} freed from ${join(gone, ".git", "agent-worktrees", "task-a")}, which is gone\n`,
  );
  expect(lsPorts(w, kept)).toEqual({ "task-a": blockText(first) });
});

test("AC-41 a project gets ports only when it asks, as many as it asks for", async () => {
  const w = world();
  const p = project(w);
  const record = join(w.root, "ports");
  installHook(w, p.dir, "setup", portRecording(record));
  const free = await freeUnits();
  const plain = await holding(onLoopback(free), () => runAsync(w, p.dir, ["create", "task-a"]));
  expect(printedPath(plain)).toBe(p.path("task-a"));
  expect(lsPorts(w, p.dir)).toEqual({ "task-a": null });
  expect(portsRecorded(record)).toEqual(["unset"]);
  requestPorts(w, p.dir, "20\n");
  const first = firstRun(free, 2);
  succeeded(run(w, p.dir, ["create", "task-b"]));
  expect(portsRecorded(record)).toEqual(["unset", String(first)]);
  expect(lsPorts(w, p.dir)["task-b"]).toBe(blockText(first, 20));
  requestPorts(w, p.dir, "ten\n");
  const file = join(p.path("task-c"), HOOKS, "ports");
  expect(refused(run(w, p.dir, ["create", "task-c"]), "create")).toEqual({
    message: `${file} must hold one whole number of ports from 1 to 1000, and holds: "ten\\n"`,
    act: `run agent-worktree install --ports <n> in ${p.path("task-c")} with the number of ports the worktree needs, or delete ${file} when it needs none, then run the command again`,
  });
  expect(ls(w, p.dir).find(({ name }) => name === "task-c")?.state).toBe("pending");
  expect(lsPorts(w, p.dir)["task-c"]).toBeNull();
});
