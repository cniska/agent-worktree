import type { Dirent } from "node:fs";
import { dirname } from "node:path";
import { invariant, unreachable } from "./assert";
import {
  type BranchFate,
  type CutBase,
  cutBase,
  fateText,
  hasPushedAndLanded,
  type Remotes,
  remotesOf,
  settleBranch,
} from "./branches";
import { refuser } from "./coded-error";
import { directoryEntries } from "./directory";
import { describeExit, type Exit, succeeded } from "./exit";
import {
  branchExists,
  checkoutWorktree,
  commitOf,
  cutWorktree,
  type GitRefusal,
  hasSubmodules,
  isDirty,
  pruneWorktrees,
  type Worktree,
  worktreeRemoval,
  worktrees,
} from "./git";
import { hookIn, portRequest, runHook } from "./hooks";
import {
  blockOf,
  claimBlock,
  type Entry,
  entries,
  freeStaleBlocks,
  markReady,
  register,
  releaseBlock,
  unregister,
} from "./ledger";
import { note } from "./log";
import { type Block, blockText } from "./ports";
import {
  isWorktreeName,
  legacyPath,
  nameAt,
  type Project,
  type WorktreeName,
  worktreePath,
  worktreesDir,
} from "./project";

type Held = { readonly name: WorktreeName; readonly block: Block | null };

type Registered = Held &
  (
    | { readonly kind: "orphaned"; readonly worktree: Worktree | null }
    | { readonly kind: "unlisted" }
    | { readonly kind: "legacy"; readonly worktree: Worktree }
    | { readonly kind: "pending"; readonly worktree: Worktree }
    | { readonly kind: "ready"; readonly worktree: Worktree }
  );

type Unmanaged = { readonly kind: "unmanaged"; readonly name: string; readonly worktree: Worktree | null };

type State = { readonly kind: "absent" } | Unmanaged | Registered;

export type Listed = { readonly path: string; readonly state: Unmanaged | Registered };

