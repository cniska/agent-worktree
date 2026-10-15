import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fateText, remotesOf, settleBranch } from "./branches";
import { git, removeScratchDirs, repo, scratchDir, withRemote } from "./repo.test-support";

afterAll(removeScratchDirs);

function topic(dir: string, branch: string, file: string): string {
  git(dir, ["checkout", "-q", "-b", branch]);
  const tip = commit(dir, file);
  git(dir, ["checkout", "-q", "main"]);
  return tip;
}

function commit(dir: string, file: string): string {
  writeFileSync(join(dir, file), file);
  git(dir, ["add", file]);
  git(dir, ["commit", "-q", "-m", file]);
  return git(dir, ["rev-parse", "HEAD"]);
}

function landElsewhere(bare: string, refspec: string): void {
  const clone = join(scratchDir(), "elsewhere");
  git(scratchDir(), ["clone", "-q", bare, clone]);
  git(clone, ["fetch", "-q", "origin", refspec]);
  git(clone, ["merge", "-q", "--ff-only", "FETCH_HEAD"]);
  git(clone, ["push", "-q", "origin", "HEAD:main"]);
}

function squashElsewhere(bare: string, branch: string): void {
  const clone = join(scratchDir(), "elsewhere");
  git(scratchDir(), ["clone", "-q", bare, clone]);
  git(clone, ["merge", "-q", "--squash", `origin/${branch}`]);
  git(clone, ["commit", "-q", "-m", "squashed"]);
  git(clone, ["push", "-q", "origin", "main"]);
}

function remoteHeads(bare: string): string {
  return git(bare, ["for-each-ref", "--format=%(refname)", "refs/heads"]);
}

function localBranches(dir: string): string {
  return git(dir, ["for-each-ref", "--format=%(refname:short)", "refs/heads/task-*"]);
}

function settle(dir: string, branch: string | null) {
  return settleBranch(dir, branch, remotesOf(dir));
}

describe("a landed branch", () => {
  test("merged by another clone is deleted here and on the remote, judged against the fetched default branch", () => {
    const dir = repo();
    const bare = withRemote(dir, "origin");
    topic(dir, "task-a", "work");
    git(dir, ["push", "-q", "-u", "origin", "task-a"]);
    landElsewhere(bare, "task-a");
    expect(settle(dir, "task-a")).toEqual({
      kind: "deleted",
      branch: "task-a",
      landing: "merged",
      into: "refs/remotes/origin/main",
      upstream: "refs/remotes/origin/task-a",
    });
    expect(localBranches(dir)).toBe("");
    expect(remoteHeads(bare)).toBe("refs/heads/main");
    expect(git(dir, ["config", "--list"])).not.toContain("branch.task-a.");
  });

  test("whose upstream is already gone from the remote is deleted here quietly", () => {
    const dir = repo();
    const bare = withRemote(dir, "origin");
    topic(dir, "task-a", "work");
    git(dir, ["push", "-q", "-u", "origin", "task-a"]);
    landElsewhere(bare, "task-a");
    git(bare, ["update-ref", "-d", "refs/heads/task-a"]);
    const fate = settle(dir, "task-a");
    expect(fate).toEqual({
      kind: "deleted",
      branch: "task-a",
      landing: "merged",
      into: "refs/remotes/origin/main",
      upstream: null,
    });
    expect(fateText(fate)).toBe("branch task-a deleted, merged into origin/main");
    expect(localBranches(dir)).toBe("");
    expect(git(dir, ["for-each-ref", "refs/remotes/origin/task-a"])).toBe("");
  });

  test("squash-merged with its upstream gone is deleted", () => {
    const dir = repo();
    const bare = withRemote(dir, "origin");
    topic(dir, "task-a", "one");
    git(dir, ["checkout", "-q", "task-a"]);
    commit(dir, "two");
    git(dir, ["checkout", "-q", "main"]);
    git(dir, ["push", "-q", "-u", "origin", "task-a"]);
    squashElsewhere(bare, "task-a");
    git(bare, ["update-ref", "-d", "refs/heads/task-a"]);
    const fate = settle(dir, "task-a");
    expect(fateText(fate)).toBe("branch task-a deleted, squash-merged into origin/main");
    expect(localBranches(dir)).toBe("");
  });

  test("with no upstream is deleted here when the default branch has its tip, and nothing is deleted on the remote", () => {
    const dir = repo();
    const bare = withRemote(dir, "origin");
    git(bare, ["branch", "task-a", "main"]);
    topic(dir, "task-a", "work");
    git(dir, ["push", "-q", "origin", "task-a:main"]);
    expect(settle(dir, "task-a")).toMatchObject({ kind: "deleted", upstream: null });
    expect(remoteHeads(bare)).toBe("refs/heads/main\nrefs/heads/task-a");
  });

  test("whose upstream has another name has that upstream deleted", () => {
    const dir = repo();
    const bare = withRemote(dir, "origin");
    topic(dir, "task-a", "work");
    git(dir, ["push", "-q", "-u", "origin", "task-a:feature"]);
    landElsewhere(bare, "feature");
    expect(fateText(settle(dir, "task-a"))).toBe(
      "branch task-a deleted, merged into origin/main, and origin/feature deleted",
    );
    expect(remoteHeads(bare)).toBe("refs/heads/main");
  });

  test("follows the remote's own default branch", () => {
    const dir = repo();
    const bare = withRemote(dir, "origin");
    git(dir, ["push", "-q", "origin", "main:trunk"]);
    git(bare, ["symbolic-ref", "HEAD", "refs/heads/trunk"]);
    const tip = topic(dir, "task-a", "work");
    git(dir, ["push", "-q", "origin", `${tip}:refs/heads/trunk`]);
    expect(settle(dir, "task-a")).toMatchObject({ kind: "deleted", into: "refs/remotes/origin/trunk" });
  });

  test("is judged against its upstream's remote rather than origin", () => {
    const dir = repo();
    withRemote(dir, "origin");
    const fork = withRemote(dir, "fork");
    topic(dir, "task-a", "work");
    git(dir, ["push", "-q", "-u", "fork", "task-a"]);
    git(dir, ["push", "-q", "fork", "task-a:main"]);
    expect(settle(dir, "task-a")).toMatchObject({
      kind: "deleted",
      into: "refs/remotes/fork/main",
      upstream: "refs/remotes/fork/task-a",
    });
    expect(remoteHeads(fork)).toBe("refs/heads/main");
  });
});

