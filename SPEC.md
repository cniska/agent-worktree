# agent-worktree Specification

> Task worktrees, so coding agents working in parallel never share a checkout: each task gets its own, set up and torn down by the project's own scripts.

This document states what must hold, not how. [`README.md`](README.md) has the install and the commands, and [`src/README.md`](src/README.md) maps the modules that meet these requirements.

**Status: reverse-engineered from the code at `1904f2c`, with the worktree location the owner decided (§2.1, §2.10).** §9 lists the known gaps and open questions.

## 1. Purpose & context

Two agents in one checkout overwrite each other's files, so parallel work needs a checkout per task. A bare `git worktree add` gives a checkout that is not ready to work in, and leaves whatever the worktree started outside its directory running when it goes. Claude Code makes worktrees of its own and runs no project setup for them. agent-worktree owns the whole lifecycle: it creates the worktree, runs the project's setup, records whether setup finished, and runs the teardown before the worktree goes. A project's scripts must be idempotent, since each runs again on every resume and retry.

**Primary user:** the owner's coding agents, through the CLI and the `cniska-worktree` Claude Code plugin, in the owner's git clones. Not the audience: bare repositories, submodules, or checkouts whose git directory lives elsewhere.

## 2. Functional requirements

### 2.1 Where worktrees live

- **FR-1** — A task worktree is created at `<data>/<key>/<name>`, where `<data>` is `$XDG_DATA_HOME/agent-worktree`.
- **FR-2** — An `XDG_DATA_HOME` that is unset, empty or not an absolute path counts as `$HOME/.local/share`.
- **FR-3** — A `HOME` that is unset, empty or only whitespace counts as the account's home directory.
- **FR-4** — A project's key is its primary checkout's directory name, a dash, and a short hash of the primary's absolute path; it is the same from the primary and from each of its worktrees.
- **FR-5** — Two clones with the same directory name at different paths get different keys.
- **FR-6** — No task worktree is created inside the primary checkout's directory, unless `XDG_DATA_HOME` itself points inside it.
- **FR-7** — The ledger, which records each registered worktree and whether its setup finished, lives in the git common directory under `agent-worktrees`, where earlier releases wrote it, so their registrations are still read.
- **FR-8** — `path <name>` prints where the worktree `<name>` lives.

### 2.2 Names and projects

- **FR-9** — A worktree name is one path segment of letters, digits, dots, underscores and dashes that git accepts as a branch name; any other name is refused as `invalid_name`.
- **FR-10** — A name that differs only in case from a registered worktree or an existing directory where worktrees live is refused as `case_collision`, naming the existing one.
- **FR-11** — A checkout whose git directory is not a `.git` directory inside the primary checkout, such as a submodule or a separate git dir, is refused as `unsupported_layout`.
- **FR-12** — A command run outside any git checkout is refused as `not_a_checkout`.

### 2.3 create

- **FR-13** — `create <name>` makes a worktree on branch `<name>`: a new branch from the primary's HEAD, or the existing branch checked out. It registers the worktree, runs setup in it, records setup as finished, and prints the path.
- **FR-14** — `create` on a worktree whose setup finished prints its path and runs nothing.
- **FR-15** — A setup script that fails is refused as `setup_failed`; the worktree stays registered with setup pending, and the next `create` reruns setup without making the worktree again.
- **FR-16** — A directory where the worktree would go that agent-worktree did not register is refused as `unmanaged`, and left as it is.
- **FR-17** — A registered worktree whose directory is gone is refused as `orphaned`, naming `prune`.
- **FR-18** — A registered worktree whose directory git does not list as a worktree is refused as `not_a_worktree`.

### 2.4 init

- **FR-19** — `init` in the primary checkout runs setup there, with no worktree name.
- **FR-20** — `init` in a registered task worktree runs setup there with its name, and records setup as finished.
- **FR-21** — `init` in any other checkout is refused as `not_a_managed_checkout`.

### 2.5 remove

