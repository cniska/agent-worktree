# agent-worktrees

Task worktrees for coding agents: one task, one checkout, set up and torn down by the project's own scripts.

- `agent-worktrees create <name>` makes a git worktree at `.claude/worktrees/<name>`, runs the project's setup script in it, and prints its path.
- `agent-worktrees remove <name>` runs the project's teardown script and removes the worktree, keeping the branch.
- The `cniska-worktrees` Claude Code plugin sends Claude Code's own worktrees through the same commands.

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

## Why

Two agents in one checkout overwrite each other's files, so parallel work needs a checkout per task. A bare `git worktree add` gives a checkout that is not ready to work in: no dependencies installed, no local config, nothing the project's tooling expects. When the work is done, whatever the worktree started outside its directory, such as a database or a simulator, is left running.

Claude Code makes worktrees of its own, for EnterWorktree and for subagents with worktree isolation, and does not run the project's own setup for them. It also repoints git's shared `core.hooksPath` when it does, so a `post-checkout` hook is not a reliable place for setup either. agent-worktrees owns the whole lifecycle instead: it creates the worktree, runs the project's setup, records whether setup finished, and runs the teardown before the worktree goes.

## Project contract

Any git repository works as it is. A project whose worktrees need more than a checkout adds one or both of two scripts:

- `scripts/worktree-setup.sh` makes a checkout ready to work in. It runs in that checkout.
- `scripts/worktree-teardown.sh` releases what a worktree owns outside its directory. It runs in the primary checkout and works from the name alone, since the worktree may already be gone.

Both scripts:

- get `WORKTREE_PATH` and `WORKTREE_PRIMARY`, and `WORKTREE_NAME` for a task worktree (unset for the primary);
- rerun on every resume and retry, so each has to be idempotent;
- must be executable when they exist, or the command refuses rather than skipping them.

The tool never reads their output. `create` on an existing branch checks that branch out and runs the setup script as that branch has it.

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

The `cniska-worktrees` plugin, in the `cniska` marketplace, does two things:

- Whenever a session starts, resumes, clears or compacts, it adds a short note, `plugin/hooks/note.md`, telling the agent to create worktrees with `create` and remove them with `remove`.
- Its `WorktreeCreate` and `WorktreeRemove` hooks send EnterWorktree and a subagent's worktree isolation through the same commands.

Claude Code's ExitWorktree refuses `action: "remove"` on every worktree a hook created, clean or not ([anthropics/claude-code#100761](https://github.com/anthropics/claude-code/issues/100761)). The note therefore tells the agent to exit with `keep` and remove with `agent-worktrees remove`, which keeps the dirty-tree refusal that `discard_changes: true` would bypass.

The plugin brings neither Bun nor the CLI. Install the CLI first: with the plugin installed and no CLI on `PATH`, every Claude Code worktree fails to create.

## Development

`bun run check` runs the lint, the typecheck and the tests. [`AGENTS.md`](AGENTS.md) holds the repository's rules. The plugin lives in `plugin/`, apart from the repository root, so the CLI's `bin/` stays off the `PATH` Claude Code gives a plugin.
