#!/usr/bin/env node
const { spawn } = require("node:child_process");

const manifest = require("../package.json");
const supported = Object.keys(manifest.optionalDependencies);
const platformPackage = `@cniska/agent-worktree-${process.platform}-${process.arch}`;

function refuse(message, resolve) {
  process.stderr.write(`agent-worktree: ${message}\n  ${resolve}\n`);
  process.exit(1);
}

if (!supported.includes(platformPackage)) {
  refuse(
    `agent-worktree ships no build for ${process.platform}-${process.arch}, only ${supported.join(" and ")}`,
    "build agent-worktree from source with Bun, as its README says",
  );
}

let binary;
try {
  binary = require.resolve(`${platformPackage}/agent-worktree`);
} catch {
  refuse(
    `${platformPackage} is not installed beside @cniska/agent-worktree`,
    "reinstall @cniska/agent-worktree with optional dependencies enabled",
  );
}

const child = spawn(binary, process.argv.slice(2), { stdio: "inherit" });

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("error", (error) => {
  refuse(`${binary} could not start: ${error.message}`, "reinstall @cniska/agent-worktree");
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
