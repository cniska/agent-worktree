#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { version } from "../package.json";
import { COMMANDS } from "./cli-commands";
import { type Command, USAGE_CODE, usageRefusal } from "./cli-contract";
import { writeError, writeLines } from "./cli-output";
import { CodedError, messageOf } from "./coded-error";

const USAGE_WIDTH = 40;

const FAILURE = 1;

const USAGE = 2;

const VERSION_FLAG = "--version";

type Described = Pick<Command, "usage" | "summary">;

const VERSION: Described = {
  usage: `agent-worktree ${VERSION_FLAG}`,
  summary: "print the version alone on one line",
};

function exitCodeOf(error: unknown): number {
  return error instanceof CodedError && error.code === USAGE_CODE ? USAGE : FAILURE;
}

function describe({ usage, summary }: Described): string {
  return `${usage.padEnd(USAGE_WIDTH)} ${summary}`;
}

async function run(command: Command, args: readonly string[]): Promise<readonly string[]> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: [...args],
      options: { ...command.options, help: { type: "boolean" } },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    throw usageRefusal(messageOf(error), command.usage);
  }
  if (parsed.values.help === true) return [describe(command)];
  return command.run(parsed.positionals, parsed.values);
}

function refuseUsage(detail: string, usage: string): void {
  writeError(null, usageRefusal(detail, usage));
  process.exitCode = USAGE;
}

const [name, ...args] = process.argv.slice(2);
const command = COMMANDS.find((candidate) => candidate.name === name);

if (name === undefined || name === "--help" || name === "-h") {
  writeLines([...COMMANDS, VERSION].map(describe));
} else if (name === VERSION_FLAG && args.length === 0) {
  writeLines([version]);
} else if (name === VERSION_FLAG) {
  refuseUsage(`${VERSION.usage} takes no argument, and got: ${args.join(" ")}`, VERSION.usage);
} else if (command === undefined) {
  refuseUsage(
    `${name} is not an agent-worktree command; agent-worktree with no command lists them`,
    `agent-worktree ${[...COMMANDS.map((candidate) => candidate.name), VERSION_FLAG].join("|")}`,
  );
} else {
  try {
    writeLines(await run(command, args));
  } catch (error) {
    writeError(command.name, error);
    process.exitCode = exitCodeOf(error);
  }
}
