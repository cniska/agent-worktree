import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { version } from "../package.json";
import {
  hookEvent,
  ls,
  project,
  refused,
  removeScratch,
  run,
  succeeded,
  usageRefused,
  world,
} from "./harness";

afterEach(removeScratch);

const REMOVE_USAGE = "agent-worktree remove [--force] <name>";

const LS_USAGE = "agent-worktree ls";

const INSTALL_USAGE =
  "agent-worktree install [--local] [--setup <command>] [--teardown <command>] [--ports <n>]";

const USAGES = [
  "agent-worktree create <name>",
  "agent-worktree init",
  REMOVE_USAGE,
  "agent-worktree prune",
  LS_USAGE,
  "agent-worktree path <name>",
  "agent-worktree hook",
  INSTALL_USAGE,
  "agent-worktree --version",
];

test("AC-24 results, refusals and usage errors exit 0, 1 and 2 with their output", () => {
  const w = world();
  const p = project(w);
  expect(run(w, p.dir, ["path", "task-a"])).toEqual({
    exitCode: 0,
    stdout: `${p.path("task-a")}\n`,
    stderr: "",
  });
  const outside = join(w.root, "outside");
  mkdirSync(outside);
  expect(run(w, outside, ["ls"])).toEqual({
    exitCode: 1,
    stdout: "",
    stderr: `agent-worktree ls: ${outside} is not inside a git checkout\n  cd into the project's checkout and run the command again\n`,
  });
  expect(usageRefused(run(w, p.dir, ["task-a"]), null)).toEqual({
    message: "task-a is not an agent-worktree command; agent-worktree with no command lists them",
    act: "agent-worktree create|init|remove|prune|ls|path|hook|install|--version",
  });
  expect(existsSync(p.path("task-a"))).toBe(false);
  const unknownOption = usageRefused(run(w, p.dir, ["remove", "--bogus", "task-a"]), "remove");
  expect(unknownOption.message).toStartWith("Unknown option '--bogus'");
  expect(unknownOption.act).toBe(REMOVE_USAGE);
  expect(usageRefused(run(w, p.dir, ["remove", "task-a", "task-b"]), "remove")).toEqual({
    message: "agent-worktree remove takes one worktree name, and got: task-a task-b",
    act: REMOVE_USAGE,
  });
  expect(usageRefused(run(w, p.dir, ["ls", "extra"]), "ls")).toEqual({
    message: "agent-worktree ls takes no argument, and got: extra",
    act: LS_USAGE,
  });
});

test("AC-25 the usage lists every command, or one with --help", () => {
  const w = world();
  const bare = run(w, w.root, []);
  expect({ exitCode: bare.exitCode, stderr: bare.stderr }).toEqual({ exitCode: 0, stderr: "" });
  const lines = succeeded(bare);
  expect(lines).toHaveLength(USAGES.length);
  lines.forEach((line, index) => {
    const usage = USAGES[index] ?? "";
    expect(line).toStartWith(`${usage} `);
    expect(line.slice(usage.length).trim()).not.toBe("");
  });
  expect(run(w, w.root, ["--help"])).toEqual(bare);
  const remove = run(w, w.root, ["remove", "--help"]);
  expect(remove).toEqual({ exitCode: 0, stdout: `${lines[2]}\n`, stderr: "" });
  expect(remove.stdout).toContain(
    "run teardown and remove the worktree; once its remote's default branch has the branch, delete it locally and, when it was pushed with an upstream, on that remote, keeping both copies when the upstream holds a commit the branch lacks",
  );
});

test("AC-26 each command reads state changed on disk since the last", () => {
  const w = world();
  const p = project(w);
  const path = p.path("task-a");
  succeeded(run(w, p.dir, ["create", "task-a"]));
  expect(ls(w, p.dir)).toEqual([{ name: "task-a", state: "ready", branch: "task-a", path }]);
  rmSync(path, { recursive: true });
  expect(ls(w, p.dir)).toEqual([{ name: "task-a", state: "orphaned (prune)", branch: "task-a", path }]);
  rmSync(join(p.dir, ".git", "agent-worktrees", "task-a"), { recursive: true });
  expect(ls(w, p.dir)).toEqual([]);
  expect(refused(run(w, p.dir, ["remove", "task-a"]), "remove").message).toBe(
    `task-a is not a registered worktree at ${path}`,
  );
});

test.todo("AC-27 the tests use scratch HOME and XDG directories", () => {});

test("AC-28 the commands work with the network unavailable", () => {
  const w = world();
  const p = project(w);
  const path = p.path("task-a");
  expect(succeeded(run(w, p.dir, ["path", "task-a"]))).toEqual([path]);
  expect(succeeded(run(w, p.dir, ["create", "task-a"]))).toEqual([path]);
  expect(succeeded(run(w, path, ["init"]))).toEqual([]);
  expect(ls(w, p.dir)).toEqual([{ name: "task-a", state: "ready", branch: "task-a", path }]);
  expect(succeeded(run(w, p.dir, ["remove", "task-a"]))).toEqual(["branch task-a kept, no remote origin"]);
  expect(succeeded(run(w, p.dir, ["prune"]))).toEqual([]);
  const stdin = hookEvent({ hook_event_name: "WorktreeCreate", name: "task-b" });
  expect(succeeded(run(w, p.dir, ["hook"], { stdin }))).toEqual([p.path("task-b")]);
});

test("AC-47 --version prints the version alone, and refuses an argument after it", () => {
  const w = world();
  expect(run(w, w.root, ["--version"])).toEqual({ exitCode: 0, stdout: `${version}\n`, stderr: "" });
  expect(usageRefused(run(w, w.root, ["--version", "now"]), null)).toEqual({
    message: "agent-worktree --version takes no argument, and got: now",
    act: "agent-worktree --version",
  });
});
