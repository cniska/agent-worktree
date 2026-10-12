export function note(text: string): void {
  process.stderr.write(`agent-worktrees: ${text}\n`);
}
