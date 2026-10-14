import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, project, refused, removeScratch, run, script, succeeded, world } from "./harness";

afterEach(removeScratch);

test("AC-16 a non-executable or unrunnable script is refused, and a project without scripts works", () => {
  const w = world();
  const bare = project(w);
  expect(succeeded(run(w, bare.dir, ["create", "task-a"]))).toEqual([bare.path("task-a")]);
  expect(succeeded(run(w, bare.dir, ["remove", "task-a"]))).toEqual(["branch task-a kept"]);
  expect(existsSync(bare.path("task-a"))).toBe(false);

  const v = world();
  const p = project(v);
  mkdirSync(join(p.dir, "scripts"));
  writeFileSync(join(p.dir, "scripts", "worktree-setup.sh"), "#!/bin/sh\nexit 0\n");
  git(v, p.dir, ["add", "scripts"]);
  git(v, p.dir, ["commit", "-q", "-m", "setup"]);
  const setup = join(p.path("task-b"), "scripts", "worktree-setup.sh");
  expect(refused(run(v, p.dir, ["create", "task-b"]), "create")).toEqual({
    message: `${setup} exists but is not executable`,
    act: `chmod +x ${setup}, or delete it when it is not needed, then run the command again`,
  });

  script(v, p.dir, "worktree-setup.sh", "exit 0");
  script(v, p.dir, "worktree-teardown.sh", "exit 0");
  writeFileSync(join(p.dir, "scripts", "worktree-teardown.sh"), "#!/nonexistent/interpreter\n");
  succeeded(run(v, p.dir, ["create", "task-c"]));
  const teardown = join(p.dir, "scripts", "worktree-teardown.sh");
  const unrunnable = refused(run(v, p.dir, ["remove", "task-c"]), "remove");
  expect(unrunnable.message).toStartWith(`${teardown} could not start: `);
  expect(unrunnable.act).toBe("fix the script's interpreter line, then run the command again");
  expect(existsSync(p.path("task-c"))).toBe(true);
});

test("AC-17 a setup script's stdout stays off the CLI's stdout", () => {
  const w = world();
  const p = project(w);
  script(w, p.dir, "worktree-setup.sh", "echo installing dependencies");
  const ran = run(w, p.dir, ["create", "task-a"]);
  expect(succeeded(ran)).toEqual([p.path("task-a")]);
  expect(ran.stderr).toContain("installing dependencies\n");
});
