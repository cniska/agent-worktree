import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { install } from "./hooks";
import { removeScratchDirs, scratchDir } from "./repo.test-support";

afterEach(removeScratchDirs);

const MODE_BITS = 0o777;

function modeOf(path: string): number {
  return statSync(path).mode & MODE_BITS;
}

describe("install", () => {
  test("writes each hook it is given as plain shell, quoting the command", () => {
    const checkout = scratchDir();
    const written = install(checkout, {
      setup: "echo 'it''s' && mise install",
      teardown: "docker compose down",
      ports: { ports: 20, unitCount: 2 },
    });
    const dir = join(checkout, ".worktree-hooks");
    expect(written).toEqual([join(dir, "setup"), join(dir, "teardown"), join(dir, "ports")]);
    expect(readFileSync(join(dir, "setup"), "utf8")).toBe(
      `#!/bin/sh\nset -eu\n\ncommand='echo '\\''it'\\'''\\''s'\\'' && mise install'\n\nexec sh -ec "$command"\n`,
    );
    expect(readFileSync(join(dir, "teardown"), "utf8")).toBe(
      `#!/bin/sh\nset -eu\n\ncommand='docker compose down'\n\nexec sh -ec "$command"\n`,
    );
    expect(readFileSync(join(dir, "ports"), "utf8")).toBe("20\n");
    expect([modeOf(join(dir, "setup")), modeOf(join(dir, "teardown")), modeOf(join(dir, "ports"))]).toEqual([
      0o755, 0o755, 0o644,
    ]);
  });

  test("leaves every hook it is not given as it is, and makes the one it rewrites runnable", () => {
    const checkout = scratchDir();
    const dir = join(checkout, ".worktree-hooks");
    mkdirSync(dir);
    writeFileSync(join(dir, "setup"), "kept\n");
    writeFileSync(join(dir, "ports"), "10\n");
    writeFileSync(join(dir, "teardown"), "old\n");
    chmodSync(join(dir, "teardown"), 0o600);
    expect(install(checkout, { setup: null, teardown: "exit 0", ports: null })).toEqual([
      join(dir, "teardown"),
    ]);
    expect(readFileSync(join(dir, "setup"), "utf8")).toBe("kept\n");
    expect(readFileSync(join(dir, "ports"), "utf8")).toBe("10\n");
    expect(modeOf(join(dir, "teardown"))).toBe(0o755);
  });
});
