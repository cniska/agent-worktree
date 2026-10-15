# agent-worktree

Owns the lifecycle of a task checkout: a git worktree the project's own setup and teardown hooks set up and tear down, which Claude Code reaches through the `cniska-worktree` plugin. [`SPEC.md`](SPEC.md) states what must hold and is the source of truth; it changes in the same commit as the behavior it describes. [`README.md`](README.md) has the install and the commands, and [`docs/releasing.md`](docs/releasing.md) how a release is cut.

[`src/README.md`](src/README.md) maps the modules and the boundaries between them.

## Rules

- `bun run check` is the check: lint, typecheck, knip (unused exports, files and dependencies) and tests. It passes before every commit.
- The tests call the domain in process against throwaway git repos with fake hooks, assert on return values and refusal codes, and read state back with `list`. Among them only `src/cli.test.ts` spawns the CLI, and it pins only the wiring: usage, exit codes, the output format and one stdin round trip per hook event. Every refusal, resume, prune and both hook events have a test. Fixtures copy a format, never real data.
- `bun run acceptance` proves SPEC.md's criteria: each test in `acceptance/*.acceptance.ts` drives the CLI alone in a scratch home and repo, and its name starts with the criteria it proves. `src/spec.test.ts`, part of the check, fails when a criterion has no test or todo, a test cites none, or a requirement no criterion cites.
- A refusal is a coded error that names what was refused, its cause and the act that resolves it, and a rerun after that act converges. State is read from the ledger and the filesystem on every command, never remembered.
- Fix the cause, never work around it, and add no debt. Debt you find is fixed where it is found.
- This repo requires no other cniska tool, and names none, nor any skill, agent, plugin install, report shape or project that uses it, in src, SPEC, README, plugin, examples or tests; the one exception is the README's contributor section, which may suggest cniska-skills. `scripts/standalone.test.ts`, in the check, refuses the names it knows.
- Code carries no comments, tool contracts aside. A why goes into a name, a test, or the README.
- Work each task on a topic branch in its own worktree. Commit each slice there, in Conventional Commits, once `bun run check` passes and a fresh reviewer accepts it, and push the branch after each.
- Land a task as a whole, with no pull request: once a fresh reviewer, given the branch's whole diff against `main`, accepts it (for a one-commit branch, that commit's accept), fast-forward `main` to the branch, push `main` and delete the branch on origin. That accept is the owner's standing sign-off, so no landing waits on them.
