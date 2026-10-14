# agent-worktree

Owns the lifecycle of a task checkout: a git worktree a project's own scripts set up and tear down, which Claude Code reaches through the `cniska-worktree` plugin. [`SPEC.md`](SPEC.md) states what must hold and is the source of truth; it changes in the same commit as the behavior it describes. [`README.md`](README.md) has the install and the commands.

[`src/README.md`](src/README.md) maps the modules and the boundaries between them.

## Rules

- `bun run check` is the check: lint, typecheck and tests. It passes before every commit.
- The tests call the domain in process against throwaway git repos with fake scripts, assert on return values and refusal codes, and read state back with `list`. Only `src/cli.test.ts` spawns the CLI, and it pins only the wiring: usage, exit codes, the output format and one stdin round trip per hook event. Every refusal, resume, prune and both hook events have a test. Fixtures copy a format, never real data.
- A refusal is a coded error that names what was refused, its cause and the act that resolves it, and a rerun after that act converges. State is read from the ledger and the filesystem on every command, never remembered.
- Fix the cause, never work around it, and add no debt. Debt you find is fixed where it is found.
- Code carries no comments, tool contracts aside. A why goes into a name, a test, or the README.
- Commit directly to `main`, in Conventional Commits.
- Push each commit to `main` once `bun run check` passes and a fresh reviewer accepts it; that accept is the owner's standing sign-off, so no push waits on them.
