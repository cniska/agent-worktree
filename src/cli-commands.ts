import { readFileSync } from "node:fs";
import { delimiter } from "node:path";
import type { JsonObject } from "@toon-format/toon";
import { unreachable } from "./assert";
import { fateRecord, fateText } from "./branches";
import { type Command, type OptionValue, result, usageRefusal } from "./cli-contract";
import { CHECK_STATES, doctor } from "./doctor";
import { parseEvent } from "./event";
import { install } from "./hooks";
import { blockText, PORT_LIMIT, type PortRequest, parsePortRequest } from "./ports";
import {
  checkout,
  type Project,
  parseName,
  resolveProject,
  type WorktreeName,
  worktreePath,
} from "./project";
import { create, init, type Listed, list, prune, remove } from "./worktrees";

function noPositionals(positionals: readonly string[], command: Command): void {
  if (positionals.length > 0)
    throw usageRefusal(
      `agent-worktree ${command.name} takes no argument, and got: ${positionals.join(" ")}`,
      command.usage,
    );
}

function namedTarget(
  positionals: readonly string[],
  command: Command,
): { project: Project; name: WorktreeName } {
  const [raw, ...rest] = positionals;
  if (raw === undefined || rest.length > 0)
    throw usageRefusal(
      `agent-worktree ${command.name} takes one worktree name, and got: ${positionals.join(" ")}`,
      command.usage,
    );
  const current = resolveProject(process.cwd());
  return { project: current, name: parseName(current, raw) };
}

type StateKind = Listed["state"]["kind"];

const NONE_IN_EACH_STATE: { readonly [Kind in StateKind]: 0 } = {
  ready: 0,
  pending: 0,
  orphaned: 0,
  unlisted: 0,
  unmanaged: 0,
  legacy: 0,
};

function branchOf(state: Listed["state"]): string | null {
  if (state.kind === "unlisted" || state.worktree === null) return null;
  return state.worktree.branch;
}

function portsOf(state: Listed["state"]): string | null {
  if (state.kind === "unmanaged" || state.block === null) return null;
  return blockText(state.block);
}

function listedRecord({ path, state }: Listed, full: boolean): JsonObject {
  if (!full) return { name: state.name, state: state.kind, path };
  return { name: state.name, state: state.kind, branch: branchOf(state), ports: portsOf(state), path };
}

function stateCounts(listed: readonly Listed[]): JsonObject {
  return Object.fromEntries(
    Object.keys(NONE_IN_EACH_STATE).map((kind) => [
      kind,
      listed.filter(({ state }) => state.kind === kind).length,
    ]),
  );
}

function listing(full: boolean): JsonObject {
  const listed = list(resolveProject(process.cwd()));
  return { counts: stateCounts(listed), worktrees: listed.map((each) => listedRecord(each, full)) };
}

type StringOption = { readonly option: string; readonly takes: string };

function stringOption(value: OptionValue, { option, takes }: StringOption, command: Command): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || value === "")
    throw usageRefusal(
      `agent-worktree ${command.name} --${option} takes ${takes}, and got none`,
      command.usage,
    );
  return value;
}

const createCommand: Command = {
  name: "create",
  usage: "agent-worktree create [--from <ref>] <name>",
  summary:
    "create the worktree, on a new branch cut from its remote's default branch as fetched now or from --from, run setup and print its path; rerun to resume a failed setup",
  options: { from: { type: "string" } },
  async run(positionals, values) {
    const from = stringOption(values.from, { option: "from", takes: "a ref" }, this);
    const target = namedTarget(positionals, this);
    const path = await create(target.project, target.name, { here: checkout(process.cwd()).toplevel, from });
    return result({ path });
  },
};

const initCommand: Command = {
  name: "init",
  usage: "agent-worktree init",
  summary: "run setup in the current checkout, primary or task worktree",
  options: {},
  async run(positionals) {
    noPositionals(positionals, this);
    const current = checkout(process.cwd());
    await init(current.project, current.toplevel);
    return result(null);
  },
};

const removeCommand: Command = {
  name: "remove",
  usage: "agent-worktree remove [--force] <name>",
  summary:
    "run teardown and remove the worktree; once its remote's default branch has the branch, delete it locally and on that remote, its upstream or, with none, its same-name branch on origin other than the default branch, keeping both copies when the remote branch holds a commit the branch lacks",
  options: { force: { type: "boolean" } },
  async run(positionals, values) {
    const target = namedTarget(positionals, this);
    const fate = remove(target.project, target.name, values.force === true);
    return result({ name: target.name, ...fateRecord(fate) });
  },
};

