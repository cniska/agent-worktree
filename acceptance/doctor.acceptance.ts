import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decode, type JsonObject, type JsonValue } from "@toon-format/toon";
import {
  blockText,
  freeUnits,
  git,
  HOOKS,
  installHook,
  printedPath,
  project,
  type Ran,
  removeScratchDirs,
  repo,
  requestPorts,
  run,
  SYSTEM_PATH,
  succeeded,
  toolsOnly,
  type World,
  world,
} from "./harness";

afterEach(removeScratchDirs);

type Check = {
  readonly name: string;
  readonly state: string;
  readonly detail: string;
  readonly fix: string | null;
};

type Report = { readonly counts: JsonObject; readonly checks: readonly Check[] };

const RERUN = "then run agent-worktree doctor again";

function withCli(w: World): string {
  const bin = toolsOnly(w, ["git"]);
  writeFileSync(join(bin, "agent-worktree"), "#!/bin/sh\n");
  chmodSync(join(bin, "agent-worktree"), 0o755);
  return `${bin}:${SYSTEM_PATH}`;
}

function isRecord(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectOf(value: JsonValue | undefined): JsonObject {
  if (value === undefined || !isRecord(value)) throw new Error(`${JSON.stringify(value)} is not a record`);
  return value;
}

function textOf(value: JsonValue | undefined): string {
  if (typeof value !== "string") throw new Error(`${JSON.stringify(value)} is not a string`);
  return value;
}

function checkOf(value: JsonValue): Check {
  const record = objectOf(value);
  expect(Object.keys(record)).toEqual(["name", "state", "detail", "fix"]);
  return {
    name: textOf(record.name),
    state: textOf(record.state),
    detail: textOf(record.detail),
    fix: record.fix === null ? null : textOf(record.fix),
  };
}

function reportOf(ran: Ran, exitCode: number): Report {
  expect({ exitCode: ran.exitCode, stderr: ran.stderr }).toEqual({ exitCode, stderr: "" });
  const shown = objectOf(decode(ran.stdout));
  expect([shown.command, shown.ok]).toEqual(["doctor", true]);
  const result = objectOf(shown.result);
  expect(Object.keys(result)).toEqual(["counts", "checks"]);
  const { checks } = result;
  if (!Array.isArray(checks)) throw new Error(`${JSON.stringify(checks)} is not a list`);
  return { counts: objectOf(result.counts), checks: checks.map(checkOf) };
}

function doctor(w: World, cwd: string, path: string, args: readonly string[] = []): Ran {
  return run(w, cwd, ["doctor", ...args], { env: { PATH: path } });
}

test("AC-58 doctor in a sound project prints no check, and with --full every check ok with a null fix", async () => {
  const w = world();
  const p = project(w);
  const path = withCli(w);
  installHook(w, p.dir, "setup", "exit 0");
  requestPorts(w, p.dir, "10\n");
  const [first] = await freeUnits();
  succeeded(run(w, p.dir, ["create", "task-a"]));
  expect(reportOf(doctor(w, p.dir, path), 0)).toEqual({ counts: { ok: 9, warn: 0, fail: 0 }, checks: [] });
  const full = reportOf(doctor(w, p.dir, path, ["--full"]), 0);
  expect(full.counts).toEqual({ ok: 9, warn: 0, fail: 0 });
  expect(full.checks.map(({ name, state, fix }) => [name, state, fix])).toEqual([
    ["git", "ok", null],
    ["agent-worktree", "ok", null],
    ["port blocks", "ok", null],
    ["project", "ok", null],
    ["setup hook", "ok", null],
    ["teardown hook", "ok", null],
    ["ports hook", "ok", null],
    ["task-a worktree", "ok", null],
    ["task-a ports", "ok", null],
  ]);
  expect(full.checks.at(-1)?.detail).toBe(
    `holds port block ${blockText(first)} for the 10 ports its project asks for`,
  );
});

test("AC-59 doctor warns without agent-worktree on PATH, and fails without git, leaving the project unchecked", () => {
  const w = world();
  const dir = repo(w);
  const bin = toolsOnly(w, ["git"]);
  const noCli = reportOf(doctor(w, dir, `${bin}:${SYSTEM_PATH}`), 0);
  expect(noCli.checks).toEqual([
    {
      name: "agent-worktree",
      state: "warn",
      detail: `not found in ${bin}, ${SYSTEM_PATH.split(":").join(", ")}; the plugin's WorktreeCreate and WorktreeRemove hooks run agent-worktree hook, so without it every Claude Code worktree fails to create`,
      fix: `install agent-worktree on the PATH Claude Code starts with, ${RERUN} under that PATH`,
    },
  ]);
  const empty = join(w.root, "empty");
  mkdirSync(empty);
  const noGit = reportOf(doctor(w, dir, empty), 1);
  expect(noGit.counts).toEqual({ ok: 1, warn: 2, fail: 1 });
  expect(noGit.checks.map(({ name, state, detail }) => [name, state, detail])).toEqual([
    ["git", "fail", `not found in ${empty}; every agent-worktree command runs git`],
    [
      "agent-worktree",
      "warn",
      `not found in ${empty}; the plugin's WorktreeCreate and WorktreeRemove hooks run agent-worktree hook, so without it every Claude Code worktree fails to create`,
    ],
    ["project", "warn", "unchecked: git is not on PATH"],
  ]);
});

test("AC-60 doctor outside a checkout warns, and fails a setup hook that cannot run and a ports hook that holds no count", () => {
  const w = world();
  const path = withCli(w);
  const outside = join(w.root, "outside");
  mkdirSync(outside);
  expect(reportOf(doctor(w, outside, path), 0).checks).toEqual([
    {
      name: "project",
      state: "warn",
      detail: `${outside} is not inside a git checkout, so no project check ran`,
      fix: "run agent-worktree doctor in the project's checkout to check its hooks and worktrees",
    },
  ]);
  const p = project(w);
  installHook(w, p.dir, "setup", "exit 0");
  const setup = join(p.dir, HOOKS, "setup");
  chmodSync(setup, 0o644);
  requestPorts(w, p.dir, "ten\n");
  const ports = join(p.dir, HOOKS, "ports");
  const broken = reportOf(doctor(w, p.dir, path), 1);
  expect(broken.counts).toEqual({ ok: 5, warn: 0, fail: 2 });
  expect(broken.checks).toEqual([
    {
      name: "setup hook",
      state: "fail",
      detail: `${setup} exists but is not executable`,
      fix: `chmod +x ${setup}, or delete it when it is not needed, then run the command again`,
    },
    {
      name: "ports hook",
      state: "fail",
      detail: `${ports} must hold one whole number of ports from 1 to 1000, and holds: "ten\\n"`,
      fix: `run agent-worktree install --ports <n> in ${p.dir} with the number of ports the worktree needs, or delete ${ports} when it needs none, then run the command again`,
    },
  ]);
});

test("AC-61 doctor warns of a pending, an orphaned, an unlisted and an unmanaged worktree, and passes once each act is done", () => {
  const w = world();
  const p = project(w);
  const path = withCli(w);
  succeeded(run(w, p.dir, ["create", "task-b"]));
  succeeded(run(w, p.dir, ["create", "task-c"]));
  rmSync(p.path("task-b"), { recursive: true });
  git(w, p.dir, ["worktree", "remove", "--force", p.path("task-c")]);
  mkdirSync(p.path("task-c"));
  mkdirSync(p.path("task-d"));
  installHook(w, p.dir, "setup", "exit 1");
  expect(run(w, p.dir, ["create", "task-a"]).exitCode).toBe(1);
  const report = reportOf(doctor(w, p.dir, path), 0);
  expect(report.counts).toEqual({ ok: 7, warn: 4, fail: 0 });
  expect(report.checks).toEqual([
    {
      name: "task-a worktree",
      state: "warn",
      detail: `its setup has not finished at ${p.path("task-a")}`,
      fix: `run agent-worktree create task-a to resume its setup, ${RERUN}`,
    },
    {
      name: "task-b worktree",
      state: "warn",
      detail: "task-b is registered but its worktree is gone, so its teardown never ran",
      fix: "run agent-worktree prune, then the command again",
    },
    {
      name: "task-c worktree",
      state: "warn",
      detail: `task-c is registered but git does not list ${p.path("task-c")} as a worktree`,
      fix: "remove the directory, then agent-worktree prune",
    },
    {
      name: "task-d worktree",
      state: "warn",
      detail: `${p.path("task-d")} exists but agent-worktree did not create it`,
      fix: `remove it yourself, with git worktree remove ${p.path("task-d")} when git lists it, or pick another name`,
    },
  ]);
  succeeded(run(w, p.path("task-a"), ["install", "--setup", "exit 0"]));
  succeeded(run(w, p.dir, ["create", "task-a"]));
  rmSync(p.path("task-c"), { recursive: true });
  rmSync(p.path("task-d"), { recursive: true });
  succeeded(run(w, p.dir, ["prune"]));
  expect(reportOf(doctor(w, p.dir, path), 0).checks).toEqual([]);
});

test("AC-62 doctor warns of a block a deleted clone holds and of one that no longer fits, changing neither, and passes after prune and init", async () => {
  const w = world();
  const path = withCli(w);
  const gone = repo(w, join(w.root, "clones", "gone"));
  requestPorts(w, gone, "10\n");
  const kept = repo(w, join(w.root, "clones", "kept"));
  requestPorts(w, kept, "10\n");
  const [first, second] = await freeUnits();
  succeeded(run(w, gone, ["create", "task-a"]));
  const worktree = printedPath(run(w, kept, ["create", "task-a"]));
  rmSync(gone, { recursive: true, force: true });
  writeFileSync(join(worktree, HOOKS, "ports"), "20\n");
  const expected = [
    {
      name: "port blocks",
      state: "warn",
      detail: `${blockText(first)} is held by ${join(gone, ".git", "agent-worktrees", "task-a")}, which is gone`,
      fix: `run agent-worktree prune in any project's checkout, which frees every such block, ${RERUN}`,
    },
    {
      name: "task-a ports",
      state: "warn",
      detail: `holds port block ${blockText(second)}, which is not one run of the 20 ports its project asks for`,
      fix: `run agent-worktree init in ${worktree}, ${RERUN}`,
    },
  ];
  expect(reportOf(doctor(w, kept, path), 0).checks).toEqual(expected);
  expect(reportOf(doctor(w, kept, path), 0).checks).toEqual(expected);
  succeeded(run(w, kept, ["prune"]));
  succeeded(run(w, worktree, ["init"]));
  expect(reportOf(doctor(w, kept, path), 0).checks).toEqual([]);
});
