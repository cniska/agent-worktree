import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  git,
  installHook,
  ls,
  printedPath,
  project,
  type Ran,
  refused,
  removeScratchDirs,
  run,
  runProgram,
  SYSTEM_PATH,
  succeeded,
  toolsOnly,
  type World,
  world,
} from "./harness";

afterEach(removeScratchDirs);

const UNSAFE_CONFIG = '[hooks]\npostinstall = "true"\n';

const READS_CONFIG = "mise config ls >/dev/null";

function mise(w: World, cwd: string, args: readonly string[]): Ran {
  const ran = runProgram(w, cwd, ["mise", ...args], {});
  expect({ args, exitCode: ran.exitCode, stderr: ran.stderr }).toMatchObject({ exitCode: 0 });
  return ran;
}

function trust(w: World, dir: string): void {
  mise(w, dir, ["trust", "--quiet", dir]);
}

function trusted(w: World, dir: string): boolean {
  return mise(w, dir, ["trust", "--show"]).stdout.split("\n").includes(`${dir}: trusted`);
}

function commitFile(w: World, checkout: string, file: string, text: string): void {
  mkdirSync(join(checkout, file, ".."), { recursive: true });
  writeFileSync(join(checkout, file), text);
  git(w, checkout, ["add", file]);
  git(w, checkout, ["commit", "-q", "-m", file]);
}

function trustLines(ran: Ran): readonly string[] {
  return ran.stderr.split("\n").filter((line) => line.includes("mise trust"));
}

test("AC-57 create and init trust a worktree's mise config that matches its trusted primary, before setup", () => {
  const w = world();
  const p = project(w);
  commitFile(w, p.dir, "mise.toml", UNSAFE_CONFIG);
  commitFile(w, p.dir, ".config/mise/conf.d/extra.toml", UNSAFE_CONFIG);
  installHook(w, p.dir, "setup", READS_CONFIG);

  expect(refused(run(w, p.dir, ["create", "task-a"]), "create").message).toStartWith(
    `${join(p.path("task-a"), ".worktree-hooks", "setup")} exited 1`,
  );
  expect(trusted(w, p.path("task-a"))).toBe(false);
  expect(refused(run(w, p.dir, ["create", "task-b"]), "create").message).toContain("exited 1");

  trust(w, p.dir);
  const trustedNote = (name: string) => [
    `agent-worktree: mise trusted ${p.path(name)}, as it trusts ${p.dir}`,
  ];
  const pending = run(w, p.dir, ["create", "task-a"]);
  expect(printedPath(pending)).toBe(p.path("task-a"));
  expect(trustLines(pending)).toEqual(trustedNote("task-a"));
  expect(trusted(w, p.path("task-a"))).toBe(true);

  const init = run(w, p.path("task-b"), ["init"]);
  succeeded(init);
  expect(trustLines(init)).toEqual(trustedNote("task-b"));
  expect(trusted(w, p.path("task-b"))).toBe(true);

  const created = run(w, p.dir, ["create", "task-c"]);
  expect(printedPath(created)).toBe(p.path("task-c"));
  expect(trustLines(created)).toEqual(trustedNote("task-c"));
  expect(trusted(w, p.path("task-c"))).toBe(true);
  const primaryInit = run(w, p.dir, ["init"]);
  succeeded(primaryInit);
  expect(trustLines(primaryInit)).toEqual([]);
  expect(ls(w, p.dir).map(({ name, state }) => [name, state])).toEqual([
    ["task-a", "ready"],
    ["task-b", "ready"],
    ["task-c", "ready"],
  ]);
});

test("AC-57 a worktree whose mise config differs from its trusted primary's stays untrusted", () => {
  const w = world();
  const p = project(w);
  commitFile(w, p.dir, "mise.toml", UNSAFE_CONFIG);
  installHook(w, p.dir, "setup", READS_CONFIG);
  trust(w, p.dir);
  git(w, p.dir, ["switch", "-q", "-c", "changed"]);
  commitFile(w, p.dir, "mise.toml", '[hooks]\npostinstall = "echo changed"\n');
  git(w, p.dir, ["switch", "-q", "main"]);
  expect(refused(run(w, p.dir, ["create", "changed"]), "create").message).toContain("exited 1");
  expect(trusted(w, p.path("changed"))).toBe(false);

  git(w, p.dir, ["switch", "-q", "-c", "added"]);
  commitFile(w, p.dir, ".mise.local.toml", UNSAFE_CONFIG);
  git(w, p.dir, ["switch", "-q", "main"]);
  expect(refused(run(w, p.dir, ["create", "added"]), "create").message).toContain("exited 1");
  expect(trusted(w, p.path("added"))).toBe(false);
});

test("AC-57 create trusts nothing without mise, without config, or with an untrusted primary, and names a failed trust", () => {
  const w = world();
  const p = project(w);
  const bare = run(w, p.dir, ["create", "no-config"]);
  expect(printedPath(bare)).toBe(p.path("no-config"));
  expect(trustLines(bare)).toEqual([]);

  commitFile(w, p.dir, "mise.toml", UNSAFE_CONFIG);
  const untrusted = run(w, p.dir, ["create", "untrusted"]);
  expect(printedPath(untrusted)).toBe(p.path("untrusted"));
  expect(trustLines(untrusted)).toEqual([]);
  expect(trusted(w, p.path("untrusted"))).toBe(false);

  trust(w, p.dir);
  const noMise = run(w, p.dir, ["create", "no-mise"], {
    env: { PATH: `${toolsOnly(w, ["git"])}:${SYSTEM_PATH}` },
  });
  expect(printedPath(noMise)).toBe(p.path("no-mise"));
  expect(trustLines(noMise)).toEqual([]);
  expect(trusted(w, p.path("no-mise"))).toBe(false);

  const trustList = join(w.root, "state", "mise", "trusted-configs");
  chmodSync(trustList, 0o555);
  try {
    const failed = run(w, p.dir, ["create", "failed"]);
    expect(printedPath(failed)).toBe(p.path("failed"));
    expect(trustLines(failed)).toEqual([
      `agent-worktree: mise could not trust ${p.path("failed")}, so it is untrusted: run mise trust ${p.path("failed")}`,
    ]);
  } finally {
    chmodSync(trustList, 0o755);
  }
  expect(trusted(w, p.path("failed"))).toBe(false);
});
