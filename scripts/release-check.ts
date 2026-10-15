import { spawnSync } from "node:child_process";
import { version } from "../package.json";

export type Candidate = { readonly tag: string; readonly version: string };

type Version = { readonly major: number; readonly minor: number; readonly patch: number };

const TAG_PREFIX = "v";

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

function parseVersion(text: string): Version | null {
  const [, major, minor, patch] = VERSION.exec(text) ?? [];
  if (major === undefined || minor === undefined || patch === undefined) return null;
  return { major: Number(major), minor: Number(minor), patch: Number(patch) };
}

function newer(version: Version, than: Version): boolean {
  if (version.major !== than.major) return version.major > than.major;
  if (version.minor !== than.minor) return version.minor > than.minor;
  return version.patch > than.patch;
}

export function releaseProblems(candidate: Candidate, previousTag: string | null): readonly string[] {
  const version = parseVersion(candidate.version);
  if (version === null) return [`package.json's version ${candidate.version} is not of the form x.y.z`];
  const problems: string[] = [];
  if (candidate.tag !== `${TAG_PREFIX}${candidate.version}`)
    problems.push(`the tag ${candidate.tag} does not name package.json's version ${candidate.version}`);
  if (previousTag === null) return problems;
  const before = parseVersion(previousTag.slice(TAG_PREFIX.length));
  if (before === null) return [...problems, `the previous tag ${previousTag} names no x.y.z version`];
  if (!newer(version, before))
    problems.push(`${candidate.version} is not newer than the previous release ${previousTag}`);
  return problems;
}

function git(args: readonly string[]): { readonly ok: boolean; readonly out: string } {
  const ran = spawnSync("git", args, { encoding: "utf8" });
  return { ok: ran.status === 0, out: ran.stdout.trim() };
}

function previousTag(tag: string): string | null {
  const tagged = git(["rev-parse", "--quiet", "--verify", `refs/tags/${tag}`]).ok;
  const before = tagged ? `${tag}^` : "HEAD";
  const described = git(["describe", "--tags", "--abbrev=0", "--match", `${TAG_PREFIX}*`, before]);
  return described.ok ? described.out : null;
}

if (import.meta.main) {
  const [tag] = process.argv.slice(2);
  if (tag === undefined) {
    process.stderr.write("usage: bun scripts/release-check.ts <tag>\n");
    process.exit(2);
  }
  const problems = releaseProblems({ tag, version }, previousTag(tag));
  for (const problem of problems) process.stderr.write(`release-check: ${problem}\n`);
  if (problems.length > 0) process.exit(1);
  console.log(`${tag} is a release of ${version}`);
}
