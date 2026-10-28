import { spawnSync } from "node:child_process";
import { invariant } from "./assert";
import { refuser, systemErrorCode } from "./coded-error";
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

type Env = Readonly<Record<string, string>>;

const TIMED_OUT = "ETIMEDOUT";

const HALF_MADE_WORKTREE = /\/worktrees\/[^/\s]+\/commondir: /;

const HALF_MADE_TRIES = 50;

function spawnGitOnce(repo: string, args: readonly string[], env: Env, timeout: number | undefined) {
  return spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: Number.POSITIVE_INFINITY,
    timeout,
    killSignal: "SIGKILL",
  });
}

type Spawned = ReturnType<typeof spawnGitOnce>;

function metHalfMadeWorktree(run: Spawned): boolean {
  return run.error === undefined && run.status !== 0 && HALF_MADE_WORKTREE.test(run.stderr);
}

function spawnGit(repo: string, args: readonly string[], env: Env, timeout: number | undefined): Spawned {
  const deadline = timeout === undefined ? null : performance.now() + timeout;
  const remaining = () =>
    deadline === null ? undefined : Math.max(1, Math.ceil(deadline - performance.now()));
  const attempt = (tries: number): Spawned => {
    const run = spawnGitOnce(repo, args, env, remaining());
    const timeLeft = deadline === null || performance.now() < deadline;
    return tries > 1 && timeLeft && metHalfMadeWorktree(run) ? attempt(tries - 1) : run;
  };
  return attempt(HALF_MADE_TRIES);
}

function git(repo: string, args: readonly string[], env: Env = {}): GitRun {
  const run = spawnGit(repo, args, env, undefined);
  if (run.error) throw refuse("git_unavailable", { detail: run.error.message });
  return { exit: exitOf(run), out: run.stdout.trim(), err: run.stderr.trim() };
}

function gitOutput(repo: string, args: readonly string[]): string {
  const run = git(repo, args);
  if (!succeeded(run.exit))
    throw refuse("git_failed", { repo, command: described(args), exit: run.exit, detail: run.err });
  return run.out;
}

export type GitRefusal = ReturnType<typeof refuse<"git_refused">>;

function gitRefusal(repo: string, args: readonly string[]): GitRefusal | null {
  const run = git(repo, args);
  return succeeded(run.exit) ? null : refuse("git_refused", { command: described(args), detail: run.err });
}

