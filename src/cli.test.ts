import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { firstFreeBlock, fixture, hookEvent, removeScratchDirs, repo, scratchDir } from "./repo.test-support";

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

describe("the cli", () => {
  test("lists the commands on stdout with no arguments and with --help", () => {
    const dir = scratchDir();
    const bare = cli(dir, []);
    expect(bare.status).toBe(0);
    expect(bare.stderr).toBe("");
    expect(bare.stdout).toContain("agent-worktree create <name>");
    expect(bare.stdout).toContain("agent-worktree remove [--force] <name>");
    expect(cli(dir, ["--help"]).stdout).toBe(bare.stdout);
  });

  test("describes one command with --help", () => {
    const run = cli(scratchDir(), ["remove", "--help"]);
    expect(run.status).toBe(0);
    expect(run.stdout).toStartWith("agent-worktree remove [--force] <name>");
    expect(run.stdout).toContain("run teardown and remove the worktree");
  });

  test("refuses an unknown command with exit 2, without creating anything", () => {
    const { dir, path } = fixture();
    const run = cli(dir, ["task-a"]);
    expect(run.status).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe(
      "agent-worktree: task-a is not an agent-worktree command; agent-worktree with no command lists them\n  agent-worktree create|init|remove|prune|ls|path|hook\n",
    );
    expect(existsSync(path("task-a"))).toBe(false);
  });

  test("prints a refusal on stderr as the command, the message and the act, and exits 1", () => {
    const dir = scratchDir();
    expect(cli(dir, ["ls"])).toEqual({
      status: 1,
      stdout: "",
      stderr: `agent-worktree ls: ${dir} is not inside a git checkout\n  cd into the project's checkout and run the command again\n`,
    });
  });

  test("prints a usage refusal with the usage as the act, and exits 2", () => {
    const run = cli(scratchDir(), ["remove", "--bogus", "task-a"]);
    expect(run.status).toBe(2);
    expect(run.stderr).toStartWith("agent-worktree remove: Unknown option '--bogus'.");
    expect(run.stderr).toEndWith("\n  agent-worktree remove [--force] <name>\n");
    expect(cli(scratchDir(), ["remove", "a", "b"])).toEqual({
      status: 2,
      stdout: "",
      stderr:
        "agent-worktree remove: agent-worktree remove takes one worktree name, and got: a b\n  agent-worktree remove [--force] <name>\n",
    });
  });

  test("prints a result on stdout and exits 0", () => {
    const { dir, path } = fixture();
    expect(cli(dir, ["path", "task-a"])).toEqual({
      status: 0,
      stdout: `${path("task-a")}\n`,
      stderr: "",
    });
  });

  test("ls keeps stdout empty and notes on stderr when there is nothing to list", () => {
    expect(cli(repo(), ["ls"])).toEqual({
      status: 0,
      stdout: "",
      stderr: "agent-worktree: no task worktrees\n",
    });
  });

  test("hook reads a WorktreeCreate event from stdin and prints only the path", async () => {
    const { dir, path } = fixture();
    const first = await firstFreeBlock();
    const run = cli(dir, ["hook"], hookEvent({ hook_event_name: "WorktreeCreate", name: "task-a" }));
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(`${path("task-a")}\n`);
    const ports = `${first}-${first + 9}`;
    expect(cli(dir, ["ls"]).stdout).toBe(`task-a\tready\ttask-a\t${ports}\t${path("task-a")}\n`);
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
      stdout: "branch task-a kept, no default branch tracked for origin\n",
      stderr: "",
    });
    expect(existsSync(path("task-a"))).toBe(false);
    expect(cli(dir, ["ls"])).toEqual({
      status: 0,
      stdout: "",
      stderr: "agent-worktree: no task worktrees\n",
    });
  });
});