- **FR-22** — `remove <name>` runs teardown, removes the worktree, unregisters it, and settles its branch against its remote: the branch's upstream remote, else `origin`. Once per remote in a command, it asks the remote for its default branch and its branches and fetches that default branch. The branch has landed when its tip is reachable from the default branch, or when it has an upstream that is gone from the remote and its whole change since the merge base matches one commit already in the default branch, as after a squash merge whose host deleted the branch. A landed branch is deleted, and so is its upstream on the remote when the remote still has it and the branch holds every commit there; an upstream already gone is no error. Otherwise the branch is kept: one that has not landed; one whose upstream holds commits the branch lacks, or that the remote refuses to delete; one that tracks the remote's default branch itself; one whose remote does not exist, cannot be reached or has no default branch; and one checked out in another worktree. `--force` does not change which branch is deleted. It prints `branch <name> deleted, merged into <remote>/<branch>`, or `squash-merged into`, followed by `, and <remote>/<upstream> deleted` when it deleted that, or `branch <name> kept, ` and why on one line, or `detached`.
- **FR-23** — A worktree with uncommitted or untracked files is refused as `dirty` unless `--force` is given.
- **FR-24** — A worktree that contains submodules is refused as `submodules` unless `--force` is given.
- **FR-25** — A locked worktree is refused as `locked`, with or without `--force`.
- **FR-26** — A teardown that fails is refused as `teardown_failed` and the worktree is kept. With `--force` the worktree is removed and stays registered, so `prune` retries its teardown.
- **FR-27** — A name that is not registered is refused as `not_registered`. An unmanaged, orphaned or unlisted worktree meets the refusal FR-16, FR-17 or FR-18 names.

### 2.6 prune

- **FR-28** — `prune` drops git's entries for worktrees whose directory is gone, then runs teardown for every registered worktree whose directory is gone and unregisters it. It then removes, as `remove` does, every registered worktree git lists whose branch has an upstream and has landed by FR-22's test, when the worktree is unlocked, has no uncommitted or untracked files, contains no submodules and is not the checkout `prune` runs in, noting `worktree <name> removed, its branch landed` on stderr; a worktree whose branch has no upstream, as `create` makes it, is never removed by `prune`. A branch such a worktree had when git last listed it is settled as FR-22 settles it, and noted on stderr as FR-22 prints it.
- **FR-29** — A teardown that fails during `prune`, or a removal git refuses after it, leaves that worktree registered while `prune` goes on with the rest, and `prune` is then refused as `removals_failed`, naming every such worktree and its cause.

### 2.7 ls

- **FR-30** — `ls` prints one line per registered worktree and per unregistered entry where the project's worktrees live: its name, its state, its branch, its port block (FR-57) and its path, sorted by name.
- **FR-31** — `ls` with nothing to list prints nothing on stdout and notes `no task worktrees` on stderr.

### 2.8 Project scripts

- **FR-32** — A project needs no script. `scripts/worktree-setup.sh` runs in the checkout being set up, as that checkout has it; `scripts/worktree-teardown.sh` runs in the primary checkout, since the worktree may already be gone. `scripts/worktree-ports` is not a script: it is read, never run (FR-51).
- **FR-33** — Both scripts get `WORKTREE_PRIMARY`, `WORKTREE_PATH`, for a task worktree `WORKTREE_NAME`, and for a worktree holding a port block `WORKTREE_PORT` (FR-56). `WORKTREE_PATH` is where the worktree actually is, or where git last listed it when the command started; for a worktree git no longer lists, such as one dropped with `git worktree remove`, it is unset. For the primary, `WORKTREE_NAME` and `WORKTREE_PORT` are unset. A variable left unset stays unset even when the caller's environment set it. Beyond these variables, a script gets the caller's environment, with nothing of agent-worktree's own added, such as the Bun it runs on.
- **FR-34** — A script that exists but is not executable is refused as `script_not_executable`, and one that cannot start as `script_unrunnable`; neither is skipped.
- **FR-35** — A script's output goes to stderr and is never read; its exit status alone decides success.

### 2.9 Claude Code hook and plugin

