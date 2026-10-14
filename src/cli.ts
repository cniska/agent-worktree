#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { COMMANDS } from "./cli-commands";
import { type Command, USAGE_CODE, usageRefusal } from "./cli-contract";
import { writeError, writeLines } from "./cli-output";
import { CodedError, messageOf } from "./coded-error";

const USAGE_WIDTH = 40;

const FAILURE = 1;

const USAGE = 2;

function exitCodeOf(error: unknown): number {
  return error instanceof CodedError && error.code === USAGE_CODE ? USAGE : FAILURE;
}

function describe({ usage, summary }: Command): string {
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

const [name, ...args] = process.argv.slice(2);
const command = COMMANDS.find((candidate) => candidate.name === name);

if (name === undefined || name === "--help" || name === "-h") {
  writeLines(COMMANDS.map(describe));
} else if (command === undefined) {
  const unknown = usageRefusal(
    `${name} is not an agent-worktree command; agent-worktree with no command lists them`,
    `agent-worktree ${COMMANDS.map((candidate) => candidate.name).join("|")}`,
  );
  writeError(null, unknown);
  process.exitCode = exitCodeOf(unknown);
} else {
  try {
    writeLines(await run(command, args));
  } catch (error) {
    writeError(command.name, error);
    process.exitCode = exitCodeOf(error);
  }
}
