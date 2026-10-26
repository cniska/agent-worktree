import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { firstFreeUnit, fixture, hookEvent, removeScratchDirs, repo, scratchDir } from "./repo.test-support";

const CLI = resolve(import.meta.dir, "cli.ts");

type Run = { readonly status: number | null; readonly stdout: string; readonly stderr: string };

function cli(cwd: string, args: readonly string[], stdin: string | null = null): Run {
  const run = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    input: stdin ?? undefined,
    env: { ...process.env, FORCE_COLOR: "3" },
  });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

afterAll(removeScratchDirs);

function toon(lines: readonly string[]): string {
  return `${lines.join("\n")}\n`;
}

describe("the cli", () => {
  test("lists the commands as a TOON table on stdout with --help and -h", () => {
    const dir = scratchDir();
    const help = cli(dir, ["--help"]);
    expect(help.status).toBe(0);
    expect(help.stderr).toBe("");
    expect(help.stdout).toStartWith(
      toon(["command: agent-worktree", "ok: true", "result:", "  commands[9]{usage,summary}:"]),
    );
    expect(help.stdout).toContain(
      '\n    "agent-worktree remove [--force] <name>","run teardown and remove the worktree;',
    );
    expect(help.stdout).toEndWith("\n    agent-worktree --version,print the version alone on one line\n");
    expect(cli(dir, ["-h"]).stdout).toBe(help.stdout);
  });

  test("describes one command with --help", () => {
    const run = cli(scratchDir(), ["ls", "--help"]);
    expect(run).toEqual({
      status: 0,
      stdout: toon([
        "command: ls",
        "ok: true",
        "result:",
        '  usage: "agent-worktree ls [--full]"',
        '  summary: "count the worktrees in each state and list each one\'s name, state and path, or with --full also its branch and port block"',
      ]),
      stderr: "",
    });
  });

  test("prints ls with no command", () => {
    const dir = repo();
    expect(cli(dir, [])).toEqual(cli(dir, ["ls"]));
  });

  test("refuses an unknown command with exit 2, without creating anything", () => {
    const { dir, path } = fixture();
    const run = cli(dir, ["task-a"]);
    expect(run).toEqual({
      status: 2,
      stdout: "",
      stderr: toon([
        "command: agent-worktree",
        "ok: false",
        "error:",
        "  kind: refusal",
        "  code: usage",
        "  message: task-a is not an agent-worktree command; agent-worktree --help lists them",
        "  meta:",
        "  resolve: agent-worktree create|init|remove|prune|ls|path|hook|install|--version",
      ]),
    });
    expect(existsSync(path("task-a"))).toBe(false);
  });

  test("prints a refusal on stderr as the TOON envelope, and exits 1", () => {
    const dir = scratchDir();
    expect(cli(dir, ["ls"])).toEqual({
      status: 1,
      stdout: "",
      stderr: toon([
        "command: ls",
        "ok: false",
        "error:",
        "  kind: refusal",
        "  code: not_a_checkout",
        `  message: ${dir} is not inside a git checkout`,
        "  meta:",
        `    cwd: ${dir}`,
        "  resolve: cd into the project's checkout and run the command again",
      ]),
    });
  });

  test("prints a usage refusal with the usage as the act, and exits 2", () => {
    const run = cli(scratchDir(), ["remove", "--bogus", "task-a"]);
    expect(run.status).toBe(2);
    expect(run.stderr).toStartWith(
      toon(["command: remove", "ok: false", "error:", "  kind: refusal", "  code: usage"]),
    );
    expect(run.stderr).toEndWith('\n  resolve: "agent-worktree remove [--force] <name>"\n');
    expect(cli(scratchDir(), ["remove", "a", "b"])).toEqual({
      status: 2,
      stdout: "",
      stderr: toon([
        "command: remove",
        "ok: false",
        "error:",
        "  kind: refusal",
        "  code: usage",
        '  message: "agent-worktree remove takes one worktree name, and got: a b"',
        "  meta:",
        '  resolve: "agent-worktree remove [--force] <name>"',
      ]),
    });
  });

  test("prints a result on stdout as the TOON envelope, and exits 0", () => {
    const { dir, path } = fixture();
    expect(cli(dir, ["path", "task-a"])).toEqual({
      status: 0,
      stdout: toon(["command: path", "ok: true", "result:", `  path: ${path("task-a")}`]),
      stderr: "",
    });
    expect(cli(dir, ["prune"])).toEqual({
      status: 0,
      stdout: toon(["command: prune", "ok: true", "result: null"]),
      stderr: "",
    });
  });

  test("ls prints every state at 0 and an empty list when there is nothing to list", () => {
    expect(cli(repo(), ["ls"])).toEqual({
      status: 0,
      stdout: toon([
        "command: ls",
        "ok: true",
        "result:",
        "  counts:",
        "    ready: 0",
        "    pending: 0",
        "    orphaned: 0",
        "    unlisted: 0",
        "    unmanaged: 0",
        "    legacy: 0",
        "  worktrees: []",
      ]),
      stderr: "",
    });
  });

  test("hook reads a WorktreeCreate event from stdin and prints only the path", async () => {
    const { dir, path } = fixture({ ports: 10 });
    const first = await firstFreeUnit();
    const run = cli(dir, ["hook"], hookEvent({ hook_event_name: "WorktreeCreate", name: "task-a" }));
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(`${path("task-a")}\n`);
    const ports = `${first}-${first + 9}`;
    expect(cli(dir, ["ls", "--full"]).stdout).toBe(
      toon([
        "command: ls",
        "ok: true",
        "result:",
        "  counts:",
        "    ready: 1",
        "    pending: 0",
        "    orphaned: 0",
        "    unlisted: 0",
        "    unmanaged: 0",
        "    legacy: 0",
        "  worktrees[1]{name,state,branch,ports,path}:",
        `    task-a,ready,task-a,${ports},${path("task-a")}`,
      ]),
    );
  });

  test("hook reads a WorktreeRemove event from stdin and removes by force, run from inside the worktree", () => {
    const { dir, path } = fixture();
    cli(dir, ["create", "task-a"]);
    writeFileSync(join(path("task-a"), "scratch"), "untracked");
    const run = cli(
      path("task-a"),
      ["hook"],
      hookEvent({ hook_event_name: "WorktreeRemove", worktree_path: path("task-a") }),
    );
    expect(run).toEqual({
      status: 0,
      stdout: "branch task-a kept, no remote origin\n",
      stderr: "",
    });
    expect(existsSync(path("task-a"))).toBe(false);
    expect(cli(dir, ["ls"]).stdout).toBe(
      toon([
        "command: ls",
        "ok: true",
        "result:",
        "  counts:",
        "    ready: 0",
        "    pending: 0",
        "    orphaned: 0",
        "    unlisted: 0",
        "    unmanaged: 0",
        "    legacy: 0",
        "  worktrees: []",
      ]),
    );
  });
});
