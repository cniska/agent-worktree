import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

const GUARDED_DIRS = ["src", "acceptance", "plugin", "examples", "scripts", "npm", "docs"];

const SELF = "scripts/standalone.test.ts";

const WORKFLOWS = ".github/workflows";

const INSTALLED_WORKFLOW = "# agent-gate:";

const README = "README.md";

const GUARDED_FILES = ["SPEC.md", README];

const CONTRIBUTOR_DOC = "docs/development.md";

const SUGGESTED = /^(cniska-skills|agent-skills)$/;

const OTHER_TOOL = /\b(cniska-(skills|task|record|gates)|agent-(task|record|gates|skills))\b/g;

const CROSSLINK_HEADING = "## Related";

const NEXT_SECTION = "## ";

const CROSSLINK = /\[(agent-(skills|task|record|gates|worktree))\]\(https:\/\/github\.com\/cniska\/\1\)/g;

type Guarded = { readonly path: string; readonly text: string };

function crosslinkSection(lines: readonly string[]): ReadonlySet<number> {
  const heading = lines.indexOf(CROSSLINK_HEADING);
  if (heading === -1) return new Set();
  const next = lines.findIndex((line, index) => index > heading && line.startsWith(NEXT_SECTION));
  const end = next === -1 ? lines.length : next;
  return new Set(Array.from({ length: end - heading - 1 }, (_, offset) => heading + 1 + offset));
}

function inCrosslink(line: string, at: number): boolean {
  return [...line.matchAll(CROSSLINK)].some(
    ({ 0: link, index: start }) => at >= start && at < start + link.length,
  );
}

function namings({ path, text }: Guarded): readonly string[] {
  const suggesting = path === CONTRIBUTOR_DOC;
  const lines = text.split("\n");
  const section = path === README ? crosslinkSection(lines) : new Set<number>();
  return lines.flatMap((line, index) => {
    const at = index + 1;
    return [...line.matchAll(OTHER_TOOL)]
      .filter(([match]) => !(suggesting && SUGGESTED.test(match)))
      .filter(({ index: start }) => !(section.has(index) && inCrosslink(line, start)))
      .map(([match]) => `${path}:${at} names another tool: ${match}`);
  });
}

function filesUnder(dir: string): readonly string[] {
  return [...new Bun.Glob("**/*").scanSync({ cwd: join(ROOT, dir), dot: true })].map((path) =>
    join(dir, path),
  );
}

function ownWorkflow({ text }: Guarded): boolean {
  return !text.startsWith(INSTALLED_WORKFLOW);
}

function read(path: string): Guarded {
  return { path, text: readFileSync(join(ROOT, path), "utf8") };
}

function guardedFiles(): readonly Guarded[] {
  const paths = [...GUARDED_DIRS.flatMap(filesUnder), ...GUARDED_FILES].filter((path) => path !== SELF);
  return [...paths.map(read), ...filesUnder(WORKFLOWS).map(read).filter(ownWorkflow)].toSorted((a, b) =>
    a.path.localeCompare(b.path),
  );
}

describe("the repo stands alone", () => {
  test("names no other tool", () => {
    expect(guardedFiles().flatMap(namings)).toEqual([]);
  });

  test("lets only docs/development.md suggest cniska-skills", () => {
    const text = "# x\n\nUse cniska-skills.\n\n## Next\n\nTry agent-skills or agent-gates.";
    expect(namings({ path: "docs/development.md", text })).toEqual([
      "docs/development.md:7 names another tool: agent-gates",
    ]);
    expect(namings({ path: "README.md", text })).toEqual([
      "README.md:3 names another tool: cniska-skills",
      "README.md:7 names another tool: agent-skills",
      "README.md:7 names another tool: agent-gates",
    ]);
    expect(namings({ path: "docs/commands.md", text })).toHaveLength(3);
  });

  test("guards the release paths and the workflows it owns, but not itself or a workflow another tool installs", () => {
    const paths = guardedFiles().map(({ path }) => path);
    expect(paths).toContain("scripts/install.sh");
    expect(paths).toContain("npm/agent-worktree");
    expect(paths).toContain("docs/releasing.md");
    expect(paths).toContain("docs/development.md");
    expect(paths).toContain(".github/workflows/release.yml");
    expect(paths).toContain(".github/workflows/check.yml");
    expect(paths).not.toContain(SELF);
    expect(ownWorkflow({ path: "x.yml", text: "# agent-gate:made-up:1\nname: X\n" })).toBe(false);
    expect(ownWorkflow({ path: "x.yml", text: "name: X\n# agent-gate:made-up:1\n" })).toBe(true);
  });

  test("names another tool wherever it stands, its own names freely", () => {
    const text = "agent-worktree and cniska-worktree\nagent-record, cniska-gates, agent-task, cniska-task";
    expect(namings({ path: "src/x.ts", text })).toEqual([
      "src/x.ts:2 names another tool: agent-record",
      "src/x.ts:2 names another tool: cniska-gates",
      "src/x.ts:2 names another tool: agent-task",
      "src/x.ts:2 names another tool: cniska-task",
    ]);
  });

  test("lets only the README's Related section link the other tools, each by its own name", () => {
    const link = "[agent-task](https://github.com/cniska/agent-task)";
    const text = [
      `See ${link}.`,
      "## Related",
      `Add-on to [agent-skills](https://github.com/cniska/agent-skills), beside ${link}.`,
      "Install cniska-task, or [agent-record](https://github.com/cniska/agent-gates).",
      "## Next",
      link,
      "## Related",
      link,
    ].join("\n");
    expect(namings({ path: "README.md", text })).toEqual([
      "README.md:1 names another tool: agent-task",
      "README.md:1 names another tool: agent-task",
      "README.md:4 names another tool: cniska-task",
      "README.md:4 names another tool: agent-record",
      "README.md:4 names another tool: agent-gates",
      "README.md:6 names another tool: agent-task",
      "README.md:6 names another tool: agent-task",
      "README.md:8 names another tool: agent-task",
      "README.md:8 names another tool: agent-task",
    ]);
    expect(namings({ path: "docs/development.md", text: `## Related\n${link}` })).toEqual([
      "docs/development.md:2 names another tool: agent-task",
      "docs/development.md:2 names another tool: agent-task",
    ]);
  });
});
