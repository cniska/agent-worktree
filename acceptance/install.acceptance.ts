import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  blockText,
  firstRun,
  freeUnits,
  git,
  HOOKS,
  installHook,
  lsPorts,
  printedPath,
  project,
  recorded,
  recording,
  removeScratchDirs,
  run,
  succeeded,
  usageRefused,
  world,
} from "./harness";

afterEach(removeScratchDirs);

const INSTALL_USAGE =
  "agent-worktree install [--local] [--setup <command>] [--teardown <command>] [--ports <n>]";

test("AC-44 install writes the hooks it is given, create and remove run them, and a reinstall keeps the rest", async () => {
  const w = world();
  const p = project(w);
  const setupRecord = join(w.root, "setup-record");
  const teardownRecord = join(w.root, "teardown-record");
  const quoted = join(w.root, "it's quoted");
  const setup = `${recording(setupRecord)}; echo "$WORKTREE_PORT" > '${quoted.replaceAll("'", "'\\''")}'`;
  const hooks = ["setup", "teardown", "ports"].map((hook) => join(p.dir, HOOKS, hook));
  expect(
    succeeded(
      run(w, p.dir, ["install", "--setup", setup, "--teardown", recording(teardownRecord), "--ports", "20"]),
    ),
  ).toEqual({ hooks });
  const [setupHook = "", teardownHook = "", portsHook = ""] = hooks;
  expect(readFileSync(setupHook, "utf8")).toContain(`command='${setup.replaceAll("'", "'\\''")}'`);
  expect(readFileSync(portsHook, "utf8")).toBe("20\n");
  git(w, p.dir, ["add", HOOKS]);
  git(w, p.dir, ["commit", "-q", "-m", "hooks"]);

  const first = firstRun(await freeUnits(), 2);
  const path = p.path("task-a");
  expect(printedPath(run(w, p.dir, ["create", "task-a"]))).toBe(path);
  expect(recorded(setupRecord)).toEqual([{ name: "task-a", path, primary: p.dir, cwd: path }]);
  expect(readFileSync(quoted, "utf8")).toBe(`${first}\n`);
  expect(lsPorts(w, p.dir)).toEqual({ "task-a": blockText(first, 20) });
  succeeded(run(w, p.dir, ["remove", "task-a"]));
  expect(recorded(teardownRecord)).toEqual([{ name: "task-a", path, primary: p.dir, cwd: p.dir }]);

  const byHand = spawnSync(setupHook, [], {
    cwd: p.dir,
    env: { PATH: "/usr/bin:/bin", WORKTREE_PRIMARY: p.dir },
    encoding: "utf8",
  });
  expect(byHand.status).toBe(0);
  expect(recorded(setupRecord).at(-1)).toEqual({ name: "unset", path: "unset", primary: p.dir, cwd: p.dir });

  const setupBefore = readFileSync(setupHook, "utf8");
  expect(succeeded(run(w, p.dir, ["install", "--teardown", "exit 0"]))).toEqual({ hooks: [teardownHook] });
  expect(readFileSync(teardownHook, "utf8")).toContain("command='exit 0'");
  expect(readFileSync(setupHook, "utf8")).toBe(setupBefore);
  expect(readFileSync(portsHook, "utf8")).toBe("20\n");
});

test("AC-45 install refuses no hook option, an empty command and a bad port count, and writes nothing", () => {
  const w = world();
  const p = project(w);
  for (const args of [[], ["--local"], ["--setup", ""], ["--ports", "0"], ["--ports", "ten"]]) {
    const refusal = usageRefused(run(w, p.dir, ["install", ...args]), "install");
    expect(refusal.act).toBe(INSTALL_USAGE);
  }
  expect(existsSync(join(p.dir, HOOKS))).toBe(false);
  expect(existsSync(join(p.dir, ".git", "worktree-hooks"))).toBe(false);
});

test("AC-46 install --local keeps the hooks in the git directory, and each local hook wins over the committed one", async () => {
  const w = world();
  const p = project(w);
  const committedRecord = join(w.root, "committed-record");
  const localRecord = join(w.root, "local-record");
  const teardownRecord = join(w.root, "teardown-record");
  installHook(w, p.dir, "setup", recording(committedRecord));
  installHook(w, p.dir, "teardown", recording(teardownRecord));
  const local = join(p.dir, ".git", "worktree-hooks");
  expect(
    succeeded(run(w, p.dir, ["install", "--local", "--setup", recording(localRecord), "--ports", "10"])),
  ).toEqual({ hooks: [join(local, "setup"), join(local, "ports")] });
  expect(git(w, p.dir, ["status", "--porcelain"])).toBe("");

  const [first] = await freeUnits();
  const path = p.path("task-a");
  expect(printedPath(run(w, p.dir, ["create", "task-a"]))).toBe(path);
  expect(recorded(localRecord)).toEqual([{ name: "task-a", path, primary: p.dir, cwd: path }]);
  expect(recorded(committedRecord)).toEqual([]);
  expect(lsPorts(w, p.dir)).toEqual({ "task-a": blockText(first) });

  const nested = p.path("task-b");
  expect(printedPath(run(w, path, ["create", "task-b"]))).toBe(nested);
  expect(recorded(localRecord).map(({ name }) => name)).toEqual(["task-a", "task-b"]);
  expect(recorded(committedRecord)).toEqual([]);

  succeeded(run(w, p.dir, ["remove", "task-a"]));
  expect(recorded(teardownRecord)).toEqual([{ name: "task-a", path, primary: p.dir, cwd: p.dir }]);
});
