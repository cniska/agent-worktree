# Commands

The `agent-worktree` commands, where `create` cuts a branch and how `remove` settles one.

| Command | Does |
| --- | --- |
| `agent-worktree create [--from <ref>] <name>` | Create the worktree on branch `<name>`, as [Where `create` cuts a branch](#where-create-cuts-a-branch) says, run setup, print the path. Rerun to resume a failed setup. |
| `agent-worktree init` | Run setup in the current checkout, primary or task worktree. |
| `agent-worktree remove [--force] <name>` | Run teardown and remove the worktree, then settle its branch as [How `remove` settles a branch](#how-remove-settles-a-branch) says. Without `--force` a dirty worktree, one with submodules or a failed teardown refuses; a locked worktree always does. |
| `agent-worktree prune` | Prune git's stale worktree entries, tear down every worktree that is gone but still registered, and remove every clean worktree whose pushed branch landed, other than the one it runs in, settling each one's branch as `remove` does; refuses with the names whose teardown failed. |
| `agent-worktree ls` | One line per worktree: name, state, branch, port block, path. |
| `agent-worktree path <name>` | Print the worktree's path. |
| `agent-worktree hook` | The plugin's `WorktreeCreate` and `WorktreeRemove` entry: reads the event from stdin. |
| `agent-worktree install [--local] [--setup <command>] [--teardown <command>] [--ports <n>]` | Write the hook each option names into `.worktree-hooks/`, or with `--local` into the clone's git directory, leaving the others as they are, and print each path. |
| `agent-worktree --version` | Print the version alone on one line. |

Results go to stdout. A refusal goes to stderr with the act that resolves it, and exits 1; a usage error exits 2.

## Where `create` cuts a branch

An existing branch `<name>` is checked out. A new one is cut with no upstream, so `remove` and `prune` settle it as `create` made it:

- **Without `--from`**, from `origin`'s default branch, which `create` reads and fetches first, as `remove` does. With no `origin`, or one with no default branch, it is cut from the primary's HEAD, with a note on stderr. When `origin` cannot be reached within 60 seconds, `create` refuses and names `--from HEAD`, rather than cut from a base that may trail.
- **With `--from <ref>`**, from the commit `<ref>` names in the checkout `create` runs in, without reaching a remote. `--from` with an existing branch refuses, and on a worktree `create` already made it is ignored, so a rerun resumes a failed setup.

## How `remove` settles a branch

Once the worktree is gone, `remove` settles its branch against the branch's remote: its upstream's remote, else `origin`. Once per remote in a command, it asks the remote for its default branch and its branches and fetches that default branch.

It decides in this order, and the first case that holds settles the branch:

1. A detached worktree has no branch, and `remove` prints `detached`.
2. A branch checked out in another worktree is kept.
3. A branch whose remote does not exist, cannot be reached or has no default branch is kept.
4. A branch that tracks the remote's default branch itself is kept.
5. A branch that has not landed is kept. It has landed when the default branch has its tip (merged), or when its upstream is gone from the remote and its whole change since the merge base matches one commit already in the default branch (squash-merged), as after a squash merge whose host deleted the branch.
6. A landed branch whose upstream holds commits the branch lacks is kept.
7. Any other landed branch is deleted. When its upstream is still on the remote, `remove` deletes that first, and when the remote refuses, the branch is kept. An upstream already gone is no error.

`--force` never changes which branch is deleted.

`remove` prints the outcome on one line, the reason after `kept, `:

```text
branch fix-login deleted, merged into origin/main, and origin/fix-login deleted
branch fix-login deleted, squash-merged into origin/main
branch fix-login kept, not merged into origin/main
branch fix-login kept, origin/fix-login has commits it lacks
branch fix-login kept, checked out at /home/dev/other-checkout
```
