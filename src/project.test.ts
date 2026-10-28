import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { nameAt, parseName, resolveProject, worktreePath, worktreesDir } from "./project";
import { git, projectAt, refusal, removeScratchDirs, repo, scratchDir } from "./repo.test-support";

afterAll(removeScratchDirs);

describe("resolveProject", () => {
  test("resolves the primary from inside it and from inside one of its worktrees", () => {
    const dir = repo();
    const worktree = join(dir, ".claude", "worktrees", "task-a");
    git(dir, ["worktree", "add", "-q", worktree, "-b", "task-a"]);
    expect(resolveProject(dir)).toEqual(projectAt(dir));
    expect(resolveProject(worktree)).toEqual(projectAt(dir));
  });

  test("refuses a checkout whose git directory is not the primary's .git, such as a submodule", () => {
    const dir = repo();
    const sub = repo();
    git(dir, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "vendored"]);
    const refused = refusal(() => resolveProject(join(dir, "vendored")));
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
    const refused = refusal(() => resolveProject(join(base, "repo")));
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

describe("worktreesDir", () => {
  test("is one key under the data directory, the same from the primary and from its worktrees", () => {
    const dir = repo();
    const worktree = join(dir, ".claude", "worktrees", "task-a");
    git(dir, ["worktree", "add", "-q", worktree, "-b", "task-a"]);
    const key = worktreesDir(resolveProject(dir));
    expect(dirname(key)).toBe(join(process.env.XDG_DATA_HOME ?? "", "agent-worktree"));
    expect(basename(key)).toMatch(/^repo-[0-9a-f]{8}$/);
    expect(worktreesDir(resolveProject(worktree))).toBe(key);
    expect(worktreesDir(resolveProject(dir))).toBe(key);
  });

  test("tells apart two clones that share a directory name", () => {
    const first = repo();
    const second = repo();
    expect(basename(first)).toBe(basename(second));
    expect(worktreesDir(projectAt(first))).not.toBe(worktreesDir(projectAt(second)));
  });

  test("keeps every worktree outside the primary checkout", () => {
    const dir = repo();
    expect(worktreePath(projectAt(dir), "task-a").startsWith(`${dir}/`)).toBe(false);
  });
});

describe("nameAt", () => {
  test("reads a name at its path and at the earlier location inside the primary", () => {
    const current = projectAt(repo());
    const name = parseName(current, "task-a");
    expect(nameAt(current, worktreePath(current, name))).toBe(name);
    expect(nameAt(current, join(current.primary, ".claude", "worktrees", "task-a"))).toBe(name);
    expect(nameAt(current, join(current.primary, "elsewhere", "task-a"))).toBeNull();
  });
});
