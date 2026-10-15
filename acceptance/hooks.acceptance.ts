import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  freeUnits,
  git,
  HOOKS,
  installHook,
  launch,
  project,
  refused,
  removeScratch,
  requestPorts,
  run,
  succeeded,
  world,
} from "./harness";

afterEach(removeScratch);

const SET_BY_SH = new Set(["PWD", "SHLVL"]);

test("AC-16 a non-executable or unrunnable hook is refused, and a project without hooks works", () => {
  const w = world();
  const p = project(w);
  expect(succeeded(run(w, p.dir, ["create", "task-a"]))).toEqual([p.path("task-a")]);
  expect(succeeded(run(w, p.dir, ["remove", "task-a"]))).toEqual(["branch task-a kept, no remote origin"]);
  expect(existsSync(p.path("task-a"))).toBe(false);

  const setup = join(p.dir, HOOKS, "setup");
  mkdirSync(dirname(setup));
  writeFileSync(setup, "#!/bin/sh\nexit 0\n");
  git(w, p.dir, ["add", HOOKS]);
  git(w, p.dir, ["commit", "-q", "-m", "setup"]);
  const notExecutable = join(p.path("task-b"), HOOKS, "setup");
  expect(refused(run(w, p.dir, ["create", "task-b"]), "create")).toEqual({
    message: `${notExecutable} exists but is not executable`,
    act: `chmod +x ${notExecutable}, or delete it when it is not needed, then run the command again`,
  });

  writeFileSync(setup, "#!/nonexistent/interpreter\n");
  chmodSync(setup, 0o755);
  git(w, p.dir, ["add", HOOKS]);
  git(w, p.dir, ["commit", "-q", "-m", "interpreter"]);
  const unrunnable = refused(run(w, p.dir, ["create", "task-c"]), "create");
  expect(unrunnable.message).toStartWith(`${join(p.path("task-c"), HOOKS, "setup")} could not start: `);
  expect(unrunnable.act).toBe("fix the hook's interpreter line, then run the command again");
});

test("AC-17 a setup hook's stdout stays off the CLI's stdout", () => {
  const w = world();
  const p = project(w);
  installHook(w, p.dir, "setup", "echo installing dependencies");
  const ran = run(w, p.dir, ["create", "task-a"]);
  expect(succeeded(ran)).toEqual([p.path("task-a")]);
  expect(ran.stderr).toContain("installing dependencies\n");
});

test("AC-29 a hook run through the launcher gets the caller's environment and the FR-33 variables", async () => {
  const w = world();
  const p = project(w);
  const record = join(w.root, "env.json");
  const dump = `require("node:fs").writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.env))`;
  installHook(w, p.dir, "setup", `exec "${process.execPath}" -e '${dump}'`);
  requestPorts(w, p.dir, "10\n");
  const [block] = await freeUnits();
  const launched = launch(w, p.dir, ["create", "task-a"]);
  expect(succeeded(launched)).toEqual([p.path("task-a")]);
  const received = Object.entries(JSON.parse(readFileSync(record, "utf8")));
  expect(Object.fromEntries(received.filter(([name]) => !SET_BY_SH.has(name)))).toEqual({
    ...w.env,
    PATH: launched.callerPath,
    WORKTREE_NAME: "task-a",
    WORKTREE_PATH: p.path("task-a"),
    WORKTREE_PORT: String(block),
    WORKTREE_PRIMARY: p.dir,
  });
});
