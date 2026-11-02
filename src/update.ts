import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homeDir, resolvedPath, stateDir } from "./paths";

type Env = Readonly<Record<string, string | undefined>>;

export type Fetch = (url: string, init: { readonly signal: AbortSignal }) => Promise<Response>;

export type UpdateCheck = {
  readonly env: Env;
  readonly executable: string;
  readonly running: string;
  readonly now: number;
  readonly fetch: Fetch;
};

type Version = readonly [number, number, number];

type JsonObject = { readonly [key: string]: unknown };

type ChannelSource = {
  readonly source: string;
  readonly latestIn: (response: Response) => Promise<string | null>;
  readonly upgrade: string;
};

const TOOL = "agent-worktree";

const PACKAGE = `@cniska/${TOOL}`;

const OFF_SWITCHES = ["CI", "AGENT_WORKTREE_NO_UPDATE_CHECK"] as const;

const CHECK_TIMEOUT_MS = 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

const STATE_FILE = "update-check.json";

const HOMEBREW_CELLAR = `/Cellar/${TOOL}/`;

const PLATFORM_BUILD = new RegExp(`/node_modules/${PACKAGE}-[a-z0-9]+-[a-z0-9]+/${TOOL}$`);

const BUN_GLOBAL = "/install/global/node_modules/";

const CURL_INSTALL = [".local", "bin", TOOL] as const;

const REGISTRY_LATEST = `https://registry.npmjs.org/${PACKAGE}/latest`;

const INSTALLER = `https://github.com/cniska/${TOOL}/releases/latest/download/install.sh`;

const FORMULA_URL_LINE = /^\s*url "([^"]+)"/gm;

const RELEASE_DOWNLOAD = new RegExp(`/cniska/${TOOL}/releases/download/(v[^/]+)/`);

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)$/;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonObject(value: unknown): JsonObject | null {
  return isJsonObject(value) ? value : null;
}

function stringField(value: unknown, field: string): string | null {
  const read = jsonObject(value)?.[field];
  return typeof read === "string" ? read : null;
}

function formulaTag(formula: string): string | null {
  const tags = [...formula.matchAll(FORMULA_URL_LINE)].map(
    (match) => RELEASE_DOWNLOAD.exec(match[1] ?? "")?.[1] ?? null,
  );
  const [first = null] = tags;
  return tags.every((tag) => tag === first) ? first : null;
}

async function registryLatest(response: Response): Promise<string | null> {
  return stringField(await response.json(), "version");
}

const CHANNELS = {
  homebrew: {
    source: `https://raw.githubusercontent.com/cniska/homebrew-tap/main/Formula/${TOOL}.rb`,
    latestIn: async (response) => formulaTag(await response.text()),
    upgrade: `brew upgrade ${TOOL}`,
  },
  npm: { source: REGISTRY_LATEST, latestIn: registryLatest, upgrade: `npm update -g ${PACKAGE}` },
  bun: { source: REGISTRY_LATEST, latestIn: registryLatest, upgrade: `bun update -g ${PACKAGE}` },
  curl: {
    source: `https://api.github.com/repos/cniska/${TOOL}/releases/latest`,
    latestIn: async (response) => stringField(await response.json(), "tag_name"),
    upgrade: `curl -fsSL ${INSTALLER} | sh`,
  },
} as const satisfies Record<string, ChannelSource>;

type Channel = keyof typeof CHANNELS;

type State = { readonly checked: number; readonly channel: Channel; readonly latest: Version | null };

function isChannel(value: unknown): value is Channel {
  return typeof value === "string" && Object.hasOwn(CHANNELS, value);
}

function switchedOff(env: Env): boolean {
  return OFF_SWITCHES.some((name) => {
    const value = env[name];
    return value !== undefined && value !== "";
  });
}

function realPath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function installChannel(executable: string, env: Env): Channel | null {
  const path = realPath(executable);
  if (path === null) return null;
  if (path.includes(HOMEBREW_CELLAR) && path.endsWith(`/bin/${TOOL}`)) return "homebrew";
  if (PLATFORM_BUILD.test(path)) return path.includes(BUN_GLOBAL) ? "bun" : "npm";
  if (path === resolvedPath(join(homeDir(env), ...CURL_INSTALL))) return "curl";
  return null;
}

function parsedVersion(text: string): Version | null {
  const match = VERSION.exec(text.trim());
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function printedVersion([major, minor, patch]: Version): string {
  return `${major}.${minor}.${patch}`;
}

function isNewer(
  [major, minor, patch]: Version,
  [runningMajor, runningMinor, runningPatch]: Version,
): boolean {
  if (major !== runningMajor) return major > runningMajor;
  if (minor !== runningMinor) return minor > runningMinor;
  return patch > runningPatch;
}

async function latestOrNothing(channel: Channel, fetch: Fetch): Promise<Version | null> {
  const { source, latestIn } = CHANNELS[channel];
  try {
    const response = await fetch(source, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
    if (!response.ok) return null;
    const text = await latestIn(response);
    return text === null ? null : parsedVersion(text);
  } catch {
    return null;
  }
}

function stateOrNothing(file: string): State | null {
  let body: JsonObject | null;
  try {
    body = jsonObject(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return null;
  }
  if (body === null) return null;
  const { checked, channel, latest } = body;
  if (typeof checked !== "number" || !isChannel(channel)) return null;
  if (latest === null) return { checked, channel, latest: null };
  const version = typeof latest === "string" ? parsedVersion(latest) : null;
  return version === null ? null : { checked, channel, latest: version };
}

function wroteState(dir: string, file: string, state: State): boolean {
  const partial = `${file}.${process.pid}`;
  const latest = state.latest === null ? null : printedVersion(state.latest);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(partial, `${JSON.stringify({ ...state, latest })}\n`);
    renameSync(partial, file);
    return true;
  } catch {
    rmSync(partial, { force: true });
    return false;
  }
}

function notice(channel: Channel, latest: Version | null, running: Version): string | null {
  if (latest === null || !isNewer(latest, running)) return null;
  return `${TOOL} ${printedVersion(latest)} is out (running ${printedVersion(running)}): run ${CHANNELS[channel].upgrade}; if you cannot, tell the user.`;
}

export async function updateNotice(check: UpdateCheck): Promise<string | null> {
  if (switchedOff(check.env)) return null;
  const running = parsedVersion(check.running);
  const channel = installChannel(check.executable, check.env);
  if (running === null || channel === null) return null;
  const dir = stateDir(check.env);
  const file = join(dir, STATE_FILE);
  const stored = stateOrNothing(file);
  const known = stored?.channel === channel ? stored : null;
  if (known !== null && check.now - known.checked < DAY_MS) return notice(channel, known.latest, running);
  const attempt: State = { checked: check.now, channel, latest: known?.latest ?? null };
  if (!wroteState(dir, file, attempt)) return null;
  const latest = await latestOrNothing(channel, check.fetch);
  if (latest === null) return null;
  wroteState(dir, file, { ...attempt, latest });
  return notice(channel, latest, running);
}
