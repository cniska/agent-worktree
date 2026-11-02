import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { removeScratchDirs, scratchDir } from "./repo.test-support";
import { type Fetch, updateNotice } from "./update";

type Channel = "homebrew" | "npm" | "bun" | "curl";

afterAll(removeScratchDirs);

const DAY_MS = 24 * 60 * 60 * 1000;

const NOW = Date.UTC(2026, 10, 2, 12);

const FORMULA_URL = "https://raw.githubusercontent.com/cniska/homebrew-tap/main/Formula/agent-worktree.rb";

const REGISTRY_URL = "https://registry.npmjs.org/@cniska/agent-worktree/latest";

const RELEASE_URL = "https://api.github.com/repos/cniska/agent-worktree/releases/latest";

const CURL_LINE =
  "curl -fsSL https://github.com/cniska/agent-worktree/releases/latest/download/install.sh | sh";

function formula(tag: string, otherTag = tag): string {
  return [
    "class AgentWorktree < Formula",
    "  on_macos do",
    `    url "https://github.com/cniska/agent-worktree/releases/download/${tag}/agent-worktree-darwin-arm64.tar.gz"`,
    "  end",
    "  on_linux do",
    `    url "https://github.com/cniska/agent-worktree/releases/download/${otherTag}/agent-worktree-linux-x64.tar.gz"`,
    "  end",
    "end",
  ].join("\n");
}

function executableAt(path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "");
  chmodSync(path, 0o755);
  return path;
}

type Install = {
  readonly home: string;
  readonly stateHome: string;
  readonly env: Record<string, string>;
  readonly executable: string;
};

function installed(channel: Channel): Install {
  const root = scratchDir();
  const home = join(root, "home");
  const stateHome = join(root, "state");
  const env = { HOME: home, XDG_STATE_HOME: stateHome };
  const at = {
    homebrew: join(root, "homebrew", "Cellar", "agent-worktree", "0.2.0", "bin", "agent-worktree"),
    npm: join(
      root,
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
      home,
      ".bun",
      "install",
      "global",
      "node_modules",
      "@cniska",
      "agent-worktree-linux-x64",
      "agent-worktree",
    ),
    curl: join(home, ".local", "bin", "agent-worktree"),
  }[channel];
  return { home, stateHome, env, executable: executableAt(at) };
}

const hanging: Fetch = async (_, { signal }) =>
  new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));

const failing: Fetch = async () => Promise.reject(new Error("offline"));

type Served = { readonly status: number; readonly body: string };

function serving(answers: Readonly<Record<string, Served>>): { fetch: Fetch; asked: string[] } {
  const asked: string[] = [];
  const fetch: Fetch = async (url) => {
    asked.push(url);
    const answer = answers[url];
    if (answer === undefined) throw new Error(`no answer for ${url}`);
    return new Response(answer.body, { status: answer.status });
  };
  return { fetch, asked };
}

const LATEST: Readonly<Record<string, Served>> = {
  [FORMULA_URL]: { status: 200, body: formula("v0.3.1") },
  [REGISTRY_URL]: { status: 200, body: JSON.stringify({ name: "@cniska/agent-worktree", version: "0.3.1" }) },
  [RELEASE_URL]: { status: 200, body: JSON.stringify({ tag_name: "v0.3.1" }) },
};

function stateFile(install: Install): string {
  return join(install.stateHome, "agent-worktree", "update-check.json");
}

async function noticeFor(
  install: Install,
  fetch: Fetch,
  {
    now = NOW,
    running = "0.3.0",
    env = {},
  }: { now?: number; running?: string; env?: Record<string, string> } = {},
): Promise<string | null> {
  return updateNotice({
    env: { ...install.env, ...env },
    executable: install.executable,
    running,
    now,
    fetch,
  });
}