const refuse = refuser<{
  readonly case_collision: { readonly name: string; readonly existing: string };
  readonly unmanaged: { readonly path: string };
  readonly orphaned: { readonly name: string };
  readonly not_a_worktree: { readonly name: string; readonly path: string };
  readonly setup_failed: { readonly hook: string; readonly checkout: string; readonly exit: Exit };
  readonly not_registered: { readonly name: string; readonly path: string };
  readonly locked: { readonly name: string; readonly path: string };
  readonly dirty: { readonly name: string; readonly path: string };
  readonly submodules: { readonly name: string; readonly path: string };
  readonly teardown_failed: { readonly name: string; readonly failed: FailedTeardown };
  readonly removals_failed: { readonly failures: readonly Failure[] };
  readonly not_a_managed_checkout: { readonly checkout: string };
  readonly legacy_location: { readonly name: string; readonly path: string; readonly target: string };
  readonly branch_exists: { readonly name: string; readonly from: string };
  readonly unknown_ref: { readonly ref: string; readonly checkout: string };
  readonly remote_unreachable: { readonly name: string; readonly remote: string; readonly detail: string };
}>({
  case_collision: {
    message: ({ name, existing }) => `${name} differs only in case from the existing ${existing}`,
    resolve: ({ existing }) => `use the name ${existing}, or pick a name that differs in more than case`,
  },
  unmanaged: {
    message: ({ path }) => `${path} exists but agent-worktree did not create it`,
    resolve: ({ path }) =>
      `remove it yourself, with git worktree remove ${path} when git lists it, or pick another name`,
  },
  orphaned: {
    message: ({ name }) => `${name} is registered but its worktree is gone, so its teardown never ran`,
    resolve: () => "run agent-worktree prune, then the command again",
  },
  not_a_worktree: {
    message: ({ name, path }) => `${name} is registered but git does not list ${path} as a worktree`,
    resolve: () => "remove the directory, then agent-worktree prune",
  },
  setup_failed: {
    message: ({ hook, checkout, exit }) => `${hook} ${describeExit(exit)} in ${checkout}; setup is pending`,
    resolve: () => "fix what the hook reported, then run the command again to resume",
  },
  not_registered: {
    message: ({ name, path }) => `${name} is not a registered worktree at ${path}`,
    resolve: () => "run agent-worktree ls to see the registered names",
  },
  locked: {
    message: ({ name, path }) => `${name} is locked at ${path}`,
    resolve: ({ path }) =>
      `run git worktree unlock ${path} when the lock's reason is over, then the command again`,
  },
  dirty: {
    message: ({ name, path }) => `${name} has uncommitted or untracked files in ${path}`,
    resolve: ({ name }) =>
      `commit or discard them, or run agent-worktree remove --force ${name} to drop them`,
  },
  submodules: {
    message: ({ name, path }) => `${name} contains submodules in ${path}, which git removes only by force`,
    resolve: ({ name }) => `run agent-worktree remove --force ${name}`,
  },
  teardown_failed: {
    message: ({ name, failed }) => `${teardownCause(failed)} for ${name}; the worktree is kept`,
    resolve: ({ name }) =>
      `fix what the hook reported and run the command again, or run agent-worktree remove --force ${name} to remove the worktree anyway`,
  },
  removals_failed: {
    message: ({ failures }) =>
      `could not remove ${failures.map(({ name, cause }) => `${name} (${cause})`).join(", ")}, which stay registered`,
    resolve: () => "fix what each cause names, then run agent-worktree prune again",
  },
  not_a_managed_checkout: {
    message: ({ checkout }) => `${checkout} is neither the primary checkout nor a registered task worktree`,
    resolve: () => "cd into the primary checkout or a worktree agent-worktree created, and run init there",
  },
  legacy_location: {
    message: ({ name, path }) =>
      `${name} is at ${path}, inside the primary checkout, where agent-worktree no longer keeps worktrees`,
    resolve: ({ path, target }) =>
      `keep it with mkdir -p ${dirname(target)} && git worktree move ${path} ${target}, then agent-worktree init in ${target}; or drop it with git worktree remove ${path}, then agent-worktree prune`,
  },
  branch_exists: {
    message: ({ name, from }) => `--from ${from} would cut ${name}, but branch ${name} already exists`,
    resolve: () => "drop --from to check out the existing branch, or pick another name",
  },
  unknown_ref: {
    message: ({ ref, checkout }) => `${ref} names no commit in ${checkout}`,
    resolve: () => "name a branch, tag or commit that exists there, and run the command again",
  },
  remote_unreachable: {
    message: ({ name, remote, detail }) => `${remote} could not be reached to cut ${name}: ${detail}`,
    resolve: ({ name, remote }) =>
      `run the command again once ${remote} can be reached, or run agent-worktree create --from HEAD ${name} to cut from the HEAD of the checkout it runs in`,
  },
});

type Listing = ReadonlyMap<string, Worktree>;

function listing(project: Project): Listing {
  return new Map(worktrees(project.primary).map((tree) => [tree.path, tree]));
}

function lastListed(project: Project, name: WorktreeName, listed: Listing): Worktree | null {
  return listed.get(worktreePath(project, name)) ?? listed.get(legacyPath(project, name)) ?? null;
}

function goneState(project: Project, held: Held, listed: Listing): Registered {
  const worktree = lastListed(project, held.name, listed);
  if (worktree !== null && worktree.path !== worktreePath(project, held.name))
    return { kind: "legacy", ...held, worktree };
  return { kind: "orphaned", ...held, worktree };
}

function registeredState(
  project: Project,
  registered: Entry,
  present: boolean,
  worktree: Worktree | null,
  listed: Listing,
): Registered {
  const held: Held = { name: registered.name, block: registered.block };
  if (!present) return goneState(project, held, listed);
  if (worktree === null) return { kind: "unlisted", ...held };
  return { kind: registered.ready ? "ready" : "pending", ...held, worktree };
}

type Snapshot = {
  readonly found: readonly Dirent[];
  readonly entries: readonly Entry[];
  readonly listed: Listing;
};

function snapshot(project: Project): Snapshot {
  return {
    found: directoryEntries(worktreesDir(project)),
    entries: entries(project),
    listed: listing(project),
  };
}

