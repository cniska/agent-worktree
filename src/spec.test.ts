import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Node } from "@babel/types";
import { nodesOf } from "./syntax.test-support";

const ROOT = join(import.meta.dir, "..");

const ACCEPTANCE = join(ROOT, "acceptance");

const ACCEPTANCE_FILE = /\.acceptance\.ts$/;

const NOT_CITED = new Set(["AC", "C", "D"]);

const DEFINED = /^- \*\*([A-Z]+-[^*]+)\*\* —/gm;

const CRITERION = /^- \*\*(AC-[^*]+)\*\* —.*?(?:\(((?:[A-Z]+-\w+)(?:, [A-Z]+-\w+)*)\))?$/gm;

const PROVES = /^(?:AC-\d+ )+/;

const WHOLE_NUMBER = /^[A-Z]+-[1-9]\d*$/;

type Criterion = { readonly id: string; readonly cites: readonly string[] };

const familyOf = (id: string): string => id.slice(0, id.indexOf("-"));

function definedIds(spec: string): readonly string[] {
  return [...spec.matchAll(DEFINED)].flatMap(([, id]) => (id === undefined ? [] : [id]));
}

function criteriaOf(spec: string): readonly Criterion[] {
  return [...spec.matchAll(CRITERION)].flatMap(([, id, cites]) =>
    id === undefined ? [] : [{ id, cites: cites === undefined ? [] : cites.split(", ") }],
  );
}

function numberingProblems(ids: readonly string[]): readonly string[] {
  const problems = ids
    .filter((id) => !WHOLE_NUMBER.test(id))
    .map((id) => `${id} is not a family and a whole number`);
  for (const family of new Set(ids.map(familyOf))) {
    const numbered = ids.filter((id) => familyOf(id) === family && WHOLE_NUMBER.test(id));
    const expected = numbered.map((_, index) => `${family}-${index + 1}`);
    if (numbered.join() !== expected.join())
      problems.push(`${family} is numbered ${numbered.join(", ")}, not from 1 without gaps`);
  }
  return problems;
}

function traceProblems(
  spec: string,
  ids: readonly string[],
  criteria: readonly Criterion[],
): readonly string[] {
  const cited = new Set(criteria.flatMap(({ cites }) => cites));
  const mention = new RegExp(`\\b(?:${[...new Set(ids.map(familyOf))].join("|")})-\\w+\\b`, "g");
  const mentioned = new Set([...cited, ...[...spec.matchAll(mention)].map(([id]) => id)]);
  return [
    ...criteria.filter(({ cites }) => cites.length === 0).map(({ id }) => `${id} cites no requirement`),
    ...ids
      .filter((id) => !NOT_CITED.has(familyOf(id)) && !cited.has(id))
      .map((id) => `${id} is cited by no criterion`),
    ...[...mentioned].filter((id) => !ids.includes(id)).map((id) => `${id} is mentioned but not defined`),
  ];
}

type AcceptanceTest = { readonly name: string | null; readonly modifier: string | null };

const PLAIN_TEST = "test";

function testCalleeOf(callee: Node): { readonly modifier: string | null } | null {
  if (callee.type === "Identifier") return callee.name === PLAIN_TEST ? { modifier: null } : null;
  if (callee.type !== "MemberExpression") return null;
  if (callee.object.type !== "Identifier" || callee.object.name !== PLAIN_TEST) return null;
  return { modifier: callee.property.type === "Identifier" ? callee.property.name : "computed" };
}

function testsOf(source: string): readonly AcceptanceTest[] {
  return [...nodesOf(source)].flatMap((node) => {
    if (node.type !== "CallExpression") return [];
    const callee = testCalleeOf(node.callee);
    if (callee === null) return [];
    const [name] = node.arguments;
    return [{ name: name?.type === "StringLiteral" ? name.value : null, modifier: callee.modifier }];
  });
}

function suiteProblems(criteria: readonly Criterion[], tests: readonly AcceptanceTest[]): readonly string[] {
  const known = new Set(criteria.map(({ id }) => id));
  const proven = new Set<string>();
  const problems: string[] = [];
  for (const { name, modifier } of tests) {
    if (name === null) {
      problems.push("an acceptance test's name is not a string literal");
      continue;
    }
    if (modifier !== null) {
      problems.push(`acceptance test "${name}" is a test.${modifier}, not a test that runs`);
      continue;
    }
    const proves = PROVES.exec(name)?.[0].trim().split(" ") ?? [];
    if (proves.length === 0) problems.push(`acceptance test "${name}" cites no criterion`);
    for (const id of proves) {
      proven.add(id);
      if (!known.has(id))
        problems.push(`acceptance test "${name}" cites ${id}, which the spec does not define`);
    }
  }
  return [
    ...problems,
    ...[...known].filter((id) => !proven.has(id)).map((id) => `${id} has no acceptance test`),
  ];
}

