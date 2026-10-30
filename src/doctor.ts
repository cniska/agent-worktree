import { statSync } from "node:fs";
import { join } from "node:path";
import { CodedError } from "./coded-error";
import { type CommandHook, hookIn, isExecutable, portRequest } from "./hooks";
import { staleBlocks } from "./ledger";
import { type Block, blockText, isRunOf, type PortRequest } from "./ports";
import { checkout, type Project } from "./project";
import { type Listed, list, listedRefusal } from "./worktrees";

export const CHECK_STATES = ["ok", "warn", "fail"] as const;

type Problem = Exclude<(typeof CHECK_STATES)[number], "ok">;

export type Check =
  | { readonly name: string; readonly state: "ok"; readonly detail: string; readonly fix: null }
  | { readonly name: string; readonly state: Problem; readonly detail: string; readonly fix: string };

export type DoctorRequest = { readonly cwd: string; readonly searchPath: readonly string[] };

const RERUN = "then run agent-worktree doctor again";

const PROJECT_REFUSALS = ["not_a_checkout", "unsupported_layout"];

const HOOK_REFUSALS = ["hook_not_executable"];

const PORTS_REFUSALS = ["invalid_ports"];

const UNCHECKED_PROJECT: Check = {
  name: "project",
  state: "warn",
  detail: "unchecked: git is not on PATH",
  fix: `put git on PATH, ${RERUN}`,
};

function ok(name: string, detail: string): Check {
  return { name, state: "ok", detail, fix: null };
}

function refused<T>(probe: () => T, codes: readonly string[]): T | CodedError {
  try {
    return probe();
  } catch (error) {
    if (error instanceof CodedError && codes.includes(error.code)) return error;
    throw error;
  }
}

function lookUp(program: string, searchPath: readonly string[]): string | null {
  return (
    searchPath
      .map((dir) => join(dir, program))
      .find((file) => statSync(file, { throwIfNoEntry: false })?.isFile() === true && isExecutable(file)) ??
    null
  );
}

function searched(searchPath: readonly string[]): string {
  return searchPath.length === 0 ? "PATH names no directory" : `not found in ${searchPath.join(", ")}`;
}

function gitCheck(file: string | null, searchPath: readonly string[]): Check {
  if (file !== null) return ok("git", `found at ${file}`);
  return {
    name: "git",
    state: "fail",
    detail: `${searched(searchPath)}; every agent-worktree command runs git`,
    fix: `install git and put it on PATH, ${RERUN}`,
  };
}

function cliCheck(searchPath: readonly string[]): Check {
  const name = "agent-worktree";
  const file = lookUp(name, searchPath);
  if (file !== null) return ok(name, `found at ${file}`);
  return {
    name,
    state: "warn",
    detail: `${searched(searchPath)}; the plugin's WorktreeCreate and WorktreeRemove hooks run agent-worktree hook, so without it every Claude Code worktree fails to create`,
    fix: `install agent-worktree on the PATH Claude Code starts with, ${RERUN} under that PATH`,
  };
}

function staleBlocksCheck(): Check {
  const name = "port blocks";
  const stale = staleBlocks();
  if (stale.length === 0) return ok(name, "no port block is held by a worktree that is gone");
  return {
    name,
    state: "warn",
    detail: stale
      .map(({ holder, block }) => `${blockText(block)} is held by ${holder}, which is gone`)
      .join("; "),
    fix: `run agent-worktree prune in any project's checkout, which frees every such block, ${RERUN}`,
  };
}

function refusalCheck(name: string, state: Problem, refusal: CodedError): Check {
  return { name, state, detail: refusal.message, fix: refusal.resolve };
}

const HOOK_DOES: { readonly [Hook in CommandHook]: { readonly runs: string; readonly none: string } } = {
  setup: { runs: "runs in each checkout it sets up", none: "worktrees get no setup" },
  teardown: { runs: "runs in the primary checkout as each worktree goes", none: "worktrees get no teardown" },
};