- **FR-36** — `hook` given a `WorktreeCreate` event on stdin creates the worktree it names, as `create` does, and prints only its path.
- **FR-37** — `hook` given a `WorktreeRemove` event removes the worktree at its `worktree_path` with force, as `remove --force` does.
- **FR-38** — A `WorktreeRemove` path that is not where agent-worktree keeps that name's worktree, nor a worktree in the earlier location (FR-41), is refused as `foreign_path`.
- **FR-39** — Stdin that is not a JSON object with the event's string fields is refused as `hook_input`; any other event is refused as `hook_event`.
- **FR-40** — The `cniska-worktree` plugin runs `agent-worktree hook` for `WorktreeCreate` and `WorktreeRemove`, and adds a note when a session starts, resumes, clears or compacts telling the agent to create and remove worktrees with the CLI.

### 2.10 Worktrees in the earlier location

- **FR-41** — A registered worktree that git lists at `<primary>/.claude/worktrees/<name>`, where earlier releases created them, and that has nothing at its FR-1 path, is listed by `ls` at that path in the state `legacy`.
- **FR-42** — `create`, `init`, `remove` and the `WorktreeRemove` hook on it are refused as `legacy_location`, naming two acts: keep it, by making its FR-1 path's parent, moving it there with `git worktree move` and running `init` in it; or drop it, with `git worktree remove` and then `prune`.
- **FR-43** — `prune` leaves a worktree in the earlier location registered and runs no teardown for it.
- **FR-44** — After the keep act, the worktree reads `ready` at its FR-1 path; after the drop act, its teardown has run and it is unregistered.
- **FR-45** — A directory under `<primary>/.claude/worktrees` that is not registered is not agent-worktree's: `ls` does not list it and no command touches it.

### 2.11 Output and errors

- **FR-46** — A result goes to stdout, one line per item, and exits 0.
- **FR-47** — A refusal goes to stderr as `agent-worktree <command>: <message>`, or `agent-worktree: <message>` for an unknown command, and, on the next line, the act that resolves it, and exits 1.
- **FR-48** — An unknown command, an unknown option, or a wrong number of arguments is refused with the usage as the act, and exits 2.
- **FR-49** — `agent-worktree` with no command, or with `--help`, lists every command with its usage and summary; `<command> --help` prints that command's.
- **FR-50** — Every error is a refusal, with a code, a message naming what was refused and why, and the act that resolves it, or a fault, whose act is to hand it to the owner.

### 2.12 Port blocks

- **FR-51** — A project asks for ports by writing how many each task worktree needs, a whole number N from 1 to 1000, into `scripts/worktree-ports`, which agent-worktree reads in the checkout being set up. Setting up a task worktree of such a project gives it the lowest free block of ⌈N/10⌉ consecutive units, a unit being 10 consecutive ports from 24000 to 24999 that starts at a multiple of 10, and records the block in the ledger; a block is never derived from a hash of the worktree's name or path. The primary checkout gets no block, so it keeps the project's default ports. Claiming a block notes `port block <first>-<last> for <name>` on stderr.
- **FR-52** — A unit is free when no worktree of any project on the machine holds it and no program listens on any of its ports; a port in use skips its whole unit, and a block is free when each of its units is. A port is in use when a TCP connect to it on `127.0.0.1` or `::1` succeeds, which a listener on `0.0.0.0` or `::` accepts too; agent-worktree never binds a port to probe it. A worktree holds its block until it is unregistered, or until a `prune` or a claim finds it stale (FR-58, FR-59, FR-60).
- **FR-53** — Two commands claiming at once never get a unit in common, and two setting up one worktree at once agree on one block.
- **FR-54** — With no free block of the size the project asks for, `create` and `init` first remove the worktrees whose branch landed, as FR-28's `prune` does, sparing the checkout they run in and the worktree they set up, and claim again; with still none free they are refused as `no_free_ports`, naming `remove`, fixing a teardown that failed for a gone worktree (FR-60), and `prune` in another clone (FR-59); the worktree stays registered with setup pending and no block, and once a block is freed the next `create` or `init` claims one and resumes setup.
- **FR-55** — `init` in a registered task worktree whose block is not one run of the size its project asks for, such as one an earlier release registered with none, claims the lowest free block of that size, counting the units it holds as free, and frees the units it held outside that block, before setup runs; in one whose project asks for none, it frees the block the worktree holds.
- **FR-56** — `WORKTREE_PORT` is the first port of the worktree's block, and the project's N ports run to `WORKTREE_PORT` + N - 1.
- **FR-57** — `ls` shows a worktree's block as `<first>-<last>`, a block whose units are not one run as each run's `<first>-<last>` joined by commas, or `-` when it holds none.
- **FR-58** — `remove` frees the block when it unregisters the worktree; a worktree left registered after a failed teardown keeps its block, and its teardown during `prune`, or during a claim that takes the block over (FR-60), gets it.
- **FR-59** — `prune` frees every block whose worktree's ledger entry is gone, in any project on the machine, such as one whose clone was deleted, noting `port block <first>-<last> freed from <entry>, which is gone` on stderr for each.
- **FR-60** — `create` and `init` take over a stale block on their way to the lowest free one, as `prune` would: a block whose ledger entry is gone, in any project, is freed as FR-59 frees it; a block held by a registered worktree of the same project whose directory is gone has that worktree's teardown run and the worktree unregistered (FR-28), noting `port block <first>-<last> freed from <name>, whose worktree is gone` on stderr. A worktree whose teardown fails stays registered and keeps its block, and the claim moves on to the next block.
- **FR-61** — A project with no `scripts/worktree-ports` gets no block for any worktree, and its `create` and `init` never meet `no_free_ports`. One whose file holds anything but a whole number from 1 to 1000 on one line is refused as `invalid_ports`, naming the file and what it holds, and so is one whose file cannot be read, such as a directory; the worktree stays registered with setup pending and no block.

