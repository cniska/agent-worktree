import { afterEach, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { version } from "../package.json";
import {
  compiledBinary,
  hookEvent,
  project,
  type RunOptions,
  removeScratchDirs,
  runBinary,
  UPDATE_CHECK_OFF,
  type World,
  world,
} from "./harness";

afterEach(removeScratchDirs);

const BUILD_TIMEOUT_MS = 60_000;

const NEWER = "99.0.0";

const MINUTE_MS = 60 * 1000;

const DAY_MS = 24 * 60 * MINUTE_MS;

const CHECK_ON: RunOptions = { unset: [UPDATE_CHECK_OFF] };

const CURL_LINE =
  "curl -fsSL https://github.com/cniska/agent-worktree/releases/latest/download/install.sh | sh";

type Channel = "homebrew" | "npm" | "bun" | "curl";

const UPGRADES: Readonly<Record<Channel, string>> = {
  homebrew: "brew upgrade agent-worktree",
  npm: "npm update -g @cniska/agent-worktree",
  bun: "bun update -g @cniska/agent-worktree",
  curl: CURL_LINE,
};

function placedAs(w: World, binary: string, channel: Channel): string {
  const at: Record<Channel, string> = {
    homebrew: join(w.root, "homebrew", "Cellar", "agent-worktree", version, "bin", "agent-worktree"),
    npm: join(
      w.root,
      "npm",
      "lib",
      "node_modules",
      "@cniska",
      "agent-worktree",
      "node_modules",
      "@cniska",
      "agent-worktree-darwin-arm64",
      "agent-worktree",
    ),
    bun: join(
      w.home,
      ".bun",
      "install",
      "global",
      "node_modules",
      "@cniska",
      "agent-worktree-darwin-arm64",
      "agent-worktree",
    ),
    curl: join(w.home, ".local", "bin", "agent-worktree"),
  };
  return placedAt(binary, at[channel]);
}

function placedAt(binary: string, path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  copyFileSync(binary, path);
  return path;
}

function stateFile(w: World): string {
  return join(w.root, "state", "agent-worktree", "update-check.json");
}

function knowing(w: World, channel: Channel, checked: number): string {
  mkdirSync(dirname(stateFile(w)), { recursive: true });
  const state = `${JSON.stringify({ checked, channel, latest: NEWER })}\n`;
  writeFileSync(stateFile(w), state);
  return state;
}

function lineFor(channel: Channel): string {
  return `agent-worktree ${NEWER} is out (running ${version}): run ${UPGRADES[channel]}; if you cannot, tell the user.\n`;
}

const CHANNELS: readonly Channel[] = ["homebrew", "npm", "bun", "curl"];

function built(w: World): string {
  return compiledBinary(join(w.root, "build"));
}

test(
  "AC-63 a Homebrew, npm, bun and curl install that knows a newer version prints the line first on stderr, with stdout and the exit code as without it",
  () => {
    const w = world();
    const binary = built(w);
    for (const channel of CHANNELS) {
      const installed = placedAs(w, binary, channel);
      knowing(w, channel, Date.now() - MINUTE_MS);

      expect(runBinary(w, w.root, installed, ["--version"], CHECK_ON)).toEqual({
        exitCode: 0,
        stdout: `${version}\n`,
        stderr: lineFor(channel),
      });
      const refused = runBinary(w, w.root, installed, ["ls"], CHECK_ON);
      expect(refused).toMatchObject({ exitCode: 1, stdout: "" });
      expect(refused.stderr).toStartWith(`${lineFor(channel)}command: ls\nok: false\nerror:\n`);
      expect(refused.stderr).toContain("code: not_a_checkout");
    }
  },
  BUILD_TIMEOUT_MS,
);

test(
  "AC-64 no line prints with CI or the off switch set, under hook, or from a binary placed by hand",
  () => {
    const w = world();
    const p = project(w);
    const binary = built(w);
    const installed = placedAs(w, binary, "curl");
    knowing(w, "curl", Date.now() - MINUTE_MS);

    expect(w.env[UPDATE_CHECK_OFF]).toBe("1");
    expect(runBinary(w, w.root, installed, ["--version"]).stderr).toBe("");
    expect(runBinary(w, w.root, installed, ["--version"], { ...CHECK_ON, env: { CI: "true" } }).stderr).toBe(
      "",
    );
    const created = runBinary(w, p.dir, installed, ["hook"], {
      ...CHECK_ON,
      stdin: hookEvent({ hook_event_name: "WorktreeCreate", name: "task-a" }),
    });
    expect(created).toMatchObject({ exitCode: 0, stdout: `${p.path("task-a")}\n` });
    expect(created.stderr).not.toContain("is out");

    const elsewhere = placedAt(binary, join(w.root, "opt", "agent-worktree"));
    const stale = knowing(w, "curl", Date.now() - DAY_MS);
    expect(runBinary(w, w.root, elsewhere, ["--version"], CHECK_ON).stderr).toBe("");
    expect(readFileSync(stateFile(w), "utf8")).toBe(stale);
  },
  BUILD_TIMEOUT_MS,
);

test(
  "AC-65 a day-old check that cannot reach its channel prints nothing, counts as the day's check and keeps the version it knew",
  () => {
    const w = world();
    const installed = placedAs(w, built(w), "curl");
    knowing(w, "curl", Date.now() - DAY_MS);
    const started = Date.now();

    expect(runBinary(w, w.root, installed, ["--version"], CHECK_ON)).toEqual({
      exitCode: 0,
      stdout: `${version}\n`,
      stderr: "",
    });
    const recorded: unknown = JSON.parse(readFileSync(stateFile(w), "utf8"));
    expect(recorded).toEqual({ checked: expect.any(Number), channel: "curl", latest: NEWER });
    expect(Reflect.get(Object(recorded), "checked")).toBeGreaterThanOrEqual(started);
    expect(runBinary(w, w.root, installed, ["--version"], CHECK_ON).stderr).toBe(lineFor("curl"));
  },
  BUILD_TIMEOUT_MS,
);
