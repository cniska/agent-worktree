import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { version } from "../package.json";
import {
  compiledBinary,
  curlServing,
  project,
  type Ran,
  releaseAssets,
  removeScratch,
  runOnPath,
  runProgram,
  SYSTEM_PATH,
  succeeded,
  toolsOnly,
  type World,
  world,
} from "./harness";

afterEach(removeScratch);

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
    expect(succeeded(runOnPath(w, p.dir, alone, ["create", "task-a"]))).toEqual([p.path("task-a")]);
    expect(existsSync(p.path("task-a"))).toBe(true);
    expect(succeeded(runOnPath(w, p.dir, alone, ["remove", "task-a"]))).toEqual([
      "branch task-a kept, no remote origin",
    ]);
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
  "AC-50 the npm package runs its platform's binary, and refuses on another platform and when the platform package is missing or cannot start",
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
    symlinkSync(join(modules, "agent-worktree", "bin", "agent-worktree.cjs"), join(bin, "agent-worktree"));
    const path = `${bin}:${toolsOnly(w, ["node", "git"])}`;
    const p = project(w);
    const platformPackage = `@cniska/agent-worktree-${TARGET}`;

    const manifest = join(modules, "agent-worktree", "package.json");
    const shipped = readFileSync(manifest, "utf8");
    writeFileSync(
      manifest,
      JSON.stringify({
        ...JSON.parse(shipped),
        optionalDependencies: { "@cniska/agent-worktree-plan9-mips": "9.9.9" },
      }),
    );
    expect(runOnPath(w, p.dir, path, ["--version"])).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: `agent-worktree: agent-worktree ships no build for ${TARGET}, only @cniska/agent-worktree-plan9-mips\n  build agent-worktree from source with Bun, as its README says\n`,
    });
    writeFileSync(manifest, shipped);

    expect(runOnPath(w, p.dir, path, ["--version"])).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: `agent-worktree: ${platformPackage} is not installed beside @cniska/agent-worktree\n  reinstall @cniska/agent-worktree with optional dependencies enabled\n`,
    });

    cpSync(join(tree, TARGET), join(modules, `agent-worktree-${TARGET}`), { recursive: true });
    const platformBinary = join(modules, `agent-worktree-${TARGET}`, "agent-worktree");
    chmodSync(platformBinary, 0o644);
    const unstartable = runOnPath(w, p.dir, path, ["--version"]);
    expect([unstartable.exitCode, unstartable.stdout]).toEqual([1, ""]);
    expect(unstartable.stderr).toStartWith(`agent-worktree: ${platformBinary} could not start: `);
    expect(unstartable.stderr).toEndWith("\n  reinstall @cniska/agent-worktree\n");
    chmodSync(platformBinary, 0o755);

    expect(runOnPath(w, p.dir, path, ["--version"])).toEqual({
      exitCode: 0,
      stdout: `${version}\n`,
      stderr: "",
    });
    expect(succeeded(runOnPath(w, p.dir, path, ["create", "task-a"]))).toEqual([p.path("task-a")]);
  },
  BUILD_TIMEOUT_MS,
);
