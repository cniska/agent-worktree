# Commands

The `agent-worktree` commands, where `create` cuts a branch, how `remove` settles one and what `doctor` checks.

| Command | Does |
| --- | --- |
| `agent-worktree create [--from <ref>] <name>` | Create the worktree on branch `<name>`, as [Where `create` cuts a branch](#where-create-cuts-a-branch) says, run setup, print its `path`. Rerun to resume a failed setup. |
| `agent-worktree init` | Run setup in the current checkout, primary or task worktree. |
| `agent-worktree remove [--force] <name>` | Run teardown and remove the worktree, then settle its branch as [How `remove` settles a branch](#how-remove-settles-a-branch) says. Without `--force` a dirty worktree, one with submodules or a failed teardown refuses; a locked worktree always does. |
| `agent-worktree prune` | Prune git's stale worktree entries, tear down every worktree that is gone but still registered, and remove every clean worktree whose branch has an upstream and landed, other than the one it runs in, settling each one's branch as `remove` does; refuses with the names whose teardown failed. |
| `agent-worktree ls [--full]` | Count the worktrees in each state, as `counts`, and list each one's name, state and path, as `worktrees`; `--full` adds its branch and port block, null when it has none. `agent-worktree` with no command prints the same. |
| `agent-worktree path <name>` | Print the worktree's `path`. |
| `agent-worktree hook` | The plugin's `WorktreeCreate` and `WorktreeRemove` entry: reads the event from stdin, and prints the path, or the branch's outcome, alone on one line, as Claude Code reads it. |
| `agent-worktree install [--local] [--setup <command>] [--teardown <command>] [--ports <n>]` | Write the hook each option names into `.worktree-hooks/`, or with `--local` into the clone's git directory, leaving the others as they are, and print the path of each as `hooks`. |
| `agent-worktree doctor [--full]` | Report what agent-worktree, its plugin and the project need, as [What `doctor` checks](#what-doctor-checks) says; exit 1 when a check fails. |
| `agent-worktree --version` | Print the version alone on one line. |

`agent-worktree --help` lists every command's usage and summary, and `<command> --help` prints that command's.

## Output

Every command but `hook` and `--version` prints one [TOON](https://toonformat.dev) document. A result goes to stdout with exit 0, or 1 from `doctor` when a check fails: the command, `ok: true` and the `result`, which is null for `init` and `prune`:

```text
command: ls
ok: true
result:
  counts:
    ready: 2
    pending: 0
    orphaned: 0
    unlisted: 0
    unmanaged: 1
    legacy: 0
  worktrees[3]{name,state,path}:
    fix-login,ready,/home/dev/.local/share/agent-worktree/app-3f9c2a1b/fix-login
    scratch,unmanaged,/home/dev/.local/share/agent-worktree/app-3f9c2a1b/scratch
    search,ready,/home/dev/.local/share/agent-worktree/app-3f9c2a1b/search
```

An error goes to stderr, after any note or hook output there, with `ok: false` and the `error`: its `kind`, `refusal` or `fault`, its `code`, `message`, `meta`, and `resolve`, the act that resolves it. A refusal or fault exits 1, and a usage error, code `usage`, exits 2:

```text
command: remove
ok: false
error:
  kind: refusal
  code: not_registered
  message: fix-logn is not a registered worktree at /home/dev/.local/share/agent-worktree/app-3f9c2a1b/fix-logn
  meta:
    name: fix-logn
    path: /home/dev/.local/share/agent-worktree/app-3f9c2a1b/fix-logn
  resolve: run agent-worktree ls to see the registered names
```

A worktree's state is `ready`, `pending` while its setup has not finished, `orphaned` when its directory is gone, `unlisted` when git does not list it, `unmanaged` for a directory agent-worktree did not register, or `legacy` in the earlier location. Progress notes, such as the port block `create` claims, go to stderr as `agent-worktree: <note>` lines.

## Where `create` cuts a branch

An existing branch `<name>` is checked out. A new one is cut with no upstream, so `remove` and `prune` settle it as `create` made it:

- **Without `--from`**, from `origin`'s default branch, which `create` reads and fetches first, as `remove` does. With no `origin`, or one with no default branch, it is cut from the primary's HEAD, with a note on stderr. When `origin` cannot be reached within 60 seconds, `create` refuses and names `--from HEAD`, rather than cut from a base that may trail.
- **With `--from <ref>`**, from the commit `<ref>` names in the checkout `create` runs in, without reaching a remote. `--from` with an existing branch refuses, and on a worktree `create` already made it is ignored, so a rerun resumes a failed setup.

## How `remove` settles a branch

Once the worktree is gone, `remove` settles its branch against the branch's remote: its upstream's remote, else `origin`. Once per remote in a command, it asks the remote for its default branch and its branches and fetches that default branch.

It decides in this order, and the first case that holds settles the branch:

1. A detached worktree has no branch, and `remove` prints `branch` as null and `outcome` as `detached`.
2. A branch checked out in another worktree is kept.
3. A branch whose remote does not exist, cannot be reached or has no default branch is kept.
4. A branch that tracks the remote's default branch itself is kept.
5. A branch that has not landed is kept. It has landed when the default branch has its tip (merged), or when its upstream is gone from the remote and its whole change since the merge base matches one commit already in the default branch (squash-merged), as after a squash merge whose host deleted the branch.
6. A landed branch whose remote branch holds commits the branch lacks is kept. Its remote branch is its upstream or, with none, the branch of the same name on `origin`, other than `origin`'s default branch, which `remove` never deletes.
7. Any other landed branch is deleted. When its remote branch is still on the remote, `remove` deletes that first, and when the remote refuses, the branch is kept. An upstream already gone is no error.

`--force` never changes which branch is deleted.

`remove` prints the worktree's `name`, its `branch`, null when it is detached, and the branch's `outcome` with the facts that outcome has:

```text
command: remove
ok: true
result:
  name: fix-login
  branch: fix-login
  outcome: deleted
  landing: merged
  into: origin/main
  remoteBranch: origin/fix-login
```

| Outcome | Facts | Branch |
|---|---|---|
| `deleted` | `landing`, `into`, `remoteBranch` | Deleted, `merged` or `squash-merged` into `into`; `remoteBranch` is the remote branch deleted with it, or null. |
| `unmerged` | `into` | Kept: it has not landed in `into`. |
| `tracks_default` | `into` | Kept: it tracks the default branch itself. |
| `no_remote` | `remote` | Kept: the remote does not exist. |
| `no_default_branch` | `remote` | Kept: the remote has no default branch. |
| `remote_unreachable` | `remote`, `detail` | Kept: the remote could not be reached. |
| `remote_branch_ahead` | `remoteBranch` | Kept: the remote branch has commits it lacks. |
| `remote_branch_kept` | `remoteBranch`, `detail` | Kept: the remote refused to delete its branch. |
| `checked_out` | `at` | Kept: it is checked out in another worktree. |
| `detached` | | The worktree had no branch. |

`hook` and `prune`'s notes word the same outcome as one line, the reason after `kept, `:

```text
branch fix-login deleted, merged into origin/main, and origin/fix-login deleted
branch fix-login deleted, squash-merged into origin/main
branch fix-login kept, not merged into origin/main
branch fix-login kept, origin/fix-login has commits it lacks
branch fix-login kept, checked out at /home/dev/other-checkout
```

## What `doctor` checks

`doctor` leads its result with `counts`, how many checks are `ok`, `warn` and `fail`, then lists in `checks` each check that warns or fails with its name, state, detail and fix. `--full` lists every check, each one that passes with a null fix. Its output:

```text
command: doctor
ok: true
result:
  counts:
    ok: 8
    warn: 1
    fail: 0
  checks[1]{name,state,detail,fix}:
    fix-login worktree,warn,its setup has not finished at /home/dev/.local/share/agent-worktree/app-3f9c2a1b/fix-login,"run agent-worktree create fix-login to resume its setup, then run agent-worktree doctor again"
```

`doctor` only reads: it runs no hook, frees no block, reaches no remote and probes no port.

| Check | Reads | Warns or fails when | Fix |
| --- | --- | --- | --- |
| `git` | `PATH` | Fails: no executable `git` on it | Install git on `PATH` |
| `agent-worktree` | `PATH` | Warns: no executable `agent-worktree`, so the plugin's hooks fail | Install it on the `PATH` Claude Code starts with |
| `port blocks` | The machine's port blocks | Warns: a block's ledger entry is gone, in any project | `prune` |
| `project` | The checkout `doctor` runs in | Warns: not a git checkout, or git is missing; fails: an unsupported layout | Run `doctor` in the project's checkout; put git on `PATH`; or the act the layout refusal names |
| `setup hook`, `teardown hook`, `ports hook` | The setup and ports hooks as the checkout has them, the teardown hook as the primary has it | Fails: a setup or teardown hook that is not executable, or a ports hook that holds no count | The act the matching refusal names |
| `<name> worktree` | Each worktree `ls` lists | Warns: any state but `ready` | `create` for `pending`; for the others the refusal `create` and `remove` give it: `prune` for `orphaned`, removing the directory for `unlisted` or `unmanaged`, the two acts for `legacy` |
| `<name> ports` | Each `ready` or `pending` worktree's block and its own ports hook | Warns: a block it should not hold, none where its project asks for ports, or one of the wrong size, or its own ports hook holds no count | `init` in the worktree, or the refusal's act |

The plugin's hooks see the `PATH` Claude Code started with, which can differ from a shell's. When Claude Code's worktrees fail to create, run `agent-worktree doctor` under that `PATH`.
