import { describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { dataDir } from "./paths";

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

  test("reads a scratch home and data directory in every test, never the account's", () => {
    for (const variable of ["HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME"]) {
      expect(process.env[variable]).not.toStartWith(userInfo().homedir);
      expect(process.env[variable]).toStartWith(realpathSync(tmpdir()));
    }
    expect(dataDir()).toBe(join(process.env.XDG_DATA_HOME ?? "", "agent-worktree"));
  });
});