describe("a branch kept", () => {
  test("when the default branch lacks it", () => {
    const dir = repo();
    withRemote(dir, "origin");
    topic(dir, "task-a", "work");
    git(dir, ["push", "-q", "-u", "origin", "task-a"]);
    const fate = settle(dir, "task-a");
    expect(fate).toEqual({ kind: "unmerged", branch: "task-a", into: "refs/remotes/origin/main" });
    expect(fateText(fate)).toBe("branch task-a kept, not merged into origin/main");
    expect(localBranches(dir)).toBe("task-a");
  });

  test("when squash-merged while its upstream is still on the remote", () => {
    const dir = repo();
    const bare = withRemote(dir, "origin");
    topic(dir, "task-a", "work");
    git(dir, ["push", "-q", "-u", "origin", "task-a"]);
    squashElsewhere(bare, "task-a");
    expect(settle(dir, "task-a").kind).toBe("unmerged");
    expect(remoteHeads(bare)).toBe("refs/heads/main\nrefs/heads/task-a");
  });

  test("when squash-merged with its upstream gone but a commit since", () => {
    const dir = repo();
    const bare = withRemote(dir, "origin");
    topic(dir, "task-a", "work");
    git(dir, ["push", "-q", "-u", "origin", "task-a"]);
    squashElsewhere(bare, "task-a");
    git(bare, ["update-ref", "-d", "refs/heads/task-a"]);
    git(dir, ["checkout", "-q", "task-a"]);
    commit(dir, "more");
    git(dir, ["checkout", "-q", "main"]);
    expect(settle(dir, "task-a").kind).toBe("unmerged");
    expect(localBranches(dir)).toBe("task-a");
  });

  test("when it was never pushed and only squash-merged", () => {
    const dir = repo();
    withRemote(dir, "origin");
    topic(dir, "task-a", "work");
    git(dir, ["merge", "-q", "--squash", "task-a"]);
    git(dir, ["commit", "-q", "-m", "squashed"]);
    git(dir, ["push", "-q", "origin", "main"]);
    expect(settle(dir, "task-a").kind).toBe("unmerged");
  });

  test("with its upstream when the remote's copy has commits it lacks", () => {
    const dir = repo();
    const bare = withRemote(dir, "origin");
    const tip = topic(dir, "task-a", "work");
    git(dir, ["push", "-q", "-u", "origin", "task-a"]);
    landElsewhere(bare, "task-a");
    const clone = join(scratchDir(), "ahead");
    git(scratchDir(), ["clone", "-q", "-b", "task-a", bare, clone]);
    commit(clone, "later");
    git(clone, ["push", "-q", "origin", "task-a"]);
    const fate = settle(dir, "task-a");
    expect(fateText(fate)).toBe("branch task-a kept, origin/task-a has commits it lacks");
    expect(git(dir, ["rev-parse", "task-a"])).toBe(tip);
    expect(remoteHeads(bare)).toBe("refs/heads/main\nrefs/heads/task-a");
  });

  test("with its upstream when the remote refuses to delete it", () => {
    const dir = repo();
    const bare = withRemote(dir, "origin");
    topic(dir, "task-a", "work");
    git(dir, ["push", "-q", "-u", "origin", "task-a"]);
    landElsewhere(bare, "task-a");
    const hook = join(bare, "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\necho no deletes >&2\nexit 1\n");
    chmodSync(hook, 0o755);
    expect(fateText(settle(dir, "task-a"))).toBe(
      "branch task-a kept, deleting origin/task-a failed: [remote rejected] (pre-receive hook declined)",
    );
    expect(localBranches(dir)).toBe("task-a");
  });

  test("with its upstream when the remote's copy moved after it was read", () => {
    const dir = repo();
    const bare = withRemote(dir, "origin");
    const tip = topic(dir, "task-a", "work");
    git(dir, ["push", "-q", "-u", "origin", "task-a"]);
    landElsewhere(bare, "task-a");
    const remotes = remotesOf(dir);
    remotes.view("origin");
    const clone = join(scratchDir(), "racing");
    git(scratchDir(), ["clone", "-q", "-b", "task-a", bare, clone]);
    const pushed = commit(clone, "racing");
    git(clone, ["push", "-q", "origin", "task-a"]);
    expect(fateText(settleBranch(dir, "task-a", remotes))).toBe(
      "branch task-a kept, deleting origin/task-a failed: [rejected] (stale info)",
    );
    expect(git(dir, ["rev-parse", "task-a"])).toBe(tip);
    expect(git(bare, ["rev-parse", "refs/heads/task-a"])).toBe(pushed);
  });

  test("when the remote does not answer in time", () => {
    const dir = repo();
    git(dir, ["config", "protocol.ext.allow", "always"]);
    git(dir, ["remote", "add", "origin", "ext::sleep 5"]);
    topic(dir, "task-a", "work");
    const started = performance.now();
    const fate = settleBranch(dir, "task-a", remotesOf(dir, 200));
    expect(performance.now() - started).toBeLessThan(2000);
    expect(fateText(fate)).toBe("branch task-a kept, origin could not be reached: timed out after 0.2s");
    expect(localBranches(dir)).toBe("task-a");
  });

  test("when it tracks the remote's default branch itself", () => {
    const dir = repo();
    withRemote(dir, "origin");
    git(dir, ["branch", "-q", "--track", "task-a", "origin/main"]);
    expect(fateText(settle(dir, "task-a"))).toBe("branch task-a kept, it tracks origin/main");
  });

  test("when there is no remote", () => {
    const dir = repo();
    topic(dir, "task-a", "work");
    expect(fateText(settle(dir, "task-a"))).toBe("branch task-a kept, no remote origin");
  });

  test("when the remote cannot be reached, naming why", () => {
    const dir = repo();
    git(dir, ["remote", "add", "origin", join(scratchDir(), "missing.git")]);
    topic(dir, "task-a", "work");
    const fate = settle(dir, "task-a");
    expect(fate).toMatchObject({ kind: "remote_unreachable", remote: "origin" });
    expect(fateText(fate)).toStartWith("branch task-a kept, origin could not be reached: ");
    expect(localBranches(dir)).toBe("task-a");
  });

  test("when the remote has no default branch", () => {
    const dir = repo();
    const bare = join(scratchDir(), "empty.git");
    git(scratchDir(), ["init", "-q", "--bare", "-b", "main", bare]);
    git(dir, ["remote", "add", "origin", bare]);
    topic(dir, "task-a", "work");
    expect(fateText(settle(dir, "task-a"))).toBe("branch task-a kept, origin has no default branch");
  });

  test("while another worktree has it checked out", () => {
    const dir = repo();
    withRemote(dir, "origin");
    topic(dir, "task-a", "work");
    const other = join(scratchDir(), "other");
    git(dir, ["worktree", "add", "-q", other, "task-a"]);
    expect(settle(dir, "task-a")).toEqual({ kind: "checked_out", branch: "task-a", at: other });
  });

  test("detached when there is no branch", () => {
    expect(fateText(settle(repo(), null))).toBe("detached");
  });
});

describe("remotes", () => {
  test("are asked once per command", () => {
    const dir = repo();
    withRemote(dir, "origin");
    const remotes = remotesOf(dir);
    const first = remotes.view("origin");
    git(dir, ["remote", "set-url", "origin", join(scratchDir(), "missing.git")]);
    expect(remotes.view("origin")).toBe(first);
    expect(first.kind).toBe("reached");
  });
});