function knownNames({ found, entries }: Snapshot): readonly string[] {
  return [...found.map((dirent) => dirent.name), ...entries.map((item) => item.name)];
}

function caseCollision(name: WorktreeName, known: readonly string[]): string | null {
  const folded = name.toLowerCase();
  return known.find((other) => other !== name && other.toLowerCase() === folded) ?? null;
}

function stateIn({ found, entries, listed }: Snapshot, project: Project, name: string): State {
  const path = worktreePath(project, name);
  const present = found.some((dirent) => dirent.name === name);
  const registered = entries.find((item) => item.name === name) ?? null;
  if (registered === null && !present) return { kind: "absent" };
  const worktree = listed.get(path) ?? null;
  if (registered === null) return { kind: "unmanaged", name, worktree };
  return registeredState(project, registered, present, worktree, listed);
}

function stateAt(project: Project, name: WorktreeName): State {
  return stateIn(snapshot(project), project, name);
}

function legacyRefusal(project: Project, name: WorktreeName, worktree: Worktree) {
  return refuse("legacy_location", { name, path: worktree.path, target: worktreePath(project, name) });
}

function reap(project: Project, name: WorktreeName, path: string | null): FailedTeardown | null {
  const failure = tearDown(project, name, path);
  if (failure === null) unregister(project, name);
  return failure;
}

function reapGone(project: Project, other: WorktreeName): boolean {
  const state = stateAt(project, other);
  if (state.kind !== "orphaned" || reap(project, other, state.worktree?.path ?? null) !== null) return false;
  if (state.block !== null)
    note(`port block ${blockText(state.block)} freed from ${other}, whose worktree is gone`);
  return true;
}

type Run = { readonly here: string; readonly remotes: Remotes };

async function blockFor(
  project: Project,
  name: WorktreeName,
  checkout: string,
  { here, remotes }: Run,
): Promise<Block | null> {
  const wanted = portRequest(project, checkout);
  if (wanted !== null)
    return claimBlock(
      project,
      name,
      wanted,
      (other) => reapGone(project, other),
      () => sweptBeforeClaim(project, new Set([here, checkout]), remotes),
    );
  releaseBlock(project, name);
  return null;
}

async function setUp(project: Project, name: WorktreeName | null, checkout: string, run: Run): Promise<void> {
  const block = name === null ? null : await blockFor(project, name, checkout, run);
  const hook = hookIn(project, checkout, "setup");
  if (hook !== null) {
    const exit = runHook(hook, checkout, { name, path: checkout, primary: project.primary, block });
    if (!succeeded(exit)) throw refuse("setup_failed", { hook, checkout, exit });
  }
  if (name !== null) markReady(project, name);
}

type FailedTeardown = { readonly hook: string; readonly exit: Exit };

function tearDown(project: Project, name: WorktreeName, path: string | null): FailedTeardown | null {
  const hook = hookIn(project, project.primary, "teardown");
  if (hook === null) return null;
  const block = blockOf(project, name);
  const exit = runHook(hook, project.primary, { name, path, primary: project.primary, block });
  return succeeded(exit) ? null : { hook, exit };
}

function headReason(cut: Extract<CutBase, { readonly kind: "head" }>): string {
  switch (cut.reason) {
    case "no_remote":
      return `no remote ${cut.remote}`;
    case "no_default_branch":
      return `${cut.remote} has no default branch`;
    default:
      return unreachable(cut.reason);
  }
}

const PRIMARY_HEAD = "HEAD";

export type CreateRequest = { readonly here: string; readonly from: string | null };

type Creation = Run & CreateRequest;

function baseOf(name: WorktreeName, { here, from, remotes }: Creation): string {
  if (from !== null) {
    const commit = commitOf(here, from);
    if (commit === null) throw refuse("unknown_ref", { ref: from, checkout: here });
    return commit;
  }
  const cut = cutBase(remotes);
  switch (cut.kind) {
    case "default":
      return cut.base;
    case "head":
      note(`branch ${name} cut from HEAD, ${headReason(cut)}`);
      return PRIMARY_HEAD;
    case "unreachable":
      throw refuse("remote_unreachable", { name, remote: cut.remote, detail: cut.detail });
    default:
      return unreachable(cut);
  }
}

