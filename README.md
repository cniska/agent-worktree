# agent-worktrees

One task, one worktree, set up and torn down by the project's own scripts when it has them. The `cniska-worktrees` Claude Code plugin tells every session to create and remove worktrees with the CLI. [`docs/design.md`](docs/design.md) has the design.

## Install

agent-worktrees runs on [Bun](https://bun.sh), which [mise](https://mise.jdx.dev) installs for it. With mise installed:

```bash
git clone https://github.com/cniska/agent-worktrees.git
cd agent-worktrees
mise trust && mise install
```

`mise install` installs Bun and the dependencies, and puts `agent-worktrees` in `~/.bun/bin` with `bun link`. Add that directory to your `PATH` if it is not there yet.

Then install the Claude Code plugin:

```bash
claude plugin install cniska-worktrees@cniska
```

## Project contract

Any git repository works as it is. A project whose worktrees need more than a checkout adds one or both of two scripts. `scripts/worktree-setup.sh` makes a checkout ready to work in; it runs in that checkout. `scripts/worktree-teardown.sh` releases what a worktree owns outside its directory; it runs in the primary checkout and works from the name alone, since the worktree may already be gone. Both get `WORKTREE_PATH` and `WORKTREE_PRIMARY`, and `WORKTREE_NAME` for a task worktree, unset for the primary. Both rerun on every resume and retry, so each has to be idempotent. The tool never reads their output. A script that exists but is not executable is refused, never skipped. `create` on an existing branch checks that branch out and runs the setup script as that branch has it.

## Commands

| Command | Does |
| --- | --- |
| `agent-worktrees create <name>` | Create the worktree at `.claude/worktrees/<name>` on branch `<name>`, run setup, print the path. Rerun to resume a failed setup. |
| `agent-worktrees init` | Run setup in the current checkout, primary or task worktree. |
| `agent-worktrees remove [--force] <name>` | Run teardown, remove the worktree, keep the branch. Without `--force` a dirty worktree, one with submodules or a failed teardown refuses; a locked worktree always does. |
| `agent-worktrees prune` | Prune git's stale worktree entries and tear down every worktree that is gone but still registered; refuses with the names whose teardown failed. |
| `agent-worktrees ls` | One line per worktree: name, state, branch, path. |
| `agent-worktrees path <name>` | Print the worktree's path. |
| `agent-worktrees hook` | The plugin's `WorktreeCreate` and `WorktreeRemove` entry: reads the event from stdin. |

Results go to stdout. A refusal goes to stderr with the act that resolves it, and exits 1; a usage error exits 2.

## Claude Code plugin

The `cniska-worktrees` plugin, in the `cniska` marketplace, adds a short note, `plugin/hooks/note.md`, whenever a session starts, resumes, clears or compacts. The note tells the agent to create a worktree with `create` and remove it with `remove`. Its `WorktreeCreate` and `WorktreeRemove` hooks send Claude Code's own worktrees, from EnterWorktree and a subagent's worktree isolation, through the same commands. The plugin requires the CLI on `PATH` and brings neither Bun nor the CLI, so install the CLI first.

## Development

`bun run check` runs the lint, the typecheck and the tests. [`AGENTS.md`](AGENTS.md) holds the repository's rules. The plugin lives in `plugin/`, apart from the repository root, so the CLI's `bin/` stays off the `PATH` Claude Code gives a plugin.
