# agent-worktree

Task worktrees, so coding agents working in parallel never share a checkout: each task gets its own, set up and torn down by the project's own scripts. agent-worktree never works out, writes or installs what a checkout needs; the project's `scripts/worktree-setup.sh` and `scripts/worktree-teardown.sh` do.

- `agent-worktree create <name>` makes a git worktree outside the repository, runs the project's setup script in it, and prints its path.
- `agent-worktree remove <name>` runs the project's teardown script and removes the worktree, keeping the branch.
- The `cniska-worktree` Claude Code plugin sends Claude Code's own worktrees through the same commands.

## Install

agent-worktree runs on [Bun](https://bun.sh), which [mise](https://mise.jdx.dev) installs for it. With mise installed:

```bash
git clone https://github.com/cniska/agent-worktree.git
cd agent-worktree
mise trust && mise install
```

`mise install` installs Bun and the dependencies, and in the clone, never in a worktree, puts `agent-worktree` in `~/.bun/bin` with `bun link`, so removing a worktree never leaves the command pointing at a deleted checkout. Add that directory to your `PATH` if it is not there yet.

Then install the Claude Code plugin:

```bash
claude plugin install cniska-worktree@cniska
```

## Why

Two agents in one checkout overwrite each other's files, so parallel work needs a checkout per task. A bare `git worktree add` gives a checkout that is not ready to work in: no dependencies installed, no local config, nothing the project's tooling expects. When the work is done, whatever the worktree started outside its directory, such as a database or a simulator, is left running.

Claude Code makes worktrees of its own, for EnterWorktree and for subagents with worktree isolation, and does not run the project's own setup for them. It also repoints git's shared `core.hooksPath` when it does, so a `post-checkout` hook is not a reliable place for setup either. agent-worktree owns the whole lifecycle instead: it creates the worktree, runs the project's setup, records whether setup finished, and runs the teardown before the worktree goes.

## Where worktrees live

A task worktree lives at `${XDG_DATA_HOME:-~/.local/share}/agent-worktree/<project>-<hash>/<name>`, outside the primary checkout, so it does not pick up the primary's own config, such as its `mise.toml`. `<project>` is the primary checkout's directory name and `<hash>` is taken from its absolute path, so two clones with one name get their own directories. Run `agent-worktree path <name>` to find one. The record of which worktrees agent-worktree registered, and whether their setup finished, stays with the clone in `.git/agent-worktrees`; which worktree holds which port block is kept for the whole machine in `${XDG_DATA_HOME:-~/.local/share}/agent-worktree/ports`.

Releases before this one made worktrees at `<primary>/.claude/worktrees/<name>`. `ls` lists such a worktree as `legacy`, and every other command refuses it, naming the two ways out: move it to its new path with `git worktree move` and run `agent-worktree init` in it, or remove it with `git worktree remove` and run `agent-worktree prune`, which runs its teardown.

## Project contract

Any git repository works as it is. A project whose worktrees need more than a checkout adds `scripts/worktree-setup.sh`, `scripts/worktree-teardown.sh`, or both. [`SPEC.md`](SPEC.md) states what each gets and when it runs (§2.8), and everything else that must hold.

### Ports

Each task worktree gets its own block of 10 ports, the lowest free one from 24000 to 24999, and its scripts get the first as `WORKTREE_PORT`; the block runs to `WORKTREE_PORT` + 9. A block is never worked out from the name, so two worktrees never share one, and a block where another program already listens is skipped. agent-worktree finds a listener by connecting to the port on `127.0.0.1` and `::1`, which a program listening on every address accepts too; it never binds a port to probe it, since binding `0.0.0.0` or `::` can raise the macOS firewall prompt on every `create`, in front of an agent nobody is watching. Blocks are shared across every clone on the machine; `ls` shows each worktree's, `remove` frees it, and `prune` frees those of worktrees removed some other way, even in a clone since deleted. The primary checkout gets no block and keeps the project's default ports, so a plain clone, such as CI's, does too. `init` gives a block to a worktree an earlier release made.

A project that runs its services with Docker Compose gives each worktree its own stack. The compose file keeps the defaults for the primary, as in `"${WEB_PORT:-3000}:3000"`. `scripts/worktree-setup.sh` writes the worktree's `.env`, which Compose reads:

```sh
#!/bin/sh
set -eu
[ -n "${WORKTREE_NAME:-}" ] || exit 0
cat > .env <<EOF
COMPOSE_PROJECT_NAME=$(printf 'myapp-%s' "$WORKTREE_NAME" | tr 'A-Z.' 'a-z_')
WEB_PORT=$WORKTREE_PORT
DB_PORT=$((WORKTREE_PORT + 1))
EOF
```

`scripts/worktree-teardown.sh` removes the stack and its volumes. It runs in the primary checkout, where the worktree's `.env` may already be gone, so it names the stack itself:

```sh
#!/bin/sh
set -eu
docker compose --project-name "$(printf 'myapp-%s' "$WORKTREE_NAME" | tr 'A-Z.' 'a-z_')" down -v
```

Keep `.env` out of git.

### Without the CLI

Run the same scripts by hand from the primary checkout, setting any `WORKTREE_*` variable a script reads (§2.8), with a free port for `WORKTREE_PORT`, and skipping one the project lacks:

```bash
git worktree add ../<name>
(cd ../<name> && scripts/worktree-setup.sh)
scripts/worktree-teardown.sh
git worktree remove ../<name>
```

## Commands

| Command | Does |
| --- | --- |
| `agent-worktree create <name>` | Create the worktree on branch `<name>`, run setup, print the path. Rerun to resume a failed setup. |
| `agent-worktree init` | Run setup in the current checkout, primary or task worktree. |
| `agent-worktree remove [--force] <name>` | Run teardown, remove the worktree, keep the branch. Without `--force` a dirty worktree, one with submodules or a failed teardown refuses; a locked worktree always does. |
| `agent-worktree prune` | Prune git's stale worktree entries and tear down every worktree that is gone but still registered; refuses with the names whose teardown failed. |
| `agent-worktree ls` | One line per worktree: name, state, branch, port block, path. |
| `agent-worktree path <name>` | Print the worktree's path. |
| `agent-worktree hook` | The plugin's `WorktreeCreate` and `WorktreeRemove` entry: reads the event from stdin. |

Results go to stdout. A refusal goes to stderr with the act that resolves it, and exits 1; a usage error exits 2.

## Claude Code plugin

The `cniska-worktree` plugin, in the `cniska` marketplace, does two things:

- Whenever a session starts, resumes, clears or compacts, it adds a short note, `plugin/hooks/note.md`, telling the agent to create worktrees with `create` and remove them with `remove`.
- Its `WorktreeCreate` and `WorktreeRemove` hooks send EnterWorktree and a subagent's worktree isolation through the same commands.

Claude Code's ExitWorktree refuses `action: "remove"` on every worktree a hook created, clean or not ([anthropics/claude-code#100761](https://github.com/anthropics/claude-code/issues/100761)). The note therefore tells the agent to exit with `keep` and remove with `agent-worktree remove`, which keeps the dirty-tree refusal that `discard_changes: true` would bypass.

The plugin brings neither Bun nor the CLI. Install the CLI first: with the plugin installed and no CLI on `PATH`, every Claude Code worktree fails to create.

## Development

### Setup

```bash
mise trust && mise install
bin/agent-worktree create <name>
agent-gates doctor
```

- `mise install` sets up the clone as [Install](#install) says, and the `bun install` its postinstall runs calls the `prepare` script, which points `core.hooksPath` at `.githooks/`.
- `bin/agent-worktree create <name>` makes a task worktree and runs `scripts/worktree-setup.sh` in it, which installs the same way without linking the CLI.
- `.githooks/` holds the commit-subject, format and no-comments gates that [agent-gates](https://github.com/cniska/agent-gates) installs, and `agent-gates doctor` reports their health.

### Checks

- `bun run check` runs the lint, the typecheck and the tests, and `.githooks/pre-commit.d/check` runs it before each commit.
- `bun run acceptance` proves the criteria in [`SPEC.md`](SPEC.md) through the CLI alone, as [`AGENTS.md`](AGENTS.md) describes.
- `bun run format` formats `src/` and `acceptance/` with Biome, and the format gate runs it with the linter off before each commit and stages what it changes in the staged files.
- `.github/workflows/check.yml` runs the check and the acceptance suite on each push and pull request, and `commits.yml`, `format.yml` and `no-comments.yml` run the gates.

### Layout

- The plugin lives in `plugin/`, apart from the repository root, so the CLI's `bin/` stays off the `PATH` Claude Code gives a plugin.
- [`src/README.md`](src/README.md) maps the modules and the boundaries between them.

### Rules

[`AGENTS.md`](AGENTS.md) holds the repository's rules, and [`SPEC.md`](SPEC.md) states what must hold.
