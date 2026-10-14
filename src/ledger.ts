import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { directoryEntries } from "./directory";
import { type Project, storedName, type WorktreeName } from "./project";

export type Entry = { readonly name: WorktreeName; readonly ready: boolean };

const LEDGER_DIR_OF_EARLIER_RELEASES = "agent-worktrees";

function ledgerDir(project: Project): string {
  return join(project.commonDir, LEDGER_DIR_OF_EARLIER_RELEASES);
}

function entryDir(project: Project, name: WorktreeName): string {
  return join(ledgerDir(project), name);
}

function readyFile(project: Project, name: WorktreeName): string {
  return join(entryDir(project, name), "ready");
}

function entryNames(project: Project): readonly string[] {
  return directoryEntries(ledgerDir(project))
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => dirent.name);
}

function entryOf(project: Project, name: WorktreeName): Entry {
  return { name, ready: existsSync(readyFile(project, name)) };
}

export function entries(project: Project): readonly Entry[] {
  return entryNames(project).map((raw) => entryOf(project, storedName(raw)));
}

export function register(project: Project, name: WorktreeName): void {
  mkdirSync(entryDir(project, name), { recursive: true });
}

export function markReady(project: Project, name: WorktreeName): void {
  writeFileSync(readyFile(project, name), "");
}

export function unregister(project: Project, name: WorktreeName): void {
  rmSync(entryDir(project, name), { recursive: true, force: true });
}
