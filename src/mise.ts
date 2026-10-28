import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { unreachable } from "./assert";
import { systemErrorCode } from "./coded-error";
import { directoryEntries } from "./directory";
import { exitOf, succeeded } from "./exit";
import { note } from "./log";

const NAMED_CONFIG_DIRS = ["", ".config"];

const CONFIG_DIRS = [".config/mise", ".config/mise/conf.d", "mise", "mise/conf.d", ".mise", ".mise/conf.d"];

const MISE_NAME = /mise|rtx/;

const TOML = /\.toml$/;

const ABSENT = "ENOENT";

function filesIn(root: string, dir: string, keep: (name: string) => boolean): readonly string[] {
  return directoryEntries(join(root, dir))
    .filter((entry) => !entry.isDirectory() && TOML.test(entry.name) && keep(entry.name))
    .map((entry) => join(dir, entry.name));
}

function miseConfigs(root: string): readonly string[] {
  return [
    ...NAMED_CONFIG_DIRS.flatMap((dir) => filesIn(root, dir, (name) => MISE_NAME.test(name))),
    ...CONFIG_DIRS.flatMap((dir) => filesIn(root, dir, () => true)),
  ];
}

function contentOf(file: string): Buffer | null {
  try {
    return readFileSync(file);
  } catch (error) {
    if (systemErrorCode(error) === ABSENT) return null;
    throw error;
  }
}

function samePrimaryConfigs(primary: string, checkout: string, configs: readonly string[]): boolean {
  return configs.every(
    (config) => contentOf(join(primary, config))?.equals(readFileSync(join(checkout, config))) === true,
  );
}

type Ran =
  | { readonly kind: "missing" }
  | { readonly kind: "failed" }
  | { readonly kind: "ran"; readonly stdout: string };

function mise(cwd: string, args: readonly string[]): Ran {
  const ran = spawnSync("mise", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (ran.error !== undefined)
    return systemErrorCode(ran.error) === ABSENT ? { kind: "missing" } : { kind: "failed" };
  return succeeded(exitOf(ran)) ? { kind: "ran", stdout: ran.stdout } : { kind: "failed" };
}

function primaryTrusted(primary: string): boolean {
  const shown = mise(primary, ["trust", "--show"]);
  return shown.kind === "ran" && shown.stdout.split("\n").includes(`${primary}: trusted`);
}

export function trustLikePrimary(primary: string, checkout: string): void {
  const configs = miseConfigs(checkout);
  if (configs.length === 0 || !samePrimaryConfigs(primary, checkout, configs) || !primaryTrusted(primary))
    return;
  const trusted = mise(checkout, ["trust", "--quiet", checkout]);
  switch (trusted.kind) {
    case "ran":
      note(`mise trusted ${checkout}, as it trusts ${primary}`);
      break;
    case "failed":
      note(`mise could not trust ${checkout}, so it is untrusted: run mise trust ${checkout}`);
      break;
    case "missing":
      break;
    default:
      unreachable(trusted);
  }
}
