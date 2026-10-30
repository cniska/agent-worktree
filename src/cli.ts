#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { version } from "../package.json";
import { unreachable } from "./assert";
import { COMMANDS, LIVE_VIEW } from "./cli-commands";
import { type Command, type Output, result, USAGE_CODE, usageRefusal } from "./cli-contract";
import { writeError, writeLine, writeResult } from "./cli-output";
import { CodedError, messageOf } from "./coded-error";

const TOOL = "agent-worktree";

const FAILURE = 1;

const USAGE = 2;

const VERSION_FLAG = "--version";

type Described = Pick<Command, "usage" | "summary">;

const VERSION: Described = {
  usage: `${TOOL} ${VERSION_FLAG}`,
  summary: "print the version alone on one line",
};

function exitCodeOf(error: unknown): number {
  return error instanceof CodedError && error.code === USAGE_CODE ? USAGE : FAILURE;
}

function described({ usage, summary }: Described) {
  return { usage, summary };
}

async function run(command: Command, args: readonly string[]): Promise<Output> {
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
  if (parsed.values.help === true) return result(described(command));
  return command.run(parsed.positionals, parsed.values);
}

async function print(command: Command, args: readonly string[]): Promise<void> {
  let output: Output;
  try {
    output = await run(command, args);
  } catch (error) {
    writeError(command.name, error);
    process.exitCode = exitCodeOf(error);
    return;
  }
  switch (output.kind) {
    case "result":
      return writeResult(command.name, output.result);
    case "verdict":
      writeResult(command.name, output.result);
      if (output.failed) process.exitCode = FAILURE;
      return;
    case "event":
      return writeLine(output.line);
    default:
      return unreachable(output);
  }
}

function refuseUsage(detail: string, usage: string): void {
  writeError(TOOL, usageRefusal(detail, usage));
  process.exitCode = USAGE;
}

const [name, ...args] = process.argv.slice(2);
const command = COMMANDS.find((candidate) => candidate.name === name);

if (name === undefined) {
  await print(LIVE_VIEW, []);
} else if (name === "--help" || name === "-h") {
  writeResult(TOOL, { commands: [...COMMANDS, VERSION].map(described) });
} else if (name === VERSION_FLAG && args.length === 0) {
  writeLine(version);
} else if (name === VERSION_FLAG) {
  refuseUsage(`${VERSION.usage} takes no argument, and got: ${args.join(" ")}`, VERSION.usage);
} else if (command === undefined) {
  refuseUsage(
    `${name} is not an ${TOOL} command; ${TOOL} --help lists them`,
    `${TOOL} ${[...COMMANDS.map((candidate) => candidate.name), VERSION_FLAG].join("|")}`,
  );
} else {
  await print(command, args);
}