function citationProblems(spec: string, sources: readonly string[]): readonly string[] {
  const ids = definedIds(spec);
  const criteria = criteriaOf(spec);
  const tests = sources.flatMap(testsOf);
  const empty = [
    ...(criteria.length === 0 ? ["the spec defines no acceptance criteria"] : []),
    ...(tests.length === 0 ? ["the suite holds no acceptance tests"] : []),
  ];
  if (empty.length > 0) return empty;
  return [
    ...numberingProblems(ids),
    ...traceProblems(spec, ids, criteria),
    ...suiteProblems(criteria, tests),
  ];
}

const SPEC = `
- **FR-1** — Creates a worktree.
- **FR-2** — Removes a worktree.
- **NF-1** — Needs no network.
- **D-1** — The CLI.
- **C-1** — Runs on Bun.
- **AC-1** — Create offline: the worktree exists. (FR-1, NF-1)
- **AC-2** — Remove it: it is gone. (FR-2)
`;

const PROVEN = `test("AC-1 creates offline", () => {});`;

const SUITE = [PROVEN, `test("AC-2 removes it", () => {});`];

describe("the spec and the acceptance suite", () => {
  test("cite each other completely", () => {
    const spec = readFileSync(join(ROOT, "SPEC.md"), "utf8");
    const sources = readdirSync(ACCEPTANCE)
      .filter((file) => ACCEPTANCE_FILE.test(file))
      .map((file) => readFileSync(join(ACCEPTANCE, file), "utf8"));
    expect(citationProblems(spec, sources)).toEqual([]);
  });
});

describe("the citation check", () => {
  test("passes a spec and a suite that cite each other completely", () => {
    expect(citationProblems(SPEC, SUITE)).toEqual([]);
  });

  test("fails an empty spec or suite rather than passing it", () => {
    expect(citationProblems("", [])).toEqual([
      "the spec defines no acceptance criteria",
      "the suite holds no acceptance tests",
    ]);
  });

  test("fails a test whose name cites no criterion", () => {
    expect(citationProblems(SPEC, [...SUITE, `test("creates twice", () => {});`])).toEqual([
      'acceptance test "creates twice" cites no criterion',
    ]);
  });

  test("fails a test citing a criterion the spec does not define", () => {
    expect(citationProblems(SPEC, [...SUITE, `test("AC-3 prunes", () => {});`])).toEqual([
      'acceptance test "AC-3 prunes" cites AC-3, which the spec does not define',
    ]);
  });

  test("fails a test whose name is not a string literal", () => {
    expect(citationProblems(SPEC, [...SUITE, "test(name, () => {});"])).toEqual([
      "an acceptance test's name is not a string literal",
    ]);
  });

  test("fails a criterion with no test", () => {
    expect(citationProblems(SPEC, [PROVEN])).toEqual(["AC-2 has no acceptance test"]);
  });

  test("fails a todo or a skipped test as not proving its criterion", () => {
    expect(citationProblems(SPEC, [PROVEN, `test.todo("AC-2 removes it");`])).toEqual([
      'acceptance test "AC-2 removes it" is a test.todo, not a test that runs',
      "AC-2 has no acceptance test",
    ]);
    expect(citationProblems(SPEC, [PROVEN, `test.skip("AC-2 removes it", () => {});`])).toEqual([
      'acceptance test "AC-2 removes it" is a test.skip, not a test that runs',
      "AC-2 has no acceptance test",
    ]);
  });

  test("fails an id that is not a family and a whole number", () => {
    const spec = SPEC.replace("**FR-2**", "**FR-2a**").replace("(FR-2)", "(FR-2a)");
    expect(citationProblems(spec, SUITE)).toEqual(["FR-2a is not a family and a whole number"]);
  });

  test("fails a family not numbered from 1 without gaps", () => {
    const spec = SPEC.replace("**FR-2**", "**FR-3**").replace("(FR-2)", "(FR-3)");
    expect(citationProblems(spec, SUITE)).toEqual(["FR is numbered FR-1, FR-3, not from 1 without gaps"]);
  });

  test("fails a criterion that cites no requirement", () => {
    expect(citationProblems(SPEC.replace(" (FR-2)", ""), SUITE)).toEqual([
      "AC-2 cites no requirement",
      "FR-2 is cited by no criterion",
    ]);
  });

  test("fails a criterion citing a requirement the spec does not define", () => {
    expect(citationProblems(SPEC.replace("(FR-2)", "(FR-2, FR-9)"), SUITE)).toEqual([
      "FR-9 is mentioned but not defined",
    ]);
  });

  test("fails a requirement no criterion cites", () => {
    expect(citationProblems(SPEC.replace("(FR-1, NF-1)", "(FR-1)"), SUITE)).toEqual([
      "NF-1 is cited by no criterion",
    ]);
  });

  test("fails an id mentioned in prose that the spec does not define", () => {
    expect(citationProblems(`${SPEC}\nAs FR-7 states.\n`, SUITE)).toEqual([
      "FR-7 is mentioned but not defined",
    ]);
  });
});