const pruneCommand: Command = {
  name: "prune",
  usage: "agent-worktree prune",
  summary:
    "prune git's stale worktree entries, tear down every registered worktree that is gone, and remove every one whose branch has an upstream and landed",
  options: {},
  async run(positionals) {
    noPositionals(positionals, this);
    const current = checkout(process.cwd());
    prune(current.project, current.toplevel);
    return result(null);
  },
};

const lsCommand: Command = {
  name: "ls",
  usage: "agent-worktree ls [--full]",
  summary:
    "count the worktrees in each state and list each one's name, state and path, or with --full also its branch and port block",
  options: { full: { type: "boolean" } },
  async run(positionals, values) {
    noPositionals(positionals, this);
    return result(listing(values.full === true));
  },
};

export const LIVE_VIEW: Command = lsCommand;

const pathCommand: Command = {
  name: "path",
  usage: "agent-worktree path <name>",
  summary: "print the worktree's path",
  options: {},
  async run(positionals) {
    const target = namedTarget(positionals, this);
    return result({ path: worktreePath(target.project, target.name) });
  },
};

const hookCommand: Command = {
  name: "hook",
  usage: "agent-worktree hook",
  summary: "handle a Claude Code WorktreeCreate or WorktreeRemove event read from stdin",
  options: {},
  async run(positionals) {
    noPositionals(positionals, this);
    const current = checkout(process.cwd());
    const { event, name } = parseEvent(current.project, readFileSync(0, "utf8"));
    switch (event) {
      case "WorktreeCreate":
        return {
          kind: "event",
          line: await create(current.project, name, { here: current.toplevel, from: null }),
        };
      case "WorktreeRemove":
        return { kind: "event", line: fateText(remove(current.project, name, true)) };
      default:
        return unreachable(event);
    }
  },
};

function portsOption(value: OptionValue, command: Command): PortRequest | null {
  if (value === undefined) return null;
  const request = typeof value === "string" ? parsePortRequest(value) : null;
  if (request === null)
    throw usageRefusal(
      `agent-worktree install --ports takes a whole number ${PORT_LIMIT}, and got: ${String(value)}`,
      command.usage,
    );
  return request;
}

function searchPath(): readonly string[] {
  return (process.env.PATH ?? "").split(delimiter).filter((dir) => dir !== "");
}

const doctorCommand: Command = {
  name: "doctor",
  usage: "agent-worktree doctor [--full]",
  summary:
    "report what agent-worktree and its plugin need: git and agent-worktree on PATH, port blocks held by gone worktrees, and in a project its hooks, its worktrees and their port blocks, each check ok, warn or fail with its fix; only those that warn or fail, or with --full every one; exit 1 when one fails",
  options: { full: { type: "boolean" } },
  async run(positionals, values) {
    noPositionals(positionals, this);
    const checks = doctor({ cwd: process.cwd(), searchPath: searchPath() });
    const shown = values.full === true ? checks : checks.filter((check) => check.state !== "ok");
    return {
      kind: "verdict",
      result: {
        counts: Object.fromEntries(
          CHECK_STATES.map((state) => [state, checks.filter((check) => check.state === state).length]),
        ),
        checks: shown.map(({ name, state, detail, fix }) => ({ name, state, detail, fix })),
      },
      failed: checks.some((check) => check.state === "fail"),
    };
  },
};

const installCommand: Command = {
  name: "install",
  usage: "agent-worktree install [--local] [--setup <command>] [--teardown <command>] [--ports <n>]",
  summary:
    "write the project's setup and teardown commands and port count into its hooks, or with --local into the clone's own",
  options: {
    local: { type: "boolean" },
    setup: { type: "string" },
    teardown: { type: "string" },
    ports: { type: "string" },
  },
  async run(positionals, values) {
    noPositionals(positionals, this);
    const installed = {
      setup: stringOption(values.setup, { option: "setup", takes: "a command" }, this),
      teardown: stringOption(values.teardown, { option: "teardown", takes: "a command" }, this),
      ports: portsOption(values.ports, this),
    };
    if (installed.setup === null && installed.teardown === null && installed.ports === null)
      throw usageRefusal(
        "agent-worktree install takes at least one of --setup, --teardown and --ports",
        this.usage,
      );
    const current = checkout(process.cwd());
    const hooks = install(
      current.project,
      current.toplevel,
      values.local === true ? "local" : "committed",
      installed,
    );
    return result({ hooks: [...hooks] });
  },
};

export const COMMANDS: readonly Command[] = [
  createCommand,
  initCommand,
  removeCommand,
  pruneCommand,
  lsCommand,
  pathCommand,
  hookCommand,
  installCommand,
  doctorCommand,
];
