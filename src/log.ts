export function note(text: string): void {
  process.stderr.write(`agent-worktree: ${text}\n`);
}