function commandHookCheck(project: Project, from: string, hook: CommandHook): Check {
  const name = `${hook} hook`;
  const found = refused(() => hookIn(project, from, hook), HOOK_REFUSALS);
  if (found instanceof CodedError) return refusalCheck(name, "fail", found);
  if (found === null) return ok(name, `none in ${from}: ${HOOK_DOES[hook].none}`);
  return ok(name, `${found} ${HOOK_DOES[hook].runs}`);
}

function portsHookCheck(project: Project, from: string): Check {
  const name = "ports hook";
  const wanted = refused(() => portRequest(project, from), PORTS_REFUSALS);
  if (wanted instanceof CodedError) return refusalCheck(name, "fail", wanted);
  if (wanted === null) return ok(name, `none in ${from}: worktrees get no port block`);
  return ok(name, `each worktree asks for ${wanted.ports} ports`);
}

function stateCheck(project: Project, listed: Listed): Check {
  const { path, state } = listed;
  const name = `${state.name} worktree`;
  const refusal = listedRefusal(project, listed);
  if (refusal !== null) return refusalCheck(name, "warn", refusal);
  if (state.kind === "ready") return ok(name, `ready at ${path}`);
  return {
    name,
    state: "warn",
    detail: `its setup has not finished at ${path}`,
    fix: `run agent-worktree create ${state.name} to resume its setup, ${RERUN}`,
  };
}

function blockCheck(
  name: string,
  path: string,
  block: Block | null,
  wanted: PortRequest | null,
): Check | null {
  const reinit = `run agent-worktree init in ${path}, ${RERUN}`;
  if (wanted === null)
    return block === null
      ? null
      : {
          name,
          state: "warn",
          detail: `holds port block ${blockText(block)}, though its project asks for no ports`,
          fix: reinit,
        };
  if (block === null)
    return {
      name,
      state: "warn",
      detail: `holds no port block, though its project asks for ${wanted.ports} ports, so its hooks get no WORKTREE_PORT`,
      fix: reinit,
    };
  if (!isRunOf(block, wanted.unitCount))
    return {
      name,
      state: "warn",
      detail: `holds port block ${blockText(block)}, which is not one run of the ${wanted.ports} ports its project asks for`,
      fix: reinit,
    };
  return ok(name, `holds port block ${blockText(block)} for the ${wanted.ports} ports its project asks for`);
}

function portsCheck(project: Project, { path, state }: Listed): readonly Check[] {
  if (state.kind !== "ready" && state.kind !== "pending") return [];
  const name = `${state.name} ports`;
  const wanted = refused(() => portRequest(project, path), PORTS_REFUSALS);
  if (wanted instanceof CodedError) return [refusalCheck(name, "warn", wanted)];
  const check = blockCheck(name, path, state.block, wanted);
  return check === null ? [] : [check];
}

function projectChecks(cwd: string): readonly Check[] {
  const name = "project";
  const current = refused(() => checkout(cwd), PROJECT_REFUSALS);
  if (current instanceof CodedError) {
    if (current.code === "not_a_checkout")
      return [
        {
          name,
          state: "warn",
          detail: `${current.message}, so no project check ran`,
          fix: `run agent-worktree doctor in the project's checkout to check its hooks and worktrees`,
        },
      ];
    return [refusalCheck(name, "fail", current)];
  }
  const { project, toplevel } = current;
  const listed = list(project);
  return [
    ok(name, `${toplevel} is a checkout of ${project.primary}`),
    commandHookCheck(project, toplevel, "setup"),
    commandHookCheck(project, project.primary, "teardown"),
    portsHookCheck(project, toplevel),
    ...listed.map((each) => stateCheck(project, each)),
    ...listed.flatMap((each) => portsCheck(project, each)),
  ];
}

export function doctor({ cwd, searchPath }: DoctorRequest): readonly Check[] {
  const git = lookUp("git", searchPath);
  return [
    gitCheck(git, searchPath),
    cliCheck(searchPath),
    staleBlocksCheck(),
    ...(git === null ? [UNCHECKED_PROJECT] : projectChecks(cwd)),
  ];
}