function unplaced(
  executable: (root: string) => string,
): Promise<{ notice: string | null; asked: string[]; state: boolean }> {
  const root = scratchDir();
  const env = { HOME: join(root, "home"), XDG_STATE_HOME: join(root, "state") };
  const { fetch, asked } = serving(LATEST);
  return updateNotice({ env, executable: executable(root), running: "0.3.0", now: NOW, fetch }).then(
    (notice) => ({ notice, asked, state: existsSync(join(root, "state", "agent-worktree")) }),
  );
}

const NOTHING = { notice: null, asked: [], state: false };

describe("updateNotice", () => {
  test("follows the link Homebrew puts on PATH to the Cellar", async () => {
    const install = installed("homebrew");
    const link = join(scratchDir(), "bin", "agent-worktree");
    mkdirSync(dirname(link));
    symlinkSync(install.executable, link);
    const { fetch, asked } = serving(LATEST);
    expect(await noticeFor({ ...install, executable: link }, fetch)).toContain("brew upgrade agent-worktree");
    expect(asked).toEqual([FORMULA_URL]);
  });

  test("neither checks nor writes state for a Bun running the source, a binary placed by hand or a missing path", async () => {
    expect(await unplaced(() => process.execPath)).toEqual(NOTHING);
    expect(await unplaced((root) => executableAt(join(root, "opt", "agent-worktree")))).toEqual(NOTHING);
    expect(
      await unplaced((root) => executableAt(join(root, "Cellar", "bun", "1.0.0", "bin", "bun"))),
    ).toEqual(NOTHING);
    expect(await unplaced((root) => join(root, "gone", "agent-worktree"))).toEqual(NOTHING);
  });

  test("reads nothing from a formula whose url lines disagree, and counts it as the day's check", async () => {
    const install = installed("homebrew");
    const answers = { [FORMULA_URL]: { status: 200, body: formula("v0.3.1", "v0.3.0") } };
    const { fetch, asked } = serving(answers);
    expect(await noticeFor(install, fetch)).toBeNull();
    expect(await noticeFor(install, fetch, { now: NOW + 1 })).toBeNull();
    expect(asked).toEqual([FORMULA_URL]);
  });

  test("never asks where it cannot record the check, and leaves no partial file", async () => {
    const install = installed("npm");
    const dir = dirname(stateFile(install));
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o500);
    const { fetch, asked } = serving(LATEST);
    try {
      expect(await noticeFor(install, fetch)).toBeNull();
      expect(await noticeFor(install, fetch, { now: NOW + 1 })).toBeNull();
    } finally {
      chmodSync(dir, 0o700);
    }
    expect(asked).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  test.each<[Channel, string, string]>([
    ["homebrew", FORMULA_URL, "brew upgrade agent-worktree"],
    ["npm", REGISTRY_URL, "npm update -g @cniska/agent-worktree"],
    ["bun", REGISTRY_URL, "bun update -g @cniska/agent-worktree"],
    ["curl", RELEASE_URL, CURL_LINE],
  ])("asks a %s install's own channel and names its upgrade", async (channel, url, command) => {
    const install = installed(channel);
    const { fetch, asked } = serving(LATEST);
    expect(await noticeFor(install, fetch)).toBe(
      `agent-worktree 0.3.1 is out (running 0.3.0): run ${command}; if you cannot, tell the user.`,
    );
    expect(asked).toEqual([url]);
  });

  test("prints nothing when the running version is the latest or newer", async () => {
    const { fetch } = serving(LATEST);
    expect(await noticeFor(installed("npm"), fetch, { running: "0.3.1" })).toBeNull();
    expect(await noticeFor(installed("npm"), fetch, { running: "0.10.0" })).toBeNull();
  });

  test("compares each part as a number", async () => {
    const answers = { [REGISTRY_URL]: { status: 200, body: JSON.stringify({ version: "0.10.0" }) } };
    const { fetch } = serving(answers);
    expect(await noticeFor(installed("npm"), fetch, { running: "0.9.9" })).toContain("0.10.0 is out");
  });

  test.each<[Channel]>([["homebrew"], ["npm"], ["bun"], ["curl"]])(
    "checks a %s install once a day and prints the known latest on every command in between",
    async (channel) => {
      const install = installed(channel);
      const { fetch, asked } = serving(LATEST);
      const first = await noticeFor(install, fetch);
      expect(await noticeFor(install, fetch, { now: NOW + DAY_MS - 1 })).toBe(first);
      expect(asked).toHaveLength(1);
      expect(await noticeFor(install, fetch, { now: NOW + DAY_MS })).toBe(first);
      expect(asked).toHaveLength(2);
      expect(JSON.parse(readFileSync(stateFile(install), "utf8"))).toEqual({
        checked: NOW + DAY_MS,
        channel,
        latest: "0.3.1",
      });
    },
  );

  test.each<[string, Fetch]>([
    ["throws", async () => Promise.reject(new Error("offline"))],
    ["answers 500", async () => new Response("down", { status: 500 })],
    ["answers no version", async () => new Response(JSON.stringify({ version: "latest" }))],
    ["answers what is not JSON", async () => new Response("<html>")],
  ])("prints nothing when the channel %s, and counts it as the day's check", async (_, fetch) => {
    const install = installed("npm");
    let asked = 0;
    const counting: Fetch = async (url, init) => {
      asked += 1;
      return fetch(url, init);
    };
    expect(await noticeFor(install, counting)).toBeNull();
    expect(await noticeFor(install, counting, { now: NOW + 1 })).toBeNull();
    expect(asked).toBe(1);
  });

  test("gives up on a channel that does not answer within about a second", async () => {
    const install = installed("npm");
    const started = performance.now();
    expect(await noticeFor(install, hanging)).toBeNull();
    expect(performance.now() - started).toBeLessThan(2000);
    expect(existsSync(stateFile(install))).toBe(true);
  });

  test("keeps the latest it knew through a failed check, printing it from the next command", async () => {
    const install = installed("npm");
    await noticeFor(install, serving(LATEST).fetch);
    expect(await noticeFor(install, failing, { now: NOW + DAY_MS })).toBeNull();
    expect(await noticeFor(install, failing, { now: NOW + DAY_MS + 1 })).toContain("0.3.1 is out");
  });

  test("checks again when the install moved to another channel", async () => {
    const install = installed("npm");
    const { fetch, asked } = serving(LATEST);
    await noticeFor(install, fetch);
    const brew = installed("homebrew");
    expect(await noticeFor({ ...brew, env: install.env }, fetch, { now: NOW + 1 })).toContain("brew upgrade");
    expect(asked).toEqual([REGISTRY_URL, FORMULA_URL]);
  });

  test("checks again over a state file it cannot read", async () => {
    const install = installed("npm");
    mkdirSync(dirname(stateFile(install)), { recursive: true });
    writeFileSync(stateFile(install), "{");
    const { fetch, asked } = serving(LATEST);
    expect(await noticeFor(install, fetch)).toContain("0.3.1 is out");
    expect(asked).toHaveLength(1);
  });

  test("keeps the state under ~/.local/state when XDG_STATE_HOME is not absolute", async () => {
    const install = installed("npm");
    await noticeFor({ ...install, env: { HOME: install.home } }, serving(LATEST).fetch);
    expect(existsSync(join(install.home, ".local", "state", "agent-worktree", "update-check.json"))).toBe(
      true,
    );
  });

  test.each([["CI"], ["AGENT_WORKTREE_NO_UPDATE_CHECK"]])(
    "neither checks nor prints with %s set, even past a known newer version",
    async (variable) => {
      const install = installed("npm");
      await noticeFor(install, serving(LATEST).fetch);
      const { fetch, asked } = serving(LATEST);
      expect(await noticeFor(install, fetch, { env: { [variable]: "1" }, now: NOW + 1 })).toBeNull();
      expect(await noticeFor(install, fetch, { env: { [variable]: "1" }, now: NOW + DAY_MS })).toBeNull();
      expect(asked).toEqual([]);
    },
  );
});
