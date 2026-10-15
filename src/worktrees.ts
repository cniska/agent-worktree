import type { Dirent } from "node:fs";
import { dirname } from "node:path";
import { invariant, unreachable } from "./assert";
import {
  type BranchFate,
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
  addWorktree,
  type GitRefusal,
  hasSubmodules,
  isDirty,
  pruneWorktrees,
  type Worktree,
  worktreeRemoval,
  worktrees,
} from "./git";
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
import { portRequest, runScript, SETUP, scriptIn, TEARDOWN } from "./scripts";

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
  readonly setup_failed: { readonly checkout: string; readonly exit: Exit };
  readonly not_registered: { readonly name: string; readonly path: string };
  readonly locked: { readonly name: string; readonly path: string };
  readonly dirty: { readonly name: string; readonly path: string };
  readonly submodules: { readonly name: string; readonly path: string };
  readonly teardown_failed: { readonly name: string; readonly exit: Exit };
  readonly removals_failed: { readonly failures: readonly Failure[] };
  readonly not_a_managed_checkout: { readonly checkout: string };
  readonly legacy_location: { readonly name: string; readonly path: string; readonly target: string };
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
    message: ({ checkout, exit }) => `${SETUP} ${describeExit(exit)} in ${checkout}; setup is pending`,
    resolve: () => "fix what the script reported, then run the command again to resume",
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
    message: ({ name, exit }) => `${TEARDOWN} ${describeExit(exit)} for ${name}; the worktree is kept`,
    resolve: ({ name }) =>
      `fix what the script reported and run the command again, or run agent-worktree remove --force ${name} to remove the worktree anyway`,
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

function reap(project: Project, name: WorktreeName, path: string | null): Exit | null {
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

async function blockFor(
  project: Project,
  name: WorktreeName,
  checkout: string,
  here: string,
): Promise<Block | null> {
  const wanted = portRequest(checkout);
  if (wanted !== null)
    return claimBlock(
      project,
      name,
      wanted,
      (other) => reapGone(project, other),
      () => sweepLanded(project, new Set([here, checkout]), remotesOf(project.primary)).removed > 0,
    );
  releaseBlock(project, name);
  return null;
}

async function setUp(
  project: Project,
  name: WorktreeName | null,
  checkout: string,
  here: string,
): Promise<void> {
  const block = name === null ? null : await blockFor(project, name, checkout, here);
  const script = scriptIn(checkout, SETUP);
  if (script !== null) {
    const exit = runScript(script, checkout, { name, path: checkout, primary: project.primary, block });
    if (!succeeded(exit)) throw refuse("setup_failed", { checkout, exit });
  }
  if (name !== null) markReady(project, name);
}

function tearDown(project: Project, name: WorktreeName, path: string | null): Exit | null {
  const script = scriptIn(project.primary, TEARDOWN);
  if (script === null) return null;
  const block = blockOf(project, name);
  const exit = runScript(script, project.primary, { name, path, primary: project.primary, block });
  return succeeded(exit) ? null : exit;
}

function add(project: Project, name: WorktreeName, path: string, snap: Snapshot): void {
  const existing = caseCollision(name, knownNames(snap));
  if (existing !== null) throw refuse("case_collision", { name, existing });
  addWorktree(project.primary, path, name);
  register(project, name);
}

export async function create(project: Project, name: WorktreeName, here: string): Promise<string> {
  const path = worktreePath(project, name);
  const snap = snapshot(project);
  const state = stateIn(snap, project, name);
  switch (state.kind) {
    case "ready":
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
      add(project, name, path, snap);
      break;
    case "pending":
      break;
    default:
      return unreachable(state);
  }
  await setUp(project, name, path, here);
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
  | { readonly kind: "teardown_failed"; readonly exit: Exit }
  | { readonly kind: "git_refused"; readonly refusal: GitRefusal };

function removeAt(
  project: Project,
  name: WorktreeName,
  worktree: Worktree,
  force: boolean,
): Unremoved | null {
  const failure = tearDown(project, name, worktree.path);
  if (failure !== null && !force) return { kind: "teardown_failed", exit: failure };
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
      throw refuse("teardown_failed", { name, exit: unremoved.exit });
    case "git_refused":
      throw unremoved.refusal;
    default:
      return unreachable(unremoved);
  }
}

type Failure = { readonly name: WorktreeName; readonly cause: string };

function teardownCause(exit: Exit): string {
  return `${TEARDOWN} ${describeExit(exit)}`;
}

function causeOf(unremoved: Unremoved): string {
  switch (unremoved.kind) {
    case "teardown_failed":
      return teardownCause(unremoved.exit);
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
  await setUp(project, managedName(project, checkout), checkout, checkout);
}