## 3. Non-functional requirements

- **NF-1** — Every command reads the ledger, the filesystem and git afresh; nothing is remembered between commands.
- **NF-2** — Doing the act a refusal names, then running the command again, does not meet the same refusal.
- **NF-3** — The tests never read or write the real home: `HOME` and the XDG directories point at scratch directories.
- **NF-4** — agent-worktree reaches a remote only to settle a branch (FR-22, FR-28): to read its default branch and branches, fetch that default branch, and delete a landed branch's upstream, only while the upstream is still at the commit it judged. git's own credential prompt is off, and each of these calls that has not finished within 60 seconds is stopped, so a remote that hangs or an ssh prompt nobody answers keeps the branch, naming the timeout, instead of holding the command. Otherwise it connects only to the machine's own loopback addresses, to see whether a port is in use (FR-52).

## 4. Out of scope

- Moving a worktree between locations; the owner moves one from the earlier location with git (FR-42).
- Following a primary checkout that moved (FR-4 keys by path; see §9).
- Working out or writing a project's setup or teardown, and installing anything for the project; the project's `scripts/worktree-setup.sh` and `scripts/worktree-teardown.sh` own that (FR-32).
- Worktrees agent-worktree did not create, including Claude Code's own when the plugin is not installed; git, or Claude Code for its own, manages those.
- Bare repositories, submodules and separate git dirs (FR-11).
- Reading a script's output (FR-35).

## 5. Acceptance criteria