function add(project: Project, name: WorktreeName, path: string, snap: Snapshot, creation: Creation): void {
  const existing = caseCollision(name, knownNames(snap));
  if (existing !== null) throw refuse("case_collision", { name, existing });
  const { from } = creation;
  if (!branchExists(project.primary, name)) cutWorktree(project.primary, path, name, baseOf(name, creation));
  else if (from !== null) throw refuse("branch_exists", { name, from });
  else checkoutWorktree(project.primary, path, name);
  register(project, name);
}

function ignoredFrom(name: WorktreeName, from: string | null): void {
  if (from !== null) note(`worktree ${name} exists, so --from ${from} is ignored`);
}

export async function create(project: Project, name: WorktreeName, request: CreateRequest): Promise<string> {
  const path = worktreePath(project, name);
  const snap = snapshot(project);
  const state = stateIn(snap, project, name);
  const creation: Creation = { ...request, remotes: remotesOf(project.primary) };
  const { from } = request;
  switch (state.kind) {
    case "ready":
      ignoredFrom(name, from);
      return path;
    case "unmanaged":
      throw refuse("unmanaged", { path });
    case "orphaned":
      throw refuse("orphaned", { name });
    case "unlisted":
      throw refuse("not_a_worktree", { name, path });
    case "legacy":
      throw legacyRefusal(project, name, state.worktree);
    case "absent":
      add(project, name, path, snap, creation);
      break;
    case "pending":
      ignoredFrom(name, from);
      break;
    default:
      return unreachable(state);
  }
  await setUp(project, name, path, creation);
  return path;
}

function removable(project: Project, name: WorktreeName): Worktree {
  const path = worktreePath(project, name);
  const state = stateAt(project, name);
  switch (state.kind) {
    case "absent":
      throw refuse("not_registered", { name, path });
    case "unmanaged":
      throw refuse("unmanaged", { path });
    case "orphaned":
      throw refuse("orphaned", { name });
    case "unlisted":
      throw refuse("not_a_worktree", { name, path });
    case "legacy":
      throw legacyRefusal(project, name, state.worktree);
    case "pending":
    case "ready":
      return state.worktree;
    default:
      return unreachable(state);
  }
}

type Blocker = "locked" | "submodules" | "dirty";

function blocker(worktree: Worktree, force: boolean): Blocker | null {
  if (worktree.locked) return "locked";
  if (force) return null;
  if (hasSubmodules(worktree.path)) return "submodules";
  return isDirty(worktree.path) ? "dirty" : null;
}

type Unremoved =
  | { readonly kind: "teardown_failed"; readonly failed: FailedTeardown }
  | { readonly kind: "git_refused"; readonly refusal: GitRefusal };

function removeAt(
  project: Project,
  name: WorktreeName,
  worktree: Worktree,
  force: boolean,
): Unremoved | null {
  const failure = tearDown(project, name, worktree.path);
  if (failure !== null && !force) return { kind: "teardown_failed", failed: failure };
  const refusal = worktreeRemoval(project.primary, worktree.path, force);
  if (refusal !== null) return { kind: "git_refused", refusal };
  if (failure === null) unregister(project, name);
  return null;
}

export function remove(project: Project, name: WorktreeName, force: boolean): BranchFate {
  const worktree = removable(project, name);
  const blocked = blocker(worktree, force);
  if (blocked !== null) throw refuse(blocked, { name, path: worktree.path });
  const unremoved = removeAt(project, name, worktree, force);
  if (unremoved === null) return settleBranch(project.primary, worktree.branch, remotesOf(project.primary));
  switch (unremoved.kind) {
    case "teardown_failed":
      throw refuse("teardown_failed", { name, failed: unremoved.failed });
    case "git_refused":
      throw unremoved.refusal;
    default:
      return unreachable(unremoved);
  }
}

type Failure = { readonly name: WorktreeName; readonly cause: string };

function teardownCause({ hook, exit }: FailedTeardown): string {
  return `${hook} ${describeExit(exit)}`;
}

function causeOf(unremoved: Unremoved): string {
  switch (unremoved.kind) {
    case "teardown_failed":
      return teardownCause(unremoved.failed);
    case "git_refused":
      return unremoved.refusal.message;
    default:
      return unreachable(unremoved);
  }
}

