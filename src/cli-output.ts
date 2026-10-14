import { BUG, CodedError, messageOf } from "./coded-error";

export function writeLines(lines: readonly string[]): void {
  for (const line of lines) process.stdout.write(`${line}\n`);
}

export function writeError(command: string | null, error: unknown): void {
  const [message, resolve] =
    error instanceof CodedError ? [error.message, error.resolve] : [messageOf(error), BUG];
  const prefix = command === null ? "agent-worktree" : `agent-worktree ${command}`;
  process.stderr.write(`${prefix}: ${message}\n  ${resolve}\n`);
}
