import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { decode, type JsonObject, type JsonValue } from "@toon-format/toon";
import { removeScratchDirs, scratchDir } from "../src/repo.test-support";
import { launcher, PLATFORMS } from "./build-npm";

const SYSTEM_PATH = "/usr/bin:/bin";

const SCOPE = "@cniska";

const NAME = "agent-worktree";

const TARGET = `${process.platform}-${process.arch}`;

const STUB = [
  "#!/bin/sh",
  `printf 'self %s\\n' "$$"`,
  `for arg; do printf 'arg %s\\n' "$arg"; done`,
  `printf 'stdin %s\\n' "$(cat)"`,
  "exit 7",
  "",
].join("\n");

const UNSUPPORTED_UNAME = ["#!/bin/sh", 'case "$1" in -s) echo Plan9 ;; -m) echo mips ;; esac', ""].join(
  "\n",
);

type Layout = "nested" | "hoisted";

type Ran = {
  readonly pid: number;
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
};

afterEach(removeScratchDirs);

function executable(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  chmodSync(path, 0o755);
}

function prefix(
  layout: Layout,
  platformTarget: string | null,
): { readonly bin: string; readonly stub: string } {
  const root = scratchDir();
  const modules = join(root, "node_modules", SCOPE);
  const shim = join(modules, NAME);
  executable(join(shim, "bin", NAME), launcher(PLATFORMS));
  const bin = join(root, "bin");
  mkdirSync(bin);
  symlinkSync(relative(bin, join(shim, "bin", NAME)), join(bin, NAME));
  const platformDir =
    layout === "nested"
      ? join(shim, "node_modules", SCOPE, `${NAME}-${platformTarget ?? TARGET}`)
      : join(modules, `${NAME}-${platformTarget ?? TARGET}`);
  const stub = join(platformDir, NAME);
  if (platformTarget !== null) executable(stub, STUB);
  return { bin, stub };
}

async function run(
  bin: string,
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
  input = "",
): Promise<Ran> {
  const child = Bun.spawn([NAME, ...args], {
    cwd: bin,
    env: { PATH: `${bin}:${SYSTEM_PATH}`, ...env },
    stdin: new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { pid: child.pid, status, stdout, stderr };
}

function isObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type Refusal = { readonly code: string; readonly message: string; readonly resolve: string };

function refusal(ran: Ran): Refusal {
  expect([ran.status, ran.stdout]).toEqual([1, ""]);
  expect(ran.stderr).toStartWith("command: agent-worktree\nok: false\nerror:\n  kind: refusal\n  code: ");
  const printed = decode(ran.stderr);
  expect(printed).toEqual({
    command: "agent-worktree",
    ok: false,
    error: {
      kind: "refusal",
      code: expect.any(String),
      message: expect.any(String),
      meta: {},
      resolve: expect.any(String),
    },
  });
  const error = isObject(printed) ? printed.error : undefined;
  if (error === undefined || !isObject(error)) throw new Error(`${ran.stderr} holds no error`);
  return {
    code: jsonString(error.code),
    message: jsonString(error.message),
    resolve: jsonString(error.resolve),
  };
}

function jsonString(value: JsonValue | undefined): string {
  if (typeof value !== "string") throw new Error(`${JSON.stringify(value)} is not a string`);
  return value;
}

describe.each<Layout>(["nested", "hoisted"])("the launcher over the %s layout", (layout) => {
  test("becomes the platform binary, with its arguments, stdin and exit code, leaving no shell as its parent", async () => {
    const { bin } = prefix(layout, TARGET);
    const ran = await run(bin, ["create", "task --from", "two  spaces"], {}, "in\n");
    expect(ran).toMatchObject({
      status: 7,
      stdout: `self ${ran.pid}\narg create\narg task --from\narg two  spaces\nstdin in\n`,
      stderr: "",
    });
  });

  test("refuses a platform with no build, naming the builds", async () => {
    const { bin } = prefix(layout, TARGET);
    const fakeBin = scratchDir();
    executable(join(fakeBin, "uname"), UNSUPPORTED_UNAME);
    const ran = await run(bin, ["--version"], { PATH: `${fakeBin}:${bin}:${SYSTEM_PATH}` });
    expect(ran.stderr).toBe(
      [
        "command: agent-worktree",
        "ok: false",
        "error:",
        "  kind: refusal",
        "  code: no_build_for_platform",
        '  message: "agent-worktree ships no build for Plan9-mips, only darwin-arm64 and linux-x64"',
        "  meta:",
        '  resolve: "build agent-worktree from source with Bun, as its docs/development.md says"',
        "",
      ].join("\n"),
    );
    expect(refusal(ran)).toEqual({
      code: "no_build_for_platform",
      message: "agent-worktree ships no build for Plan9-mips, only darwin-arm64 and linux-x64",
      resolve: "build agent-worktree from source with Bun, as its docs/development.md says",
    });
  });

  test("refuses when the platform package is installed nowhere", async () => {
    const { bin } = prefix(layout, null);
    expect(refusal(await run(bin, ["--version"]))).toEqual({
      code: "platform_package_missing",
      message: `@cniska/agent-worktree-${TARGET} is not installed beside @cniska/agent-worktree`,
      resolve: "reinstall @cniska/agent-worktree with optional dependencies enabled",
    });
  });

  test("refuses a platform binary that is not executable, naming it", async () => {
    const { bin, stub } = prefix(layout, TARGET);
    chmodSync(stub, 0o644);
    const { code, message, resolve } = refusal(await run(bin, ["--version"]));
    expect(code).toBe("binary_not_executable");
    const named = /^(.+) is not executable$/.exec(message)?.[1] ?? "";
    expect(realpathSync(named)).toBe(stub);
    expect(resolve).toBe("reinstall @cniska/agent-worktree");
  });
});