function gitOrRefusal(repo: string, args: readonly string[]): void {
  const refusal = gitRefusal(repo, args);
  if (refusal !== null) throw refusal;
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

const NOT_FOUND = 1;

function foundOrFault(repo: string, args: readonly string[]): GitRun | null {
  const run = git(repo, args);
  if (succeeded(run.exit)) return run;
  if (run.exit.kind === "exited" && run.exit.status === NOT_FOUND) return null;
  throw refuse("git_failed", { repo, command: described(args), exit: run.exit, detail: run.err });
}

export function branchRef(branch: string): string {
  return `refs/heads/${branch}`;
}

export function branchExists(repo: string, name: string): boolean {
  return foundOrFault(repo, ["show-ref", "--verify", "--quiet", branchRef(name)]) !== null;
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

export function checkoutWorktree(repo: string, path: string, branch: string): void {
  gitOrRefusal(repo, ["worktree", "add", path, branch]);
}

export function cutWorktree(repo: string, path: string, branch: string, base: string): void {
  gitOrRefusal(repo, ["branch", "--no-track", branch, base]);
  checkoutWorktree(repo, path, branch);
}

export function worktreeRemoval(repo: string, path: string, force: boolean): GitRefusal | null {
  return gitRefusal(repo, ["worktree", "remove", ...(force ? ["--force"] : []), path]);
}

const LOCAL_REMOTE = ".";

export type Upstream = { readonly remote: string; readonly ref: string };

export function upstreamOf(repo: string, branch: string): Upstream | null {
  const remote = foundOrFault(repo, ["config", "--get", `branch.${branch}.remote`]);
  const ref = foundOrFault(repo, ["config", "--get", `branch.${branch}.merge`]);
  if (remote === null || ref === null || remote.out === LOCAL_REMOTE) return null;
  return { remote: remote.out, ref: ref.out };
}

export function hasRemote(repo: string, remote: string): boolean {
  return foundOrFault(repo, ["config", "--get", `remote.${remote}.url`]) !== null;
}

const NO_PROMPT = { GIT_TERMINAL_PROMPT: "0" };

function firstErrorLine(run: GitRun): string {
  const [first = ""] = run.err.split("\n").filter((line) => line.trim() !== "");
  return first.trim();
}

type Online<T> = {
  readonly value: (run: GitRun) => T;
  readonly reason?: (run: GitRun) => string;
};

function gitOnline<T>(
  repo: string,
  args: readonly string[],
  timeoutMs: number,
  { value, reason = firstErrorLine }: Online<T>,
): Reached<T> {
  const run = spawnGit(repo, args, NO_PROMPT, timeoutMs);
  if (run.error !== undefined && systemErrorCode(run.error) === TIMED_OUT)
    return { kind: "failed", detail: `timed out after ${timeoutMs / 1000}s` };
  if (run.error) throw refuse("git_unavailable", { detail: run.error.message });
  const done = { exit: exitOf(run), out: run.stdout.trim(), err: run.stderr.trim() };
  if (!succeeded(done.exit)) return { kind: "failed", detail: reason(done) };
  return { kind: "reached", value: value(done) };
}

export type RemoteRefs = { readonly defaultRef: string | null; readonly heads: ReadonlyMap<string, string> };

export type Reached<T> =
  | { readonly kind: "reached"; readonly value: T }
  | { readonly kind: "failed"; readonly detail: string };

const SYMREF_LINE = /^ref: (refs\/heads\/\S+)\tHEAD$/;

const HEAD_LINE = /^([0-9a-f]+)\t(refs\/heads\/\S+)$/;

function parseRemoteRefs(out: string): RemoteRefs {
  const lines = out.split("\n");
  const defaultRef =
    lines.map((line) => line.match(SYMREF_LINE)?.[1]).find((ref) => ref !== undefined) ?? null;
  const heads = new Map(
    lines.flatMap((line) => {
      const match = line.match(HEAD_LINE);
      return match?.[1] === undefined || match[2] === undefined ? [] : [[match[2], match[1]] as const];
    }),
  );
  return { defaultRef, heads };
}

export function remoteRefs(repo: string, remote: string, timeoutMs: number): Reached<RemoteRefs> {
  return gitOnline(repo, ["ls-remote", "--symref", remote, "HEAD", "refs/heads/*"], timeoutMs, {
    value: ({ out }) => parseRemoteRefs(out),
  });
}

export function trackingRef(remote: string, ref: string): string {
  return ref.replace(/^refs\/heads\//, `refs/remotes/${remote}/`);
}

export function fetchBranch(repo: string, remote: string, ref: string, timeoutMs: number): Reached<string> {
  const tracking = trackingRef(remote, ref);
  return gitOnline(repo, ["fetch", "--quiet", "--no-tags", remote, `+${ref}:${tracking}`], timeoutMs, {
    value: () => tracking,
  });
}

export type RemoteBranch = { readonly remote: string; readonly ref: string; readonly tip: string };

const PUSH_REJECTED = "!";

function pushStatus(ref: string): (run: GitRun) => string {
  return (run) => {
    const status = run.out
      .split("\n")
      .map((line) => line.split("\t"))
      .find(([flag, refs]) => flag === PUSH_REJECTED && refs?.endsWith(`:${ref}`));
    return status?.[2] ?? firstErrorLine(run);
  };
}

export function deleteRemoteBranch(repo: string, branch: RemoteBranch, timeoutMs: number): Reached<null> {
  const lease = `--force-with-lease=${branch.ref}:${branch.tip}`;
  const args = ["push", "--porcelain", lease, branch.remote, "--delete", branch.ref];
  return gitOnline(repo, args, timeoutMs, { value: () => null, reason: pushStatus(branch.ref) });
}

export function deleteRef(repo: string, ref: string): void {
  gitOutput(repo, ["update-ref", "-d", ref]);
}

export function commitOf(repo: string, ref: string): string | null {
  return (
    foundOrFault(repo, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`])?.out ??
    null
  );
}

const SQUASH_IDENTITY = {
  GIT_AUTHOR_NAME: "agent-worktree",
  GIT_AUTHOR_EMAIL: "agent-worktree@localhost",
  GIT_COMMITTER_NAME: "agent-worktree",
  GIT_COMMITTER_EMAIL: "agent-worktree@localhost",
};

const LANDED_PATCH = /^- [0-9a-f]+$/;

export function isSquashLanded(repo: string, tip: string, into: string): boolean {
  const base = foundOrFault(repo, ["merge-base", into, tip]);
  if (base === null) return false;
  const squash = git(repo, ["commit-tree", `${tip}^{tree}`, "-p", base.out, "-m", "squash"], SQUASH_IDENTITY);
  if (!succeeded(squash.exit))
    throw refuse("git_failed", { repo, command: "git commit-tree", exit: squash.exit, detail: squash.err });
  return LANDED_PATCH.test(gitOutput(repo, ["cherry", into, squash.out, base.out]));
}

export function branchTip(repo: string, branch: string): string {
  return gitOutput(repo, ["rev-parse", "--verify", `${branchRef(branch)}^{commit}`]);
}

export function isAncestor(repo: string, commit: string, ref: string): boolean {
  return foundOrFault(repo, ["merge-base", "--is-ancestor", commit, ref]) !== null;
}

function hasBranchConfig(repo: string, branch: string): boolean {
  const run = foundOrFault(repo, ["config", "--name-only", "--get-regexp", "^branch\\."]);
  if (run === null) return false;
  return run.out.split("\n").some((key) => key.startsWith(`branch.${branch}.`));
}

export function deleteBranchAt(repo: string, branch: string, tip: string): void {
  gitOutput(repo, ["update-ref", "-d", branchRef(branch), tip]);
  if (hasBranchConfig(repo, branch)) gitOutput(repo, ["config", "--remove-section", `branch.${branch}`]);
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
