import { describe, expect, test } from "bun:test";
import { releaseProblems } from "./release-check";

const candidate = (version: string) => ({ tag: `v${version}`, version });

describe("a release tag", () => {
  test("passes the first release, and one newer than the previous tag", () => {
    expect(releaseProblems(candidate("0.1.0"), null)).toEqual([]);
    expect(releaseProblems(candidate("0.1.1"), "v0.1.0")).toEqual([]);
    expect(releaseProblems(candidate("0.10.0"), "v0.9.4")).toEqual([]);
    expect(releaseProblems(candidate("1.0.0"), "v0.9.0")).toEqual([]);
  });

  test("fails a tag that does not name package.json's version", () => {
    expect(releaseProblems({ tag: "v0.2.0", version: "0.1.0" }, null)).toEqual([
      "the tag v0.2.0 does not name package.json's version 0.1.0",
    ]);
  });

  test("fails a version that is not newer than the previous tag", () => {
    expect(releaseProblems(candidate("0.1.0"), "v0.1.0")).toEqual([
      "0.1.0 is not newer than the previous release v0.1.0",
    ]);
    expect(releaseProblems(candidate("0.9.0"), "v0.10.0")).toEqual([
      "0.9.0 is not newer than the previous release v0.10.0",
    ]);
  });

  test("fails a version or a previous tag that is not x.y.z", () => {
    expect(releaseProblems(candidate("0.1.0-rc.1"), null)).toEqual([
      "package.json's version 0.1.0-rc.1 is not of the form x.y.z",
    ]);
    expect(releaseProblems(candidate("0.2.0"), "v0.1")).toEqual([
      "the previous tag v0.1 names no x.y.z version",
    ]);
  });
});
