import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseName, project } from "./project";
import { git, projectAt, refusal, removeScratchDirs, repo, scratchDir } from "./repo.test-support";

afterAll(removeScratchDirs);

describe("project", () => {
  test("resolves the primary from inside it and from inside one of its worktrees", () => {
    const dir = repo();
    const worktree = join(dir, ".claude", "worktrees", "task-a");
    git(dir, ["worktree", "add", "-q", worktree, "-b", "task-a"]);
    expect(project(dir)).toEqual(projectAt(dir));
    expect(project(worktree)).toEqual(projectAt(dir));
  });

  test("refuses a checkout whose git directory is not the primary's .git, such as a submodule", () => {
    const dir = repo();
    const sub = repo();
    git(dir, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "vendored"]);
    const refused = refusal(() => project(join(dir, "vendored")));
    expect(refused.code).toBe("unsupported_layout");
    expect(refused.message).toBe(
      `${join(dir, ".git", "modules", "vendored")} is not a .git directory inside the primary checkout`,
    );
    expect(refused.resolve).toBe(
      "run agent-worktree in a plain clone; a submodule, a bare repository and a separate git dir are not supported",
    );
  });

  test("refuses a checkout whose git directory lives elsewhere", () => {
    const base = scratchDir();
    const elsewhere = join(base, "elsewhere", ".git");
    mkdirSync(join(base, "elsewhere"));
    git(base, ["init", "-q", `--separate-git-dir=${elsewhere}`, join(base, "repo")]);
    const refused = refusal(() => project(join(base, "repo")));
    expect(refused.code).toBe("unsupported_layout");
    expect(refused.message).toBe(`${elsewhere} is not a .git directory inside the primary checkout`);
  });
});

describe("parseName", () => {
  test.each([".", "..", "-x", "x.lock", "a/b", "a b"])("refuses %s as a worktree name", (raw) => {
    const refused = refusal(() => parseName(projectAt(repo()), raw));
    expect(refused.code).toBe("invalid_name");
    expect(refused.message).toBe(`${raw} is not a worktree name`);
  });
});
