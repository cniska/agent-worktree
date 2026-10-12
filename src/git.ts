import { spawnSync } from "node:child_process";
import { invariant } from "./assert";
import { refuser } from "./coded-error";
import { describeExit, type Exit, exitOf, succeeded } from "./exit";

type GitRun = { readonly exit: Exit; readonly out: string; readonly err: string };

const refuse = refuser<{
  readonly not_a_checkout: { readonly cwd: string };
  readonly git_unavailable: { readonly detail: string };
  readonly git_refused: { readonly command: string; readonly detail: string };
  readonly git_failed: {
    readonly repo: string;
    readonly command: string;
    readonly exit: Exit;
    readonly detail: string;
  };
}>({
  not_a_checkout: {
    message: ({ cwd }) => `${cwd} is not inside a git checkout`,
    resolve: () => "cd into the project's checkout and run the command again",
  },
  git_unavailable: {
    message: ({ detail }) => `git could not run: ${detail}`,
    resolve: () => "stop and hand this error to the owner: git must be installed and on PATH",
  },
  git_refused: {
    message: ({ command, detail }) => `${command} refused: ${detail}`,
    resolve: () => "resolve what git names, then run the command again",
  },
  git_failed: {
    message: ({ command, exit, detail }) => `${command} ${describeExit(exit)}: ${detail}`,
    resolve: ({ repo }) => `stop and hand this error to the owner: git must run in ${repo}`,
  },
});

function described(args: readonly string[]): string {
  return `git ${args.join(" ")}`;
}

function git(repo: string, args: readonly string[]): GitRun {
  const run = spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: Number.POSITIVE_INFINITY,
  });
  if (run.error) throw refuse("git_unavailable", { detail: run.error.message });
  return { exit: exitOf(run), out: run.stdout.trim(), err: run.stderr.trim() };
}

function gitOutput(repo: string, args: readonly string[]): string {
  const run = git(repo, args);
  if (!succeeded(run.exit))
    throw refuse("git_failed", { repo, command: described(args), exit: run.exit, detail: run.err });
  return run.out;
}

function gitOrRefusal(repo: string, args: readonly string[]): void {
  const run = git(repo, args);
  if (!succeeded(run.exit)) throw refuse("git_refused", { command: described(args), detail: run.err });
}

type Answers<F extends readonly string[]> = { readonly [K in keyof F]: string };

function answersEach<F extends readonly string[]>(lines: readonly string[], flags: F): lines is Answers<F> {
  return lines.length === flags.length;
}

export function revParse<const F extends readonly string[]>(cwd: string, flags: F): Answers<F> {
  const run = git(cwd, ["rev-parse", "--path-format=absolute", ...flags]);
  if (!succeeded(run.exit)) throw refuse("not_a_checkout", { cwd });
  const lines = run.out.split("\n");
  invariant(answersEach(lines, flags), "git rev-parse prints one line per flag");
  return lines;
}

export function validBranchName(repo: string, name: string): boolean {
  return succeeded(git(repo, ["check-ref-format", "--branch", name]).exit);
}

function branchExists(repo: string, name: string): boolean {
  return succeeded(git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`]).exit);
}

export function isDirty(worktree: string): boolean {
  return gitOutput(worktree, ["status", "--porcelain", "--ignore-submodules=none"]) !== "";
}

const SUBMODULE_MODE = "160000 ";

export function hasSubmodules(worktree: string): boolean {
  return gitOutput(worktree, ["ls-files", "--stage"])
    .split("\n")
    .some((line) => line.startsWith(SUBMODULE_MODE));
}

export function addWorktree(repo: string, path: string, branch: string): void {
  const target = branchExists(repo, branch) ? [branch] : ["-b", branch];
  gitOrRefusal(repo, ["worktree", "add", path, ...target]);
}

export function removeWorktree(repo: string, path: string, force: boolean): void {
  gitOrRefusal(repo, ["worktree", "remove", ...(force ? ["--force"] : []), path]);
}

export function pruneWorktrees(repo: string): void {
  gitOutput(repo, ["worktree", "prune"]);
}

export type Worktree = { readonly path: string; readonly branch: string | null; readonly locked: boolean };

const WORKTREE_LINE = /^worktree (.+)$/;

function parseWorktree(block: string): Worktree {
  const lines = block.split("\n");
  const path = lines[0]?.match(WORKTREE_LINE)?.[1];
  invariant(path !== undefined, `git worktree list --porcelain block starts with a worktree line: ${block}`);
  const branch =
    lines.find((line) => line.startsWith("branch "))?.replace(/^branch refs\/heads\//, "") ?? null;
  const locked = lines.some((line) => line === "locked" || line.startsWith("locked "));
  return { path, branch, locked };
}

export function worktrees(repo: string): readonly Worktree[] {
  return gitOutput(repo, ["worktree", "list", "--porcelain"])
    .split("\n\n")
    .filter((block) => block !== "")
    .map(parseWorktree);
}