- **AC-1** — With `XDG_DATA_HOME` set to an absolute scratch path, `create task-a` prints `$XDG_DATA_HOME/agent-worktree/<key>/task-a`, outside the primary, and `path task-a` prints the same. (FR-1, FR-6, FR-8)
- **AC-2** — With `XDG_DATA_HOME` unset, empty and relative, the data directory is `$HOME/.local/share/agent-worktree`; with `HOME` blank, it is under the account's home. (FR-2, FR-3)
- **AC-3** — The key from the primary and from one of its worktrees match and start with the primary's directory name; two clones named `repo` at different paths get different keys. (FR-4, FR-5)
- **AC-4** — A registration written under `.git/agent-worktrees` by hand is read as `ready`. (FR-7)
- **AC-5** — `create` with each invalid name form, with a name differing only in case, and from a submodule, a separate git dir and a non-checkout: `invalid_name`, `case_collision`, `unsupported_layout`, `not_a_checkout`. (FR-9, FR-10, FR-11, FR-12)
- **AC-6** — `create task-a` on a new and on an existing branch: the worktree on branch `task-a`, setup recorded with its name, path and primary, `ls` reading `ready`; a second `create` runs no setup. (FR-13, FR-14, FR-33)
- **AC-7** — `create` with a failing setup: `setup_failed` and `pending`; fix the script and rerun: setup reruns in the same worktree and it reads `ready`. (FR-15, NF-2)
- **AC-8** — `create` and `remove` over an unregistered directory, a registered one whose directory is gone, and a registered directory git does not list: `unmanaged` leaving it, `orphaned`, `not_a_worktree`; each converges after its act. (FR-16, FR-17, FR-18, FR-27, NF-2)
- **AC-9** — `init` in the primary, in a pending task worktree, and in an unregistered worktree: setup without a name even with `WORKTREE_NAME` inherited, setup with the name and `ready`, `not_a_managed_checkout`. (FR-19, FR-20, FR-21, FR-33)
- **AC-10** — `remove` on a clean worktree in a repo with no remote: teardown ran in the primary, the worktree is gone, the branch kept with the reason, the name unregistered; on a detached one it prints `detached`. (FR-22, FR-32)
- **AC-11** — `remove` on a dirty worktree, one with submodules, and a locked one, each with and without `--force`: `dirty` and `submodules` without force only; `locked` both times. (FR-23, FR-24, FR-25)
- **AC-12** — `remove` with a failing teardown: `teardown_failed`, worktree kept; with `--force`: removed and `orphaned`; fix teardown and `prune`: unregistered. (FR-26, FR-28)
- **AC-13** — `remove` of an unregistered name: `not_registered`. (FR-27)
- **AC-14** — `prune` with two gone worktrees, one whose teardown fails: `removals_failed` naming it and the exit, the other unregistered and gone from `git worktree list`; fix and rerun: both gone. (FR-28, FR-29, NF-2)
- **AC-15** — `ls` over registered and unregistered directories, and over none: lines sorted by name with state, branch and path, or the note on stderr. (FR-30, FR-31)
- **AC-16** — A non-executable setup script and one with a bad interpreter: `script_not_executable`, `script_unrunnable`. A project with no scripts creates and removes. (FR-32, FR-34)
- **AC-17** — A setup script that prints to stdout: the CLI's stdout holds only the path. (FR-35, FR-36)
- **AC-18** — `hook` with a `WorktreeCreate` event: the path alone on stdout; with a `WorktreeRemove` event for a dirty worktree, run from inside it: removed. (FR-36, FR-37)
- **AC-19** — `hook` with a foreign path, a nested name, another event and non-JSON stdin: `foreign_path`, `invalid_name`, `hook_event`, `hook_input`. (FR-38, FR-39)
- **AC-20** — The plugin's hooks file runs `agent-worktree hook` for both events and the note on the four session sources. (FR-40)
- **AC-21** — A registered worktree git lists under `<primary>/.claude/worktrees`: `ls` lists it there as `legacy`; `create`, `init`, `remove` and the `WorktreeRemove` hook each meet `legacy_location`; `prune` runs no teardown for it and leaves it registered. (FR-41, FR-42, FR-43)
- **AC-22** — Do the keep act on it: `ls` reads it `ready` at its FR-1 path. Do the drop act on another: teardown ran with `WORKTREE_PATH` unset even when inherited, and `ls` no longer lists it; delete a third's directory and prune: teardown ran with its earlier path. (FR-33, FR-44, NF-2)
- **AC-23** — An unregistered directory under `<primary>/.claude/worktrees`: absent from `ls`, untouched by `prune`. (FR-45)
- **AC-24** — The CLI with a result, a refusal, an unknown command, an unknown option and too many arguments: exit 0 with stdout; exit 1 with the two-line refusal; exit 2 with the usage as the act. (FR-46, FR-47, FR-48, FR-50)
- **AC-25** — The CLI with no command, `--help` and `remove --help`: every command's usage and summary, or the one. (FR-49)
- **AC-26** — Change state on disk between two commands, such as deleting a worktree's directory: the second command reads the change. (NF-1)
- **AC-27** — The test environment's `HOME` and XDG directories are scratch directories, not the account's. (NF-3)
- **AC-28** — The whole suite passes with the network unavailable. (NF-4)
- **AC-29** — `create` through `bin/agent-worktree` with a setup script that records its environment: the caller's environment and the FR-33 variables, nothing else. (FR-33)
- **AC-30** — In a project asking for 10 ports, as in AC-31 to AC-39: `create task-a` and `task-b`: setup gets the first two free blocks as `WORKTREE_PORT`, and `ls` shows each as `<first>-<last>`, and `create` notes the block it claims; `init` in the primary with `WORKTREE_PORT` inherited: setup gets it unset. (FR-33, FR-51, FR-56, FR-57)
- **AC-31** — `remove task-a`: its teardown gets its block, and the next `create` gets that block again. (FR-51, FR-58)
- **AC-32** — Another program listens on a port of the lowest free block on `0.0.0.0` and on a port of the next on `::`, then `create`: the worktree gets the third block, and each program accepted a connection. (FR-52)
- **AC-33** — A second clone creates a worktree in the same data directory: it gets the next block; delete the first clone and `prune` in the second: it notes the block freed, and the next `create` there gets the first clone's block. (FR-52, FR-59)
- **AC-34** — Several `create`s started at once, in a project asking for 20 ports: each worktree gets a block of two units, and no unit is in two blocks; two `init`s started at once in one of them, asking for 30: both setups get one `WORKTREE_PORT` and `ls` shows a block of three units. (FR-53)
- **AC-35** — Hold a port in every free block, then `create`: `no_free_ports` with the worktree `setup pending` and no block; free them and rerun: setup gets the lowest block and it reads `ready`. (FR-54, NF-2)
- **AC-36** — A registration with no block, written by hand: `ls` shows `-`; `init` in it: setup gets a block and `ls` shows it; ask for 30 and `init`: `ls` shows a block of three units; delete the claim of its middle unit by hand: `ls` shows the two runs left; `init`: `ls` shows a block of three units again; delete the request and `init`: `ls` shows `-`. (FR-55, FR-57)
- **AC-37** — `remove --force` past a failed teardown: `ls` still shows the block; fix teardown and `prune`: the teardown gets the block, and the next `create` gets it. (FR-58)
- **AC-38** — Delete a worktree's directory, then `create` another: the gone worktree's teardown gets its block, `create` notes the block freed, the new worktree gets it, and `ls` lists only the new one; with a teardown that fails instead: the gone worktree keeps its block and the new one gets the next. (FR-58, FR-60)
- **AC-39** — A second clone creates a worktree and is deleted, then `create` in the first, with no `prune`: it notes the block freed and gets it. (FR-59, FR-60)
- **AC-40** — With a local bare repository as `origin`: `remove` of a worktree whose branch was pushed with an upstream and then pushed to `origin`'s `main` past the local `origin/main` deletes the branch and `origin`'s copy; `remove --force` of one with an unpushed commit keeps it, naming `origin/main`; one squash-merged into `main` whose `origin` branch was deleted is deleted, and one with a commit since is kept; `prune` after two worktrees are deleted by hand deletes the merged branch and keeps the unmerged one, noting each; with `origin` pointing at no repository, `remove` keeps the branch, naming why. (FR-22, FR-28, NF-4)
- **AC-41** — A project with no `scripts/worktree-ports`, with a port held in every free unit: `create` succeeds, `ls` shows `-` and setup gets `WORKTREE_PORT` unset; asking for 20: `create` gives setup the first port of two consecutive free units and `ls` shows `<first>-<first + 19>`; asking for `ten`: `invalid_ports` naming the file, setup pending and `ls` showing `-`. (FR-51, FR-56, FR-61)
- **AC-42** — With a local bare repository as `origin`: `prune` removes a clean worktree whose branch was pushed with an upstream and pushed to `origin`'s `main`, running its teardown and deleting its branch here and on `origin`, noting each; it keeps a worktree never pushed, one with an untracked file, one pushed but not merged, one locked, and the one it runs in. (FR-28)
- **AC-43** — A project asking for 10 ports with a landed worktree holding the one free block: `create` of another runs the landed one's teardown, removes it and takes its block. (FR-54)

