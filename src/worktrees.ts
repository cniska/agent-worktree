import type { Dirent } from "node:fs";
import { invariant, unreachable } from "./assert";
import { refuser } from "./coded-error";
import { directoryEntries } from "./directory";
import { describeExit, type Exit, succeeded } from "./exit";
import {
  addWorktree,
  hasSubmodules,
  isDirty,
  pruneWorktrees,
  removeWorktree,
  type Worktree,
  worktrees,
} from "./git";
import { type Entry, entries, markReady, register, unregister } from "./ledger";
import {
  isWorktreeName,
  nameAt,
  type Project,
  type WorktreeName,
  worktreePath,
  worktreesDir,
} from "./project";
import { runScript, SETUP, scriptIn, TEARDOWN } from "./scripts";

type Registered =
  | { readonly kind: "orphaned"; readonly name: WorktreeName; readonly worktree: Worktree | null }
  | { readonly kind: "unlisted"; readonly name: WorktreeName }
  | { readonly kind: "pending"; readonly name: WorktreeName; readonly worktree: Worktree }
  | { readonly kind: "ready"; readonly name: WorktreeName; readonly worktree: Worktree };

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
  readonly teardowns_failed: { readonly names: readonly string[] };
  readonly not_a_managed_checkout: { readonly checkout: string };
}>({
  case_collision: {
    message: ({ name, existing }) => `${name} differs only in case from the existing ${existing}`,
    resolve: ({ existing }) => `use the name ${existing}, or pick a name that differs in more than case`,
  },
  unmanaged: {
    message: ({ path }) => `${path} exists but agent-worktrees did not create it`,
    resolve: ({ path }) =>
      `remove it yourself, with git worktree remove ${path} when git lists it, or pick another name`,
  },
  orphaned: {
    message: ({ name }) => `${name} is registered but its worktree is gone, so its teardown never ran`,
    resolve: () => "run agent-worktrees prune, then the command again",
  },
  not_a_worktree: {
    message: ({ name, path }) => `${name} is registered but git does not list ${path} as a worktree`,
    resolve: () => "remove the directory, then agent-worktrees prune",
  },
  setup_failed: {
    message: ({ checkout, exit }) => `${SETUP} ${describeExit(exit)} in ${checkout}; setup is pending`,
    resolve: () => "fix what the script reported, then run the command again to resume",
  },
  not_registered: {
    message: ({ name, path }) => `${name} is not a registered worktree at ${path}`,
    resolve: () => "run agent-worktrees ls to see the registered names",
  },
  locked: {
    message: ({ name, path }) => `${name} is locked at ${path}`,
    resolve: ({ path }) =>
      `run git worktree unlock ${path} when the lock's reason is over, then the command again`,
  },
  dirty: {
    message: ({ name, path }) => `${name} has uncommitted or untracked files in ${path}`,
    resolve: ({ name }) =>
      `commit or discard them, or run agent-worktrees remove --force ${name} to drop them`,
  },
  submodules: {
    message: ({ name, path }) => `${name} contains submodules in ${path}, which git removes only by force`,
    resolve: ({ name }) => `run agent-worktrees remove --force ${name}`,
  },
  teardown_failed: {
    message: ({ name, exit }) => `${TEARDOWN} ${describeExit(exit)} for ${name}; the worktree is kept`,
    resolve: ({ name }) =>
      `fix what the script reported and run the command again, or run agent-worktrees remove --force ${name} to remove the worktree anyway`,
  },
  teardowns_failed: {
    message: ({ names }) => `${TEARDOWN} failed for ${names.join(", ")}, which stay registered`,
    resolve: () => "fix what the script reported, then run agent-worktrees prune again",
  },
  not_a_managed_checkout: {
    message: ({ checkout }) => `${checkout} is neither the primary checkout nor a registered task worktree`,
    resolve: () => "cd into the primary checkout or a worktree agent-worktrees created, and run init there",
  },
});

function registeredState(registered: Entry, present: boolean, worktree: Worktree | null): Registered {
  const { name } = registered;
  if (!present) return { kind: "orphaned", name, worktree };
  if (worktree === null) return { kind: "unlisted", name };
  return { kind: registered.ready ? "ready" : "pending", name, worktree };
}

type Snapshot = {
  readonly found: readonly Dirent[];
  readonly entries: readonly Entry[];
  readonly listed: ReadonlyMap<string, Worktree>;
};

function snapshot(project: Project): Snapshot {
  return {
    found: directoryEntries(worktreesDir(project)),
    entries: entries(project),
    listed: new Map(worktrees(project.primary).map((tree) => [tree.path, tree])),
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
  return registeredState(registered, present, worktree);
}

function stateAt(project: Project, name: WorktreeName): State {
  return stateIn(snapshot(project), project, name);
}

function setUp(project: Project, name: WorktreeName | null, checkout: string): void {
  const script = scriptIn(checkout, SETUP);
  if (script !== null) {
    const exit = runScript(script, checkout, { name, path: checkout, primary: project.primary });
    if (!succeeded(exit)) throw refuse("setup_failed", { checkout, exit });
  }
  if (name !== null) markReady(project, name);
}

function tearDown(project: Project, name: WorktreeName): Exit | null {
  const script = scriptIn(project.primary, TEARDOWN);
  if (script === null) return null;
  const exit = runScript(script, project.primary, {
    name,
    path: worktreePath(project, name),
    primary: project.primary,
  });
  return succeeded(exit) ? null : exit;
}

function add(project: Project, name: WorktreeName, path: string, snap: Snapshot): void {
  const existing = caseCollision(name, knownNames(snap));
  if (existing !== null) throw refuse("case_collision", { name, existing });
  addWorktree(project.primary, path, name);
  register(project, name);
}

export function create(project: Project, name: WorktreeName): string {
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
    case "absent":
      add(project, name, path, snap);
      break;
    case "pending":
      break;
    default:
      return unreachable(state);
  }
  setUp(project, name, path);
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
    case "pending":
    case "ready":
      return state.worktree;
    default:
      return unreachable(state);
  }
}

export function remove(project: Project, name: WorktreeName, force: boolean): Worktree {
  const worktree = removable(project, name);
  if (worktree.locked) throw refuse("locked", { name, path: worktree.path });
  if (!force && hasSubmodules(worktree.path)) throw refuse("submodules", { name, path: worktree.path });
  if (!force && isDirty(worktree.path)) throw refuse("dirty", { name, path: worktree.path });
  const failure = tearDown(project, name);
  if (failure !== null && !force) throw refuse("teardown_failed", { name, exit: failure });
  removeWorktree(project.primary, worktree.path, force);
  if (failure === null) unregister(project, name);
  return worktree;
}

export function prune(project: Project): void {
  pruneWorktrees(project.primary);
  const failed: string[] = [];
  for (const { state } of list(project)) {
    if (state.kind !== "orphaned") continue;
    if (tearDown(project, state.name) === null) unregister(project, state.name);
    else failed.push(state.name);
  }
  if (failed.length > 0) throw refuse("teardowns_failed", { names: failed });
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
      return { path: worktreePath(project, name), state };
    })
    .sort(byName);
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
    case "absent":
    case "unmanaged":
    case "orphaned":
    case "unlisted":
      throw refuse("not_a_managed_checkout", { checkout });
    default:
      return unreachable(state);
  }
}

export function init(project: Project, checkout: string): void {
  setUp(project, managedName(project, checkout), checkout);
}
