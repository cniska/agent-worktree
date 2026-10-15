import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { invariant } from "./assert";
import { refuser } from "./coded-error";
import { revParse, validBranchName } from "./git";
import { dataDir, resolvedPath } from "./paths";

export type Project = { readonly primary: string; readonly commonDir: string };

export type WorktreeName = string & { readonly __brand: "WorktreeName" };

const refuse = refuser<{
  readonly invalid_name: { readonly name: string };
  readonly unsupported_layout: { readonly commonDir: string };
}>({
  invalid_name: {
    message: ({ name }) => `${name} is not a worktree name`,
    resolve: () =>
      "name the worktree with one path segment of letters, digits, dots, underscores and dashes that git accepts as a branch name, and run the command again",
  },
  unsupported_layout: {
    message: ({ commonDir }) => `${commonDir} is not a .git directory inside the primary checkout`,
    resolve: () =>
      "run agent-worktree in a plain clone; a submodule, a bare repository and a separate git dir are not supported",
  },
});

const NAME = /^[A-Za-z0-9._-]+$/;

const GIT_DIR = ".git";

type GitPlaces = { readonly toplevel: string; readonly gitDir: string; readonly commonDir: string };

function gitPlaces(cwd: string): GitPlaces {
  const [toplevel, gitDir, commonDir] = revParse(cwd, ["--show-toplevel", "--git-dir", "--git-common-dir"]);
  return { toplevel, gitDir, commonDir };
}

function projectOf({ toplevel, gitDir, commonDir }: GitPlaces): Project {
  const primary = dirname(commonDir);
  if (basename(commonDir) !== GIT_DIR) throw refuse("unsupported_layout", { commonDir });
  if (gitDir === commonDir && primary !== toplevel) throw refuse("unsupported_layout", { commonDir });
  return { primary, commonDir };
}

export function project(cwd: string): Project {
  return projectOf(gitPlaces(cwd));
}

export function checkout(cwd: string): { readonly toplevel: string; readonly project: Project } {
  const places = gitPlaces(cwd);
  return { toplevel: places.toplevel, project: projectOf(places) };
}

function hasNameShape(raw: string): raw is WorktreeName {
  return NAME.test(raw);
}

function nameOrNull(project: Project, raw: string): WorktreeName | null {
  return hasNameShape(raw) && validBranchName(project.primary, raw) ? raw : null;
}

export function storedName(raw: string): WorktreeName {
  invariant(hasNameShape(raw), `${raw} in the ledger is a worktree name`);
  return raw;
}

export function isWorktreeName(project: Project, segment: string): boolean {
  return nameOrNull(project, segment) !== null;
}

export function parseName(project: Project, raw: string): WorktreeName {
  const name = nameOrNull(project, raw);
  if (name === null) throw refuse("invalid_name", { name: raw });
  return name;
}

const KEY_HASH_LENGTH = 8;

function projectKey(project: Project): string {
  const hash = createHash("sha256").update(project.primary).digest("hex").slice(0, KEY_HASH_LENGTH);
  return `${basename(project.primary)}-${hash}`;
}

export function worktreesDir(project: Project): string {
  return join(resolvedPath(dataDir()), projectKey(project));
}

export function worktreePath(project: Project, segment: string): string {
  return join(worktreesDir(project), segment);
}

export function legacyPath(project: Project, segment: string): string {
  return join(project.primary, ".claude", "worktrees", segment);
}

export function nameAt(project: Project, path: string): WorktreeName | null {
  const name = nameOrNull(project, basename(path));
  if (name === null) return null;
  return path === worktreePath(project, name) || path === legacyPath(project, name) ? name : null;
}
