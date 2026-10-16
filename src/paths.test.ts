import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { dataDir, resolvedPath } from "./paths";
import { removeScratchDirs, scratchDir } from "./repo.test-support";

afterAll(removeScratchDirs);

describe("dataDir", () => {
  test("lives under an absolute XDG_DATA_HOME", () => {
    expect(dataDir({ HOME: "/home/a", XDG_DATA_HOME: "/data" })).toBe("/data/agent-worktree");
  });

  test.each([
    ["unset", undefined],
    ["empty", ""],
    ["relative", "data"],
  ])("falls back to HOME/.local/share when XDG_DATA_HOME is %s", (_, value) => {
    expect(dataDir({ HOME: "/home/a", XDG_DATA_HOME: value })).toBe("/home/a/.local/share/agent-worktree");
  });

  test.each([
    ["unset", undefined],
    ["empty", ""],
    ["whitespace", "  "],
  ])("falls back to the account's home when HOME is %s", (_, value) => {
    expect(dataDir({ HOME: value })).toBe(join(homedir(), ".local", "share", "agent-worktree"));
  });

  test("reads process.env when no env is given", () => {
    expect(dataDir()).toBe(join(process.env.XDG_DATA_HOME ?? "", "agent-worktree"));
  });
});

describe("resolvedPath", () => {
  test("resolves each symlink in the part that exists and keeps the rest as written", () => {
    const root = scratchDir();
    mkdirSync(join(root, "real"));
    symlinkSync(join(root, "real"), join(root, "link"));
    expect(resolvedPath(join(root, "link"))).toBe(join(root, "real"));
    expect(resolvedPath(join(root, "link", "made-up", "task-a"))).toBe(
      join(root, "real", "made-up", "task-a"),
    );
    expect(resolvedPath(join(root, "absent", "task-a"))).toBe(join(root, "absent", "task-a"));
  });
});
