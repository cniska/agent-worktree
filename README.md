# agent-worktree

> Task worktrees for coding agents: one checkout per task, set up and torn down by the project's own commands

[![CI](https://img.shields.io/github/actions/workflow/status/cniska/agent-worktree/check.yml?branch=main&style=flat&label=ci)](https://github.com/cniska/agent-worktree/actions/workflows/check.yml) [![License](https://img.shields.io/badge/license-MIT-blue?style=flat)](LICENSE)

agent-worktree never works out what a checkout needs: `agent-worktree install` writes the setup and teardown commands and the port count the project gives it into hooks, and agent-worktree runs those.

- `agent-worktree create <name>` makes a git worktree outside the repository, on a new branch cut from `origin`'s default branch as `origin` has it now, runs the project's setup hook in it, and prints its path.
- `agent-worktree remove <name>` runs the project's teardown hook, removes the worktree, and once its remote's default branch has the branch, deletes it locally and on that remote: its upstream or, with none, the branch of the same name on `origin`, other than `origin`'s default branch. When the remote branch holds a commit the branch lacks, it keeps both copies.
- The `cniska-worktree` Claude Code plugin sends Claude Code's own worktrees through the same commands.

## Install

Install the `agent-worktree` command for macOS on Apple silicon or Linux on x64 through one of these channels.

With the release's installer:

```bash
curl -fsSL https://github.com/cniska/agent-worktree/releases/latest/download/install.sh | sh
```

With Homebrew:

```bash
brew install cniska/tap/agent-worktree
```

With npm:

```bash
npm install -g @cniska/agent-worktree
```

With Bun:

```bash
bun add -g @cniska/agent-worktree
```

The curl line installs `~/.local/bin/agent-worktree` and, when that directory is not on your `PATH`, adds it to `~/.zshrc` for zsh or to an existing `~/.bashrc` or `~/.bash_profile` for bash, and otherwise asks you to add it. Each channel updates the way it installed: `brew upgrade agent-worktree`, `npm update -g @cniska/agent-worktree`, `bun update -g @cniska/agent-worktree`, or the curl line run again.

Then install the Claude Code plugin:

```bash
claude plugin install cniska-worktree@cniska
```

## Why

Two agents in one checkout overwrite each other's files, so parallel work needs a checkout per task. A bare `git worktree add` gives one that is not ready to work in, and whatever it started outside its directory, such as a database, is left running when the work is done.

Claude Code makes worktrees of its own, for EnterWorktree and for subagents, without the project's setup, and repoints git's `core.hooksPath` when it does, so a `post-checkout` hook cannot do the setup either. agent-worktree owns the whole lifecycle: it creates the worktree, runs the setup, records whether it finished, and runs the teardown before the worktree goes.

## Commands

| Command | Does |
| --- | --- |
| `agent-worktree install [--local] [--setup <command>] [--teardown <command>] [--ports <n>]` | Write the project's hooks |
| `agent-worktree create [--from <ref>] <name>` | Create the worktree, run setup, print the path |
| `agent-worktree remove [--force] <name>` | Run teardown, remove the worktree and settle its branch |
| `agent-worktree prune` | Tear down gone worktrees and remove those whose branch landed |
| `agent-worktree ls` | One line per worktree |
| `agent-worktree path <name>` | Print the worktree's path |

[Commands](docs/commands.md) lists every command, where `create` cuts a branch and how `remove` settles one.

## Docs

- [Project contract](docs/contract.md): the hooks a project installs, keeping them in your clone, where worktrees live, ports, and running the hooks without the CLI.
- [Commands](docs/commands.md): every command, its output and its branch rules.
- [Claude Code plugin](docs/plugin.md): what the plugin does and what it needs.
- [Development](docs/development.md): setup, checks, layout and rules, for working on this repo.
- [Releasing](docs/releasing.md): the release workflow, the owner's one-time setup and each release's steps.

## Related

agent-worktree works on its own in any agent workflow, and is one of the optional add-ons to [agent-skills](https://github.com/cniska/agent-skills), engineering skills for coding agents. The other add-ons:

- [agent-task](https://github.com/cniska/agent-task): task tracking for coding agents, the tasks running, in review and waiting to run
- [agent-record](https://github.com/cniska/agent-record): a session record for coding agents, every past session queryable and joined to its commits
- [agent-gates](https://github.com/cniska/agent-gates): commit gates for coding agents, git hooks and CI checks that refuse a bad commit
