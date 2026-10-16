import { readFileSync } from "node:fs";
import { unreachable } from "./assert";
import { fateText } from "./branches";
import { type Command, usageRefusal } from "./cli-contract";
import { parseEvent } from "./event";
import { install } from "./hooks";
import { note } from "./log";
import { blockText, PORT_LIMIT, type PortRequest, parsePortRequest } from "./ports";
import { checkout, type Project, parseName, project, type WorktreeName, worktreePath } from "./project";
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
  const current = project(process.cwd());
  return { project: current, name: parseName(current, raw) };
}

function stateText(state: Listed["state"]): string {
  switch (state.kind) {
    case "unmanaged":
      return "unmanaged";
    case "orphaned":
      return "orphaned (prune)";
    case "unlisted":
      return "unlisted";
    case "legacy":
      return "legacy (move or drop)";
    case "pending":
      return "setup pending";
    case "ready":
      return "ready";
    default:
      return unreachable(state);
  }
}

function branchText(state: Listed["state"]): string {
  if (state.kind === "unlisted" || state.worktree === null) return "unlisted";
  return state.worktree.branch ?? "detached";
}

const NOTHING_LISTED = "no task worktrees";

const NO_BLOCK = "-";

function portsText(state: Listed["state"]): string {
  if (state.kind === "unmanaged" || state.block === null) return NO_BLOCK;
  return blockText(state.block);
}

function listedLine({ path, state }: Listed): string {
  return [state.name, stateText(state), branchText(state), portsText(state), path].join("\t");
}

const createCommand: Command = {
  name: "create",
  usage: "agent-worktree create <name>",
  summary: "create the worktree, run setup and print its path; rerun to resume a failed setup",
  options: {},
  async run(positionals) {
    const target = namedTarget(positionals, this);
    return [await create(target.project, target.name, checkout(process.cwd()).toplevel)];
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
    return [];
  },
};

const removeCommand: Command = {
  name: "remove",
  usage: "agent-worktree remove [--force] <name>",
  summary:
    "run teardown and remove the worktree; once its remote's default branch has the branch, delete it locally and, when it was pushed with an upstream, on that remote, keeping both copies when the upstream holds a commit the branch lacks",
  options: { force: { type: "boolean" } },
  async run(positionals, values) {
    const target = namedTarget(positionals, this);
    return [fateText(remove(target.project, target.name, values.force === true))];
  },
};

const pruneCommand: Command = {
  name: "prune",
  usage: "agent-worktree prune",
  summary:
    "prune git's stale worktree entries, tear down every registered worktree that is gone, and remove every one whose pushed branch landed",
  options: {},
  async run(positionals) {
    noPositionals(positionals, this);
    const current = checkout(process.cwd());
    prune(current.project, current.toplevel);
    return [];
  },
};

const lsCommand: Command = {
  name: "ls",
  usage: "agent-worktree ls",
  summary: "list the worktrees: name, state, branch, port block, path",
  options: {},
  async run(positionals) {
    noPositionals(positionals, this);
    const lines = list(project(process.cwd())).map(listedLine);
    if (lines.length === 0) note(NOTHING_LISTED);
    return lines;
  },
};

const pathCommand: Command = {
  name: "path",
  usage: "agent-worktree path <name>",
  summary: "print the worktree's path",
  options: {},
  async run(positionals) {
    const target = namedTarget(positionals, this);
    return [worktreePath(target.project, target.name)];
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
        return [await create(current.project, name, current.toplevel)];
      case "WorktreeRemove":
        return [fateText(remove(current.project, name, true))];
      default:
        return unreachable(event);
    }
  },
};

function commandOption(value: unknown, option: string, command: Command): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || value === "")
    throw usageRefusal(`agent-worktree install --${option} takes a command, and got none`, command.usage);
  return value;
}

function portsOption(value: unknown, command: Command): PortRequest | null {
  if (value === undefined) return null;
  const request = typeof value === "string" ? parsePortRequest(value) : null;
  if (request === null)
    throw usageRefusal(
      `agent-worktree install --ports takes a whole number ${PORT_LIMIT}, and got: ${String(value)}`,
      command.usage,
    );
  return request;
}

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
      setup: commandOption(values.setup, "setup", this),
      teardown: commandOption(values.teardown, "teardown", this),
      ports: portsOption(values.ports, this),
    };
    if (installed.setup === null && installed.teardown === null && installed.ports === null)
      throw usageRefusal(
        "agent-worktree install takes at least one of --setup, --teardown and --ports",
        this.usage,
      );
    const current = checkout(process.cwd());
    return install(
      current.project,
      current.toplevel,
      values.local === true ? "local" : "committed",
      installed,
    );
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
];
