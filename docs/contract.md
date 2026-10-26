# Project Contract

The hooks a project installs for its worktrees, where those worktrees live, the ports they get and how to run the hooks without agent-worktree.

## Hooks

Any git repository works as it is. A project whose worktrees need more than a checkout installs its own commands as hooks, from its primary checkout:

```bash
agent-worktree install --setup "mise install && pnpm install --frozen-lockfile" --teardown "docker compose down -v" --ports 20
```

- Each option is optional: install writes `.worktree-hooks/setup`, `.worktree-hooks/teardown` and `.worktree-hooks/ports` for the options given, prints their paths as `hooks`, and leaves the hooks it is not given as they are. A later `install --teardown "<command>"` changes only the teardown.
- A project with no setup hook gets no setup, one with no teardown hook no teardown, and one with no ports hook no ports.
- Commit `.worktree-hooks/`; delete a hook to drop it. install never works out a command, and never stages or commits.
- A setup or teardown hook is plain shell that holds its command as `command='<command>'`, so the command shows in the diff, and runs it with `sh -ec`.
- Setup runs in the worktree being set up, teardown in the primary checkout, since the worktree may already be gone. Both run on every resume and retry, so a command must be safe to run again.

[`SPEC.md`](../SPEC.md) states what each hook gets and when it runs (§2.8), and everything else that must hold.

### Only in your clone

In a project whose other developers do not use agent-worktree, keep the hooks out of the repository with `--local`:

```bash
agent-worktree install --local --setup "pnpm install --frozen-lockfile" --ports 10
```

`--local` writes the same hooks into `worktree-hooks/` in the clone's git directory (`git rev-parse --git-common-dir`), never into the tree, so nothing is committed and every worktree of the clone shares them.

Where a clone has both, each local hook takes the place of the committed one of the same name, and a hook it lacks locally is still read from the checkout.

For such a project, enable the plugin in the project's `.claude/settings.local.json` rather than its shared `.claude/settings.json`, so it stays yours too:

```json
{ "enabledPlugins": { "cniska-worktree@cniska": true } }
```

## Where worktrees live

A task worktree lives at `${XDG_DATA_HOME:-~/.local/share}/agent-worktree/<project>-<hash>/<name>`, outside the primary checkout, so it does not pick up the primary's own config, such as its `mise.toml`. Run `agent-worktree path <name>` to find one.

- `<project>` is the primary checkout's directory name and `<hash>` is taken from its absolute path, so two clones with one name get their own directories.
- The record of which worktrees agent-worktree registered, and whether their setup finished, stays with the clone in `.git/agent-worktrees`.
- Which worktree holds which port block is kept for the whole machine in `${XDG_DATA_HOME:-~/.local/share}/agent-worktree/ports`.

### Worktrees of earlier releases

Releases before this one made worktrees at `<primary>/.claude/worktrees/<name>`. `ls` lists a worktree agent-worktree registered there as `legacy`, and `create`, `init`, `remove` and the `WorktreeRemove` hook refuse it, naming the two ways out:

- Move it to its new path with `git worktree move` and run `agent-worktree init` in it.
- Or remove it with `git worktree remove` and run `agent-worktree prune`, which runs its teardown. `prune` leaves it registered and runs no teardown for it while it is still there.

A worktree another tool made there, which agent-worktree never registered, is not its own: `ls` leaves it out and no command touches it.

## Ports

Ports are an add-on. A project whose worktrees need ports of their own, such as for a stack each worktree runs, installs how many with `--ports`, one whole number from 1 to 1000, which becomes `.worktree-hooks/ports`:

```text
20
```

agent-worktree reads that hook, never runs it, in the checkout being set up, and a project without one gets no ports and never waits for any.

- **The block.** Each task worktree of a project that asks gets its own block: the lowest free one made of enough consecutive 10-port units from 24000 to 24999 to hold the number asked for. Its hooks get the first port as `WORKTREE_PORT`, and the project's ports run from there.
- **No sharing.** A block is never worked out from the name, so two worktrees never share one, and a unit where another program already listens is skipped.
- **Finding a listener.** agent-worktree connects to the port on `127.0.0.1` and `::1`, which a program listening on every address accepts too. It never binds a port to probe it, since binding `0.0.0.0` or `::` can raise the macOS firewall prompt on every `create`, in front of an agent nobody is watching.
- **Freeing.** Blocks are shared across every clone on the machine; `ls --full` shows each worktree's, `remove` frees it, and `prune` frees those of worktrees removed some other way, even in a clone since deleted. `create` and `init` take such a block over themselves when they reach it, running a gone worktree's teardown first as `prune` would.
- **None free.** With no block free, `create` and `init` first remove the worktrees whose branch landed, as `prune` does, before refusing.
- **The primary.** The primary checkout gets no block and keeps the project's default ports, so a plain clone, such as CI's, does too.
- **Changes.** `init` gives a block to a worktree an earlier release made, resizes one whose request changed, and frees one whose project no longer asks.

[`examples/docker-compose`](../examples/docker-compose) gives each worktree its own Docker Compose stack on its own ports, with the hooks `install --setup scripts/stack-env.sh --teardown scripts/stack-down.sh --ports 2` wrote.

## Without the CLI

The hooks need nothing of agent-worktree, so a developer without it runs them by hand from the primary checkout, setting any `WORKTREE_*` variable the commands read (§2.8), with a free port for `WORKTREE_PORT`, and skipping a hook the project lacks:

```bash
git worktree add ../<name>
(cd ../<name> && .worktree-hooks/setup)
WORKTREE_NAME=<name> .worktree-hooks/teardown
git worktree remove ../<name>
```
