import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

const SELF = "scripts/scratch-dir.test.ts";

const SEARCHED_DIRS = ["src", "acceptance", "scripts"];

const OWN_MKDTEMP = /\bmkdtemp(?:Sync)?\b/;

const HELPERS = [
  { suffix: ".test.ts", helper: "scratchDir() in src/repo.test-support.ts" },
  { suffix: ".acceptance.ts", helper: "world() in acceptance/harness.ts" },
] as const;

type Source = { readonly path: string; readonly text: string };

function helperFor(path: string): string | null {
  return HELPERS.find(({ suffix }) => path.endsWith(suffix))?.helper ?? null;
}

function testFiles(): readonly Source[] {
  return SEARCHED_DIRS.flatMap((dir) =>
    [...new Bun.Glob("**/*.ts").scanSync({ cwd: join(ROOT, dir) })].map((path) => join(dir, path)),
  )
    .filter((path) => path !== SELF && helperFor(path) !== null)
    .map((path) => ({ path, text: readFileSync(join(ROOT, path), "utf8") }))
    .toSorted((a, b) => a.path.localeCompare(b.path));
}

function ownScratchDirs({ path, text }: Source): readonly string[] {
  const helper = helperFor(path);
  if (helper === null) return [];
  return text.split("\n").flatMap((line, index) => {
    const call = OWN_MKDTEMP.exec(line)?.[0];
    return call === undefined ? [] : [`${path}:${index + 1} calls ${call}; use ${helper}`];
  });
}

describe("tests make scratch directories through the shared helpers", () => {
  test("no test file calls mkdtemp or mkdtempSync", () => {
    expect(testFiles().flatMap(ownScratchDirs)).toEqual([]);
  });

  test("searches every test and acceptance file, but not the helpers or itself", () => {
    const paths = testFiles().map(({ path }) => path);
    expect(paths).toContain("src/cli.test.ts");
    expect(paths).toContain("scripts/standalone.test.ts");
    expect(paths).toContain("acceptance/create.acceptance.ts");
    expect(paths).not.toContain("src/repo.test-support.ts");
    expect(paths).not.toContain("src/test-env.ts");
    expect(paths).not.toContain("acceptance/harness.ts");
    expect(paths).not.toContain(SELF);
  });

  test("names the helper a test file and an acceptance file each use, and spares other files", () => {
    const text =
      'import { mkdtempSync } from "node:fs";\nconst dir = fs.mkdtempSync(prefix);\nconst scratch = await mkdtemp(prefix);\n';
    expect(ownScratchDirs({ path: "src/x.test.ts", text })).toEqual([
      "src/x.test.ts:1 calls mkdtempSync; use scratchDir() in src/repo.test-support.ts",
      "src/x.test.ts:2 calls mkdtempSync; use scratchDir() in src/repo.test-support.ts",
      "src/x.test.ts:3 calls mkdtemp; use scratchDir() in src/repo.test-support.ts",
    ]);
    expect(ownScratchDirs({ path: "acceptance/x.acceptance.ts", text })).toEqual([
      "acceptance/x.acceptance.ts:1 calls mkdtempSync; use world() in acceptance/harness.ts",
      "acceptance/x.acceptance.ts:2 calls mkdtempSync; use world() in acceptance/harness.ts",
      "acceptance/x.acceptance.ts:3 calls mkdtemp; use world() in acceptance/harness.ts",
    ]);
    expect(ownScratchDirs({ path: "src/repo.test-support.ts", text })).toEqual([]);
  });
});
