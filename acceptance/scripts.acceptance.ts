import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { git, launch, project, refused, removeScratch, run, script, succeeded, world } from "./harness";

afterEach(removeScratch);

const SET_BY_SH = new Set(["PWD", "SHLVL"]);

test("AC-16 a non-executable or unrunnable script is refused, and a project without scripts works", () => {
  const w = world();
  const p = project(w);
  expect(succeeded(run(w, p.dir, ["create", "task-a"]))).toEqual([p.path("task-a")]);
  expect(succeeded(run(w, p.dir, ["remove", "task-a"]))).toEqual(["branch task-a kept"]);
  expect(existsSync(p.path("task-a"))).toBe(false);

  const setup = join(p.dir, "scripts", "worktree-setup.sh");
  mkdirSync(dirname(setup));
  writeFileSync(setup, "#!/bin/sh\nexit 0\n");
  git(w, p.dir, ["add", "scripts"]);
  git(w, p.dir, ["commit", "-q", "-m", "setup"]);
  const notExecutable = join(p.path("task-b"), "scripts", "worktree-setup.sh");
  expect(refused(run(w, p.dir, ["create", "task-b"]), "create")).toEqual({
    message: `${notExecutable} exists but is not executable`,
    act: `chmod +x ${notExecutable}, or delete it when it is not needed, then run the command again`,
  });

  writeFileSync(setup, "#!/nonexistent/interpreter\n");
  chmodSync(setup, 0o755);
  git(w, p.dir, ["add", "scripts"]);
  git(w, p.dir, ["commit", "-q", "-m", "interpreter"]);
  const unrunnable = refused(run(w, p.dir, ["create", "task-c"]), "create");
  expect(unrunnable.message).toStartWith(
    `${join(p.path("task-c"), "scripts", "worktree-setup.sh")} could not start: `,
  );
  expect(unrunnable.act).toBe("fix the script's interpreter line, then run the command again");
});

test("AC-17 a setup script's stdout stays off the CLI's stdout", () => {
  const w = world();
  const p = project(w);
  script(w, p.dir, "worktree-setup.sh", "echo installing dependencies");
  const ran = run(w, p.dir, ["create", "task-a"]);
  expect(succeeded(ran)).toEqual([p.path("task-a")]);
  expect(ran.stderr).toContain("installing dependencies\n");
});

test("AC-29 a script run through the launcher gets the caller's environment and the FR-33 variables", () => {
  const w = world();
  const p = project(w);
  const record = join(w.root, "env.json");
  const dump = `require("node:fs").writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.env))`;
  script(w, p.dir, "worktree-setup.sh", `exec "${process.execPath}" -e '${dump}'`);
  expect(succeeded(launch(w, p.dir, ["create", "task-a"]))).toEqual([p.path("task-a")]);
  const received = Object.entries(JSON.parse(readFileSync(record, "utf8")));
  expect(Object.fromEntries(received.filter(([name]) => !SET_BY_SH.has(name)))).toEqual({
    ...w.env,
    PATH: `${join(w.root, "mise-bin")}:${w.env.PATH}`,
    WORKTREE_NAME: "task-a",
    WORKTREE_PATH: p.path("task-a"),
    WORKTREE_PRIMARY: p.dir,
  });
});
