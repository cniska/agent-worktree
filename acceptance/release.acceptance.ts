import { afterEach, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { version } from "../package.json";
import {
  compiledBinary,
  curlServing,
  errorOf,
  printedPath,
  project,
  type Ran,
  releaseAssets,
  removed,
  removeScratchDirs,
  runOnPath,
  runProgram,
  SYSTEM_PATH,
  toolsOnly,
  usageRefused,
  type World,
  world,
} from "./harness";

afterEach(removeScratchDirs);

const BUILD_TIMEOUT_MS = 60_000;

const INSTALL = join(import.meta.dir, "..", "scripts", "install.sh");

const BUILD_NPM = join(import.meta.dir, "..", "scripts", "build-npm.ts");

const TARGET = `${process.platform}-${process.arch}`;

const OTHER_TARGET = TARGET === "darwin-arm64" ? "linux-x64" : "darwin-arm64";

function installing(w: World, home: string, curl: string): Ran {
  return runProgram(w, home, ["/bin/sh", INSTALL], {
    HOME: home,
    PATH: `${curl}:${SYSTEM_PATH}`,
    SHELL: "/bin/zsh",
  });
}

function unameSaying(dir: string, system: string, machine: string): string {
  const uname = join(dir, "uname");
  mkdirSync(dir, { recursive: true });
  writeFileSync(uname, `#!/bin/sh\ncase "$1" in -s) echo '${system}' ;; -m) echo '${machine}' ;; esac\n`);
  chmodSync(uname, 0o755);
  return dir;
}

function fakeBuild(dir: string, printed: string): string {
  const build = join(dir, "agent-worktree");
  mkdirSync(dir, { recursive: true });
  writeFileSync(build, `#!/bin/sh\nprintf '%s\\n' '${printed}'\n`);
  chmodSync(build, 0o755);
  return build;
}

test(
  "AC-48 the release binary, alone on PATH with git, prints its version, then creates and removes a worktree",
  () => {
    const w = world();
    const p = project(w);
    const binary = compiledBinary(join(w.root, "build"));
    const alone = `${dirname(binary)}:${toolsOnly(w, ["git"])}`;

    expect(runOnPath(w, w.root, alone, ["--version"])).toEqual({
      exitCode: 0,
      stdout: `${version}\n`,
      stderr: "",
    });
    expect(printedPath(runOnPath(w, p.dir, alone, ["create", "task-a"]))).toBe(p.path("task-a"));
    expect(existsSync(p.path("task-a"))).toBe(true);
    expect(removed(runOnPath(w, p.dir, alone, ["remove", "task-a"]))).toEqual({
      name: "task-a",
      branch: "task-a",
      outcome: "no_remote",
      remote: "origin",
    });
    expect(existsSync(p.path("task-a"))).toBe(false);
  },
  BUILD_TIMEOUT_MS,
);

test(
  "AC-49 install.sh installs the latest release after checking its checksum, and installs nothing from a bad download",
  () => {
    const w = world();
    const assets = releaseAssets(join(w.root, "assets"), compiledBinary(join(w.root, "build")), TARGET);
    const curl = curlServing(join(w.root, "fake-bin"), assets);
    const home = join(w.root, "fresh-home");
    mkdirSync(home);
    const installed = join(home, ".local", "bin", "agent-worktree");

    expect(installing(w, home, curl)).toMatchObject({ exitCode: 0, stderr: "" });
    expect(installing(w, home, curl)).toMatchObject({ exitCode: 0, stderr: "" });
    expect(runProgram(w, home, [installed, "--version"], {})).toEqual({
      exitCode: 0,
      stdout: `${version}\n`,
      stderr: "",
    });
    expect(readdirSync(join(home, ".local", "bin"))).toEqual(["agent-worktree"]);

    writeFileSync(
      join(assets, `agent-worktree-${TARGET}.sha256`),
      `${"0".repeat(64)}  agent-worktree-${TARGET}.tar.gz\n`,
    );
    const fresh = join(w.root, "another-home");
    mkdirSync(fresh);
    const refused = installing(w, fresh, curl);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("agent-worktree install: checksum mismatch for");
    expect(existsSync(join(fresh, ".local"))).toBe(false);

    for (const printed of ["", "1.2.3.4", "../x"]) {
      const mislabelled = join(w.root, `mislabelled-${printed.length}`);
      const served = curlServing(
        join(mislabelled, "bin"),
        releaseAssets(join(mislabelled, "assets"), fakeBuild(join(mislabelled, "build"), printed), TARGET),
      );
      const untouched = join(mislabelled, "home");
      mkdirSync(untouched);
      expect(installing(w, untouched, served)).toMatchObject({
        exitCode: 1,
        stderr: expect.stringContaining(
          `agent-worktree install: the downloaded agent-worktree reports version '${printed}', not x.y.z; this release is broken, so install a later one\n`,
        ),
      });
      expect(readdirSync(untouched)).toEqual([]);
    }
  },
  BUILD_TIMEOUT_MS,
);

test(
  "AC-50 the npm package runs its platform's binary with no runtime on PATH, and refuses on another platform and when the platform package is missing or cannot start",
  () => {
    const w = world();
    const assets = releaseAssets(join(w.root, "assets"), compiledBinary(join(w.root, "build")), TARGET);
    cpSync(
      join(assets, `agent-worktree-${TARGET}.tar.gz`),
      join(assets, `agent-worktree-${OTHER_TARGET}.tar.gz`),
    );
    const tree = join(w.root, "npm");
    const built = runProgram(w, w.root, [process.execPath, BUILD_NPM, assets, tree], {});
    expect([built.exitCode, built.stderr]).toEqual([0, ""]);

    const modules = join(w.root, "prefix", "lib", "node_modules", "@cniska");
    mkdirSync(modules, { recursive: true });
    cpSync(join(tree, "agent-worktree"), join(modules, "agent-worktree"), { recursive: true });
    const bin = join(w.root, "prefix", "bin");
    mkdirSync(bin);
    symlinkSync(join(modules, "agent-worktree", "bin", "agent-worktree"), join(bin, "agent-worktree"));
    const path = `${bin}:${toolsOnly(w, ["git"])}:${SYSTEM_PATH}`;
    const p = project(w);
    for (const runtime of ["node", "bun"])
      expect(
        runProgram(w, p.dir, ["/bin/sh", "-c", `command -v ${runtime}`], { PATH: path }).exitCode,
      ).not.toBe(0);
    const platformPackage = `@cniska/agent-worktree-${TARGET}`;

    const noBuild = runOnPath(w, p.dir, `${unameSaying(join(w.root, "plan9"), "Plan9", "mips")}:${path}`, [
      "--version",
    ]);
    expect([noBuild.exitCode, noBuild.stdout]).toEqual([1, ""]);
    expect(errorOf(noBuild, "agent-worktree")).toEqual({
      kind: "refusal",
      code: "no_build_for_platform",
      message: "agent-worktree ships no build for Plan9-mips, only darwin-arm64 and linux-x64",
      act: "build agent-worktree from source with Bun, as its docs/development.md says",
    });

    const missing = runOnPath(w, p.dir, path, ["--version"]);
    expect([missing.exitCode, missing.stdout]).toEqual([1, ""]);
    expect(errorOf(missing, "agent-worktree")).toEqual({
      kind: "refusal",
      code: "platform_package_missing",
      message: `${platformPackage} is not installed beside @cniska/agent-worktree`,
      act: "reinstall @cniska/agent-worktree with optional dependencies enabled",
    });

    const nested = join(modules, "agent-worktree", "node_modules", "@cniska", `agent-worktree-${TARGET}`);
    cpSync(join(tree, TARGET), nested, { recursive: true });
    const platformBinary = join(nested, "agent-worktree");
    chmodSync(platformBinary, 0o644);
    const unstartable = runOnPath(w, p.dir, path, ["--version"]);
    expect([unstartable.exitCode, unstartable.stdout]).toEqual([1, ""]);
    expect(errorOf(unstartable, "agent-worktree")).toEqual({
      kind: "refusal",
      code: "binary_not_executable",
      message: `${join(modules, "agent-worktree", "bin")}/../node_modules/${platformPackage}/agent-worktree is not executable`,
      act: "reinstall @cniska/agent-worktree",
    });
    chmodSync(platformBinary, 0o755);

    expect(runOnPath(w, p.dir, path, ["--version"])).toEqual({
      exitCode: 0,
      stdout: `${version}\n`,
      stderr: "",
    });
    expect(usageRefused(runOnPath(w, p.dir, path, ["--version", "now"]), null)).toEqual({
      message: "agent-worktree --version takes no argument, and got: now",
      act: "agent-worktree --version",
    });
    expect(printedPath(runOnPath(w, p.dir, path, ["create", "task-a"]))).toBe(p.path("task-a"));
  },
  BUILD_TIMEOUT_MS,
);
