# Claude Code Plugin

The `cniska-worktree` plugin, in the `cniska` marketplace, sends Claude Code's own worktrees through agent-worktree.

## What it does

- Whenever a session starts, resumes, clears or compacts, it adds a short note, `plugin/hooks/note.md`, telling the agent to create worktrees with `create` and remove them with `remove`.
- Its `WorktreeCreate` and `WorktreeRemove` hooks send EnterWorktree and a subagent's worktree isolation through the same commands.

Claude Code's ExitWorktree refuses `action: "remove"` on every worktree a hook created, clean or not ([anthropics/claude-code#100761](https://github.com/anthropics/claude-code/issues/100761)). The note therefore tells the agent to exit with `keep` and remove with `agent-worktree remove`, which keeps the dirty-tree refusal that `discard_changes: true` would bypass.

## Install

The plugin brings neither Bun nor the CLI. Install the CLI first, as the [README](../README.md#install) says: with the plugin installed and no CLI on `PATH`, every Claude Code worktree fails to create.

To keep the plugin out of a project's shared settings, enable it only in your clone, as [Only in your clone](contract.md#only-in-your-clone) says.