type Swept = { readonly removed: number; readonly failures: readonly Failure[] };

function isSweepable(
  project: Project,
  worktree: Worktree,
  spared: ReadonlySet<string>,
  remotes: Remotes,
): boolean {
  if (worktree.branch === null || spared.has(worktree.path) || blocker(worktree, false) !== null)
    return false;
  return hasPushedAndLanded(project.primary, worktree.branch, remotes);
}

function sweepLanded(project: Project, spared: ReadonlySet<string>, remotes: Remotes): Swept {
  const failures: Failure[] = [];
  let removed = 0;
  for (const { state } of list(project)) {
    if (state.kind !== "ready" && state.kind !== "pending") continue;
    if (!isSweepable(project, state.worktree, spared, remotes)) continue;
    const unremoved = removeAt(project, state.name, state.worktree, false);
    if (unremoved !== null) {
      failures.push({ name: state.name, cause: causeOf(unremoved) });
      continue;
    }
    removed += 1;
    note(`worktree ${state.name} removed, its branch landed`);
    note(fateText(settleBranch(project.primary, state.worktree.branch, remotes)));
  }
  return { removed, failures };
}

function sweptBeforeClaim(project: Project, spared: ReadonlySet<string>, remotes: Remotes): boolean {
  const swept = sweepLanded(project, spared, remotes);
  for (const { name, cause } of swept.failures)
    note(`worktree ${name} not removed, though its branch landed: ${cause}`);
  return swept.removed > 0;
}

export function prune(project: Project, here: string): void {
  const before = listing(project);
  pruneWorktrees(project.primary);
  const failures: Failure[] = [];
  const remotes = remotesOf(project.primary);
  for (const { state } of list(project)) {
    if (state.kind !== "orphaned") continue;
    const dropped = lastListed(project, state.name, before);
    const failure = reap(project, state.name, dropped?.path ?? null);
    if (failure !== null) failures.push({ name: state.name, cause: teardownCause(failure) });
    if (dropped !== null && dropped.branch !== null)
      note(fateText(settleBranch(project.primary, dropped.branch, remotes)));
  }
  failures.push(...sweepLanded(project, new Set([here]), remotes).failures);
  freeStaleBlocks();
  if (failures.length > 0) throw refuse("removals_failed", { failures });
}

export function list(project: Project): readonly Listed[] {
  const snap = snapshot(project);
  const registered = new Set<string>(snap.entries.map((item) => item.name));
  const visible = snap.found
    .filter(
      (dirent) =>
        !registered.has(dirent.name) && (dirent.isDirectory() || isWorktreeName(project, dirent.name)),
    )
    .map((dirent) => dirent.name);
  return [...registered, ...visible]
    .map((name) => {
      const state = stateIn(snap, project, name);
      invariant(state.kind !== "absent", `${name} is in the snapshot`);
      return { path: pathOf(project, state), state };
    })
    .sort(byName);
}

function pathOf(project: Project, state: Listed["state"]): string {
  return state.kind === "legacy" ? state.worktree.path : worktreePath(project, state.name);
}

function byName(a: Listed, b: Listed): number {
  if (a.state.name < b.state.name) return -1;
  return a.state.name > b.state.name ? 1 : 0;
}

function managedName(project: Project, checkout: string): WorktreeName | null {
  if (checkout === project.primary) return null;
  const name = nameAt(project, checkout);
  if (name === null) throw refuse("not_a_managed_checkout", { checkout });
  const state = stateAt(project, name);
  switch (state.kind) {
    case "pending":
    case "ready":
      return name;
    case "legacy":
      throw legacyRefusal(project, name, state.worktree);
    case "absent":
    case "unmanaged":
    case "orphaned":
    case "unlisted":
      throw refuse("not_a_managed_checkout", { checkout });
    default:
      return unreachable(state);
  }
}

export async function init(project: Project, checkout: string): Promise<void> {
  await setUp(project, managedName(project, checkout), checkout, {
    here: checkout,
    remotes: remotesOf(project.primary),
  });
}