## 6. Deliverables

- **D-1** — The `agent-worktree` CLI, run by Bun from a checkout and linked onto `PATH` by `mise install` in the primary checkout, never in a worktree.
- **D-2** — The `cniska-worktree` Claude Code plugin in `plugin/`.
- **D-3** — `README.md`, `AGENTS.md`, `src/README.md` and this spec.
- **D-4** — The test suite, run by `bun run check`, and the acceptance suite, run by `bun run acceptance`, whose test names cite the criteria in §5.

## 7. Constraints (fixed)

- **C-1** — TypeScript on Bun, which mise installs.
- **C-2** — Task checkouts are git worktrees of the primary checkout.
- **C-3** — The plugin brings neither Bun nor the CLI.
- **C-4** — A project's scripts are plain shell that run without agent-worktree, needing nothing beyond the directory FR-32 names and the variables FR-33 lists.

## 8. Open decisions (left to the builder)

- The hash and its length in the key, provided FR-4 and FR-5 hold.
- The ledger's format, provided FR-7 holds.
- The wording of each state in `ls`.
- Where the ledger keeps a block, provided FR-51 to FR-53 and FR-59 hold.

### Policies chosen (not open)

- A worktree in the earlier location is refused, not handled where it is; agent-worktree never moves one itself (FR-42).
- The `WorktreeRemove` hook removes with force, since Claude Code removes a worktree only when its session is done with it (FR-37).
- Port blocks start at 24000, below the ephemeral ranges of Linux (from 32768) and macOS (from 49152) and Kubernetes' node ports (30000 to 32767), and apart from a range a project keeps for itself (FR-51).
- Ports are an add-on: a worktree gets a block only when its project asks for one, and agent-worktree provides the ports and never cares how the project uses them (FR-51, FR-61). The request lives in a file beside the scripts, versioned with the project, not in git config, which a fresh clone lacks, nor in the environment, which is the caller's; it is read before setup runs, since the block must exist by then.
- A block is whole units of 10, so a request of N ports takes ⌈N/10⌉ units and keeps one claim per unit, which keeps claims atomic; a project sees only `WORKTREE_PORT` and its own N (FR-51, FR-56).
- A port is probed by connecting on loopback, never by binding it: binding `0.0.0.0` or `::` can raise the macOS firewall prompt on every `create`, in front of an agent nobody is watching (FR-52).
- `prune` sweeps only a worktree whose branch has an upstream (FR-28): a branch `create` just made sits at the default branch's tip, so by reachability alone it has landed, and a sweep would tear down a live agent's fresh worktree; a worktree landed without ever being pushed stays until its `remove`. The checkout `prune` or `create` runs in is never swept, so an agent creating a worktree from its own keeps the one it stands in.
- A claim takes over a stale block itself rather than leave it until a `prune` (FR-60); two claims at once may both run a gone worktree's teardown, as two `prune`s at once may.
- A branch is judged against its remote's default branch as the remote has it now, not against a local ref that may be stale, so `remove` and `prune` reach the remote (FR-22, NF-4); when it cannot be reached, the branch is kept rather than judged blind. A squash merge counts as landed only once its host deleted the branch, and only when the branch's net change is already in the default branch, so work committed since is never lost; a branch never pushed is judged by reachability alone.
- The network timeout is 60 seconds: `ls-remote` and a fetch of `main` from GitHub over ssh each took about 1.5 seconds when measured, and the margin leaves room for a large fetch on a slow link (NF-4).
- `remove` deletes a landed branch's upstream itself, so an agent never deletes a remote branch by hand and never meets one its host already deleted (FR-22).
- Blocks are allocated across every project on the machine, not per clone, since ports are the machine's: two clones allocating apart would both take 24000 (FR-52).

## 9. Open questions and known gaps

Known gaps, where the code does not yet meet a requirement:

- **A whitespace `HOME`.** With `XDG_DATA_HOME` unset and `HOME` only spaces, the data directory is under the spaces as a relative path, not under the account's home (FR-3); AC-2's test covers only an unset and an empty `HOME`.

Not proven by a criterion:

- **C-4.** It constrains each project's scripts, which belong to the project; agent-worktree runs them and never reads them.

Open questions:

- **A moved primary.** FR-4 keys by path, so after the primary moves, its worktrees read as gone and `prune`, or a `create` or `init` reaching their blocks (FR-60), would tear them down. Should agent-worktree refuse instead, naming `git worktree repair`?
- **When FR-41 to FR-45 go.** They serve only worktrees made before the move to FR-1; they can be deleted once the owner's machines hold none.
