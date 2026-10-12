import { type Dirent, existsSync, readdirSync } from "node:fs";

export function directoryEntries(dir: string): readonly Dirent[] {
  return existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : [];
}
