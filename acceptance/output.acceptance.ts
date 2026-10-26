import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { version } from "../package.json";
import {
  hookEvent,
  ls,
  printedLines,
  printedPath,
  project,
  refused,
  removed,
  removeScratchDirs,
  run,
  runProgram,
  succeeded,
  usageRefused,
  world,
} from "./harness";

afterEach(removeScratchDirs);

const SCRATCH_VARIABLES = ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"];

const REMOVE_USAGE = "agent-worktree remove [--force] <name>";

const LS_USAGE = "agent-worktree ls [--full]";

const INSTALL_USAGE =
  "agent-worktree install [--local] [--setup <command>] [--teardown <command>] [--ports <n>]";

const USAGES = [
  "agent-worktree create [--from <ref>] <name>",
  "agent-worktree init",
  REMOVE_USAGE,
  "agent-worktree prune",
  LS_USAGE,
  "agent-worktree path <name>",
  "agent-worktree hook",
  INSTALL_USAGE,
  "agent-worktree --version",
];

test("AC-24 results, refusals and usage errors exit 0, 1 and 2 with their TOON envelope", () => {
  const w = world();
  const p = project(w);
  expect(run(w, p.dir, ["path", "task-a"])).toEqual({
    exitCode: 0,
    stdout: `command: path\nok: true\nresult:\n  path: ${p.path("task-a")}\n`,
    stderr: "",
  });
  const outside = join(w.root, "outside");
  mkdirSync(outside);
  expect(run(w, outside, ["path", "task-a"])).toEqual({
    exitCode: 1,
    stdout: "",
    stderr: [
      "command: path",
      "ok: false",
      "error:",
      "  kind: refusal",
      "  code: not_a_checkout",
      `  message: ${outside} is not inside a git checkout`,
      "  meta:",
      `    cwd: ${outside}`,
      "  resolve: cd into the project's checkout and run the command again",
      "",
    ].join("\n"),
  });
  expect(usageRefused(run(w, p.dir, ["task-a"]), null)).toEqual({
    message: "task-a is not an agent-worktree command; agent-worktree --help lists them",
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

test("AC-25 --help lists every command, or one with <command> --help", () => {
  const w = world();
  const help = run(w, w.root, ["--help"]);
  expect({ exitCode: help.exitCode, stderr: help.stderr }).toEqual({ exitCode: 0, stderr: "" });
  expect(help.stdout).toStartWith(
    "command: agent-worktree\nok: true\nresult:\n  commands[9]{usage,summary}:\n",
  );
  expect(succeeded(help)).toEqual({
    commands: USAGES.map((usage) => ({ usage, summary: expect.stringMatching(/\S/) })),
  });
  expect(run(w, w.root, ["-h"])).toEqual(help);
  const remove = run(w, w.root, ["remove", "--help"]);
  expect({ exitCode: remove.exitCode, stderr: remove.stderr }).toEqual({ exitCode: 0, stderr: "" });
  expect(remove.stdout).toStartWith("command: remove\nok: true\nresult:\n");
  const described = {
    usage: REMOVE_USAGE,
    summary:
      "run teardown and remove the worktree; once its remote's default branch has the branch, delete it locally and on that remote, its upstream or, with none, its same-name branch on origin other than the default branch, keeping both copies when the remote branch holds a commit the branch lacks",
  };
  expect(succeeded(remove)).toEqual(described);
  expect(help.stdout).toContain(`  "${described.usage}","${described.summary}"\n`);
});

test("AC-26 each command reads state changed on disk since the last", () => {
  const w = world();
  const p = project(w);
  const path = p.path("task-a");
  succeeded(run(w, p.dir, ["create", "task-a"]));
  expect(ls(w, p.dir)).toEqual([{ name: "task-a", state: "ready", branch: "task-a", path }]);
  rmSync(path, { recursive: true });
  expect(ls(w, p.dir)).toEqual([{ name: "task-a", state: "orphaned", branch: "task-a", path }]);
  rmSync(join(p.dir, ".git", "agent-worktrees", "task-a"), { recursive: true });
  expect(ls(w, p.dir)).toEqual([]);
  expect(refused(run(w, p.dir, ["remove", "task-a"]), "remove").message).toBe(
    `task-a is not a registered worktree at ${path}`,
  );
});

function within(dir: string, path: string): boolean {
  return path === dir || path.startsWith(`${dir}/`);
}

function scratchVariables(
  env: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  return Object.fromEntries(SCRATCH_VARIABLES.map((variable) => [variable, env[variable] ?? "unset"]));
}

function environmentOf(lines: readonly string[]): Readonly<Record<string, string>> {
  return Object.fromEntries(
    lines.map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
}

test("AC-27 the test environment's HOME and XDG directories are scratch directories, not the account's", () => {
  const account = realpathSync(userInfo().homedir);
  const placed = (root: string) => (path: string) => ({
    path,
    inAccountHome: within(account, path),
    inScratch: within(root, path),
  });
  const preloaded = Object.values(scratchVariables(process.env)).map((path) =>
    existsSync(path) ? realpathSync(path) : path,
  );
  expect(preloaded.map(placed(realpathSync(tmpdir())))).toEqual(
    preloaded.map((path) => ({ path, inAccountHome: false, inScratch: true })),
  );
  const w = world();
  const seen = Object.values(
    scratchVariables(environmentOf(printedLines(runProgram(w, w.root, ["/usr/bin/env"], {})))),
  );
  expect(seen.map(placed(w.root))).toEqual(
    seen.map((path) => ({ path, inAccountHome: false, inScratch: true })),
  );
  const p = project(w);
  const path = printedPath(run(w, p.dir, ["path", "task-a"]));
  expect(placed(w.root)(path)).toEqual({ path, inAccountHome: false, inScratch: true });
});

test("AC-28 the commands work with the network unavailable", () => {
  const w = world();
  const p = project(w);
  const path = p.path("task-a");
  expect(printedPath(run(w, p.dir, ["path", "task-a"]))).toBe(path);
  expect(printedPath(run(w, p.dir, ["create", "task-a"]))).toBe(path);
  expect(succeeded(run(w, path, ["init"]))).toBeNull();
  expect(ls(w, p.dir)).toEqual([{ name: "task-a", state: "ready", branch: "task-a", path }]);
  expect(removed(run(w, p.dir, ["remove", "task-a"]))).toEqual({
    name: "task-a",
    branch: "task-a",
    outcome: "no_remote",
    remote: "origin",
  });
  expect(succeeded(run(w, p.dir, ["prune"]))).toBeNull();
  const stdin = hookEvent({ hook_event_name: "WorktreeCreate", name: "task-b" });
  expect(printedLines(run(w, p.dir, ["hook"], { stdin }))).toEqual([p.path("task-b")]);
});

test("AC-47 --version prints the version alone, and refuses an argument after it", () => {
  const w = world();
  expect(run(w, w.root, ["--version"])).toEqual({ exitCode: 0, stdout: `${version}\n`, stderr: "" });
  expect(usageRefused(run(w, w.root, ["--version", "now"]), null)).toEqual({
    message: "agent-worktree --version takes no argument, and got: now",
    act: "agent-worktree --version",
  });
});
