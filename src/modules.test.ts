import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "@babel/parser";
import {
  type ExportNamedDeclaration,
  type Identifier,
  type ImportDeclaration,
  isNode,
  type Node,
  type StringLiteral,
} from "@babel/types";

const SRC = import.meta.dir;

function* nodesOf(text: string): Iterable<Node> {
  yield* walk(parse(text, { sourceType: "module", plugins: ["typescript"] }).program);
}

function* walk(value: unknown): Iterable<Node> {
  if (Array.isArray(value)) {
    for (const item of value) yield* walk(item);
  } else if (isNode(value)) {
    yield value;
    for (const child of Object.values(value)) yield* walk(child);
  }
}

type Import = { readonly path: string; readonly typeOnly: boolean; readonly names: readonly string[] };

const ALL = "*";

const DEFAULT = "default";

function nameOf(name: Identifier | StringLiteral): string {
  return name.type === "Identifier" ? name.name : name.value;
}

function importedName(specifier: ImportDeclaration["specifiers"][number]): string {
  if (specifier.type === "ImportSpecifier") return nameOf(specifier.imported);
  return specifier.type === "ImportDefaultSpecifier" ? DEFAULT : ALL;
}

function exportedName(specifier: ExportNamedDeclaration["specifiers"][number]): string {
  if (specifier.type === "ExportSpecifier") return nameOf(specifier.local);
  return specifier.type === "ExportDefaultSpecifier" ? DEFAULT : ALL;
}

function loadedPath(node: Node): string | null {
  if (node.type !== "CallExpression") return null;
  const loads =
    node.callee.type === "Import" || (node.callee.type === "Identifier" && node.callee.name === "require");
  const [first] = node.arguments;
  if (!loads) return null;
  if (first?.type === "StringLiteral") return first.value;
  if (first?.type !== "TemplateLiteral" || first.expressions.length > 0) return null;
  return first.quasis[0]?.value.cooked ?? null;
}

function importOf(node: Node): Import | null {
  if (node.type === "ImportDeclaration") {
    const values = node.specifiers.filter(
      (specifier) => specifier.type !== "ImportSpecifier" || specifier.importKind !== "type",
    );
    const typeOnly = node.importKind === "type" || (node.specifiers.length > 0 && values.length === 0);
    return { path: node.source.value, typeOnly, names: values.map(importedName) };
  }
  if (node.type === "ExportNamedDeclaration" && node.source) {
    const values = node.specifiers.filter(
      (specifier) => specifier.type !== "ExportSpecifier" || specifier.exportKind !== "type",
    );
    const typeOnly = node.exportKind === "type" || values.length === 0;
    return { path: node.source.value, typeOnly, names: values.map(exportedName) };
  }
  if (node.type === "ExportAllDeclaration")
    return { path: node.source.value, typeOnly: node.exportKind === "type", names: [ALL] };
  if (node.type === "TSImportType") return { path: node.argument.value, typeOnly: true, names: [] };
  if (node.type === "TSImportEqualsDeclaration" && node.moduleReference.type === "TSExternalModuleReference")
    return {
      path: node.moduleReference.expression.value,
      typeOnly: node.importKind === "type",
      names: [ALL],
    };
  const path = loadedPath(node);
  return path === null ? null : { path, typeOnly: false, names: [ALL] };
}

function importsOf(text: string): readonly Import[] {
  return [...nodesOf(text)].flatMap((node) => importOf(node) ?? []);
}

const MODULES = [
  "cli",
  "worktrees",
  "hook",
  "project",
  "ledger",
  "git",
  "scripts",
  "exit",
  "directory",
  "log",
  "assert",
  "coded-error",
];

const ENTRY = "cli";

const PROCESS_RUNNERS = new Set(["git", "scripts"]);

const PROCESS_PACKAGES = new Set(["node:child_process", "child_process"]);

const BUN_PACKAGE = "bun";

const BUN_SPAWNS = new Set(["spawn", "spawnSync", "$"]);

const TEST_FILE = /\.test(-support)?\.ts$|^test-env\.ts$/;

type Source = { readonly file: string; readonly text: string };

function allSources(): readonly Source[] {
  return readdirSync(SRC)
    .filter((file) => file.endsWith(".ts"))
    .map((file) => ({ file, text: readFileSync(join(SRC, file), "utf8") }));
}

const moduleSources = () => allSources().filter(({ file }) => !TEST_FILE.test(file));

function ownerOf(base: string): string | null {
  return MODULES.find((name) => base === name || base.startsWith(`${name}-`)) ?? null;
}

function importerOf(file: string): string | null {
  return TEST_FILE.test(file) && !file.endsWith(".test.ts")
    ? null
    : ownerOf(file.replace(/(\.test)?\.ts$/, ""));
}

function isPrivate(owner: string, base: string): boolean {
  return base !== owner || owner === ENTRY;
}

function boundaryBreaches(file: string, text: string): readonly string[] {
  const importer = importerOf(file);
  const paths = new Set(importsOf(text).map(({ path }) => path));
  return [...paths]
    .filter((path) => {
      if (!path.startsWith("./")) return false;
      const base = path.slice(2).replace(/\.(ts|js)$/, "");
      const owner = ownerOf(base);
      return owner !== null && owner !== importer && isPrivate(owner, base);
    })
    .map((path) => `${file} imports ${path}, another module's own file`);
}

function isBunSpawn(key: Node): boolean {
  return (
    (key.type === "Identifier" && BUN_SPAWNS.has(key.name)) ||
    (key.type === "StringLiteral" && BUN_SPAWNS.has(key.value))
  );
}

function isBun(node: Node | null | undefined): boolean {
  return node?.type === "Identifier" && node.name === "Bun";
}

