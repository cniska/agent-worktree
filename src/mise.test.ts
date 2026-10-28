import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { trustLikePrimary } from "./mise";
import { removeScratchDirs, scratchDir } from "./repo.test-support";

const STUB = [
  "#!/bin/sh",
  'dir=$(dirname "$0")',
  'printf \'%s\\n\' "$*" >> "$dir/calls"',
  '[ "$2" = --show ] && { cat "$dir/show"; exit 0; }',
  'exit "$(cat "$dir/status")"',
  "",
].join("\n");

const CONFIG = "[tools]\n";

let bin = "";
let callerPath: string | undefined;

beforeEach(() => {
  bin = scratchDir();
  writeFileSync(join(bin, "mise"), STUB);
  chmodSync(join(bin, "mise"), 0o755);
  writeFileSync(join(bin, "status"), "0\n");
  callerPath = process.env.PATH;
  process.env.PATH = `${bin}:${callerPath ?? ""}`;
});

afterEach(() => {
  process.env.PATH = callerPath;
  removeScratchDirs();
});

function write(root: string, file: string, text = CONFIG): void {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
}

function shows(text: string): void {
  writeFileSync(join(bin, "show"), text);
}

function calls(): readonly string[] {
  const record = join(bin, "calls");
  return existsSync(record) ? readFileSync(record, "utf8").split("\n").slice(0, -1) : [];
}

function trustedPrimary(): { readonly primary: string; readonly checkout: string } {
  const primary = scratchDir();
  const checkout = scratchDir();
  shows(`${dirname(primary)}: untrusted\n${primary}: trusted\n`);
  return { primary, checkout };
}

describe("trustLikePrimary", () => {
  test("trusts a checkout holding every config name mise reads, each as the primary has it", () => {
    const { primary, checkout } = trustedPrimary();
    const configs = [
      "mise.toml",
      ".mise.toml",
      ".mise.dev.toml",
      ".rtx.toml",
      ".config/mise.toml",
      ".config/mise/config.toml",
      ".config/mise/conf.d/extra.toml",
      "mise/config.toml",
      "mise/conf.d/extra.toml",
      ".mise/config.toml",
      ".mise/conf.d/extra.toml",
    ];
    for (const config of [...configs, "mise.local.toml"]) write(primary, config);
    for (const config of configs) write(checkout, config);
    trustLikePrimary(primary, checkout);
    expect(calls()).toEqual(["trust --show", `trust --quiet ${checkout}`]);
  });

  test("ignores files that are not mise config", () => {
    const { primary, checkout } = trustedPrimary();
    write(primary, "mise.toml");
    write(checkout, "mise.toml");
    for (const other of [
      "Cargo.toml",
      ".tool-versions",
      ".config/other.toml",
      "mise/tasks/build",
      "sub/mise.toml",
    ])
      write(checkout, other, "differs\n");
    mkdirSync(join(checkout, "mise.d.toml"));
    trustLikePrimary(primary, checkout);
    expect(calls()).toEqual(["trust --show", `trust --quiet ${checkout}`]);
  });

  test("runs no mise for a checkout without mise config", () => {
    const { primary, checkout } = trustedPrimary();
    write(primary, "mise.toml");
    write(checkout, "README.md");
    trustLikePrimary(primary, checkout);
    expect(calls()).toEqual([]);
  });

  test("trusts nothing when a config differs from the primary's or the primary lacks it", () => {
    const { primary, checkout } = trustedPrimary();
    write(primary, "mise.toml");
    write(checkout, "mise.toml", "[tools]\nnode = '24'\n");
    trustLikePrimary(primary, checkout);
    write(checkout, "mise.toml");
    write(checkout, ".config/mise/conf.d/extra.toml");
    trustLikePrimary(primary, checkout);
    expect(calls()).toEqual([]);
  });

  test("trusts nothing unless the primary's own line of mise trust --show says trusted", () => {
    const { primary, checkout } = trustedPrimary();
    write(primary, "mise.toml");
    write(checkout, "mise.toml");
    for (const shown of [
      `${primary}: untrusted\n`,
      `${dirname(primary)}: trusted\n`,
      `${primary}x: trusted\n`,
      "",
    ]) {
      shows(shown);
      trustLikePrimary(primary, checkout);
    }
    expect(calls()).toEqual(Array.from({ length: 4 }, () => "trust --show"));
  });

  test("reads the primary's line as mise shortens it under HOME", () => {
    const { checkout } = trustedPrimary();
    const home = process.env.HOME ?? "";
    const primary = join(home, "code", basename(checkout));
    write(primary, "mise.toml");
    write(checkout, "mise.toml");
    shows(`~/code/${basename(checkout)}: trusted\n`);
    trustLikePrimary(primary, checkout);
    expect(calls()).toEqual(["trust --show", `trust --quiet ${checkout}`]);
  });

  test("trusts nothing, and never throws, when a config cannot be read", () => {
    const { primary, checkout } = trustedPrimary();
    write(primary, "mise.toml");
    symlinkSync(join(checkout, "gone.toml"), join(checkout, "mise.toml"));
    trustLikePrimary(primary, checkout);
    expect(calls()).toEqual([]);
  });

  test("never throws when mise trust fails", () => {
    const { primary, checkout } = trustedPrimary();
    write(primary, "mise.toml");
    write(checkout, "mise.toml");
    writeFileSync(join(bin, "status"), "1\n");
    trustLikePrimary(primary, checkout);
    expect(calls()).toEqual(["trust --show", `trust --quiet ${checkout}`]);
  });
});