function spawnsWithBun(node: Node): boolean {
  if (node.type === "MemberExpression" && isBun(node.object))
    return node.computed
      ? node.property.type === "StringLiteral" && isBunSpawn(node.property)
      : isBunSpawn(node.property);
  if (node.type === "VariableDeclarator" && node.id.type === "ObjectPattern" && isBun(node.init))
    return node.id.properties.some(
      (property) => property.type === "ObjectProperty" && isBunSpawn(property.key),
    );
  return false;
}

function startsProcess({ path, typeOnly, names }: Import): boolean {
  if (typeOnly) return false;
  if (PROCESS_PACKAGES.has(path)) return true;
  return (
    path === BUN_PACKAGE && names.some((name) => BUN_SPAWNS.has(name) || name === ALL || name === DEFAULT)
  );
}

function processBreaches(file: string, text: string): readonly string[] {
  const owner = ownerOf(file.replace(/\.ts$/, ""));
  if (owner !== null && PROCESS_RUNNERS.has(owner)) return [];
  const starts = importsOf(text).some(startsProcess) || [...nodesOf(text)].some(spawnsWithBun);
  return starts ? [`${file} starts a process`] : [];
}

describe("the modules", () => {
  test("another module or a test reaches a module only through its bare-named file, and never the entry", () => {
    expect(allSources().flatMap(({ file, text }) => boundaryBreaches(file, text))).toEqual([]);
  });

  test("only git and scripts start a process", () => {
    expect(moduleSources().flatMap(({ file, text }) => processBreaches(file, text))).toEqual([]);
  });
});

describe("the module checks", () => {
  test("place every source file in a module, and find every module's bare-named file", () => {
    const files = moduleSources().map(({ file }) => file);
    expect(files.filter((file) => ownerOf(file.replace(/\.ts$/, "")) === null)).toEqual([]);
    expect(MODULES.filter((name) => !files.includes(`${name}.ts`))).toEqual([]);
  });

  test("catch an import of another module's own file, but not of its bare-named file or of its own", () => {
    const text =
      'import { a } from "./cli-contract";\nimport { b } from "./project";\n' +
      'import { c } from "./coded-error";\nimport { d } from "node:fs";\n';
    expect(boundaryBreaches("worktrees.ts", text)).toEqual([
      "worktrees.ts imports ./cli-contract, another module's own file",
    ]);
    expect(boundaryBreaches("cli-commands.ts", text)).toEqual([]);
  });

  test("catch an import of the entry, even from another module's test", () => {
    expect(boundaryBreaches("worktrees.test.ts", 'import "./cli";')).toEqual([
      "worktrees.test.ts imports ./cli, another module's own file",
    ]);
    expect(boundaryBreaches("worktrees.ts", 'import "./cli.js";')).toEqual([
      "worktrees.ts imports ./cli.js, another module's own file",
    ]);
    expect(boundaryBreaches("cli.test.ts", 'import "./cli-output";')).toEqual([]);
  });

  test("hold a test support file to every module's bare-named file", () => {
    expect(boundaryBreaches("repo.test-support.ts", 'import { a } from "./cli-output";')).toEqual([
      "repo.test-support.ts imports ./cli-output, another module's own file",
    ]);
  });

  test("catch an import however it is written", () => {
    const breach = "hook.ts imports ./cli-contract, another module's own file";
    for (const text of [
      'import type { Command } from "./cli-contract";',
      'import { type Command } from "./cli-contract";',
      'export type { Command } from "./cli-contract";',
      'export * from "./cli-contract";',
      'import type {\n  Command,\n} from\n  "./cli-contract";',
      'const contract = await import("./cli-contract");',
      "const contract = await import(`./cli-contract`);",
      'const contract = require("./cli-contract");',
      'let command: import("./cli-contract").Command;',
      'import contract = require("./cli-contract");',
    ]) {
      expect(boundaryBreaches("hook.ts", text)).toEqual([breach]);
    }
  });

  test("catch a process started outside git and scripts", () => {
    for (const text of [
      'import { spawnSync } from "node:child_process";',
      'import { execFileSync } from "child_process";',
      'const child = await import("node:child_process");',
      'Bun.spawnSync(["ls"]);',
      'Bun.spawn(["ls"]);',
      "await Bun.$`ls`;",
      'import { $ } from "bun";',
      'import { spawnSync } from "bun";',
      'import * as bun from "bun";',
      'import "node:child_process";',
      'import child = require("node:child_process");',
      "const child = await import(`node:child_process`);",
      "const child = require(`child_process`);",
      'export { spawnSync } from "node:child_process";',
      'export { $ } from "bun";',
      'const { spawn } = Bun;\nspawn(["ls"]);',
      'Bun["spawn"](["ls"]);',
    ]) {
      expect(processBreaches("ledger.ts", text)).toEqual(["ledger.ts starts a process"]);
    }
    expect(processBreaches("git.ts", 'import { spawnSync } from "node:child_process";')).toEqual([]);
    expect(processBreaches("git-parse.ts", 'import { spawnSync } from "node:child_process";')).toEqual([]);
    for (const text of [
      'const help = "Bun.spawn(x)";',
      'import { Glob } from "bun";',
      'import type { SpawnSyncReturns } from "node:child_process";',
      'import { type SpawnSyncReturns } from "node:child_process";',
      'export type { SpawnSyncReturns } from "node:child_process";',
      'let child: import("node:child_process").ChildProcess;',
      "const { Glob } = Bun;",
      'Bun["file"]("x");',
    ]) {
      expect(processBreaches("ledger.ts", text)).toEqual([]);
    }
  });
});
