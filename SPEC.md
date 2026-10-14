# agent-worktree Specification

> Task worktrees for coding agents: one task, one checkout, set up and torn down by the project's own scripts.

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

- **FR-22** — `remove <name>` runs teardown, removes the worktree, keeps its branch, unregisters it, and prints the kept branch, or `detached`.
- **FR-23** — A worktree with uncommitted or untracked files is refused as `dirty` unless `--force` is given.
- **FR-24** — A worktree that contains submodules is refused as `submodules` unless `--force` is given.
- **FR-25** — A locked worktree is refused as `locked`, with or without `--force`.
- **FR-26** — A teardown that fails is refused as `teardown_failed` and the worktree is kept. With `--force` the worktree is removed and stays registered, so `prune` retries its teardown.
- **FR-27** — A name that is not registered is refused as `not_registered`. An unmanaged, orphaned or unlisted worktree meets the refusal FR-16, FR-17 or FR-18 names.

### 2.6 prune

- **FR-28** — `prune` drops git's entries for worktrees whose directory is gone, then runs teardown for every registered worktree whose directory is gone and unregisters it.
- **FR-29** — A teardown that fails during `prune` leaves that worktree registered, and `prune` is refused as `teardowns_failed`, naming every such worktree.

### 2.7 ls

- **FR-30** — `ls` prints one line per registered worktree and per unregistered entry where the project's worktrees live: its name, its state, its branch and its path, sorted by name.
- **FR-31** — `ls` with nothing to list prints nothing on stdout and notes `no task worktrees` on stderr.

### 2.8 Project scripts

- **FR-32** — A project needs no script. `scripts/worktree-setup.sh` runs in the checkout being set up, as that checkout has it; `scripts/worktree-teardown.sh` runs in the primary checkout, since the worktree may already be gone.
- **FR-33** — Both scripts get `WORKTREE_PRIMARY`, `WORKTREE_PATH` and, for a task worktree, `WORKTREE_NAME`. `WORKTREE_PATH` is where the worktree actually is, or where git last listed it when the command started; for a worktree git no longer lists, such as one dropped with `git worktree remove`, it is unset. For the primary, `WORKTREE_NAME` is unset. A variable left unset stays unset even when the caller's environment set it.
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

## 3. Non-functional requirements

- **NF-1** — Every command reads the ledger, the filesystem and git afresh; nothing is remembered between commands.
- **NF-2** — Doing the act a refusal names, then running the command again, does not meet the same refusal.
- **NF-3** — The tests never read or write the real home: `HOME` and the XDG directories point at scratch directories.
- **NF-4** — agent-worktree needs no network.

## 4. Out of scope

- Moving a worktree between locations; the owner moves one from the earlier location with git (FR-42).
- Following a primary checkout that moved (FR-4 keys by path; see §9).
- Worktrees agent-worktree did not create, including Claude Code's own when the plugin is not installed.
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
- **AC-10** — `remove` on a clean worktree: teardown ran in the primary, the worktree is gone, the branch kept, the name unregistered; on a detached one it prints `detached`. (FR-22, FR-32)
- **AC-11** — `remove` on a dirty worktree, one with submodules, and a locked one, each with and without `--force`: `dirty` and `submodules` without force only; `locked` both times. (FR-23, FR-24, FR-25)
- **AC-12** — `remove` with a failing teardown: `teardown_failed`, worktree kept; with `--force`: removed and `orphaned`; fix teardown and `prune`: unregistered. (FR-26, FR-28)
- **AC-13** — `remove` of an unregistered name: `not_registered`. (FR-27)
- **AC-14** — `prune` with two gone worktrees, one whose teardown fails: `teardowns_failed` naming it, the other unregistered and gone from `git worktree list`; fix and rerun: both gone. (FR-28, FR-29, NF-2)
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

## 6. Deliverables

- **D-1** — The `agent-worktree` CLI, run by Bun from a checkout and linked onto `PATH` by `mise install`.
- **D-2** — The `cniska-worktree` Claude Code plugin in `plugin/`.
- **D-3** — `README.md`, `AGENTS.md`, `src/README.md` and this spec.
- **D-4** — The test suite, run by `bun run check`.

## 7. Constraints (fixed)

- **C-1** — TypeScript on Bun, which mise installs.
- **C-2** — Task checkouts are git worktrees of the primary checkout.
- **C-3** — The plugin brings neither Bun nor the CLI.

## 8. Open decisions (left to the builder)

- The hash and its length in the key, provided FR-4 and FR-5 hold.
- The ledger's format, provided FR-7 holds.
- The wording of each state in `ls`.

### Policies chosen (not open)

- A worktree in the earlier location is refused, not handled where it is; agent-worktree never moves one itself (FR-42).
- The `WorktreeRemove` hook removes with force, since Claude Code removes a worktree only when its session is done with it (FR-37).

## 9. Open questions and known gaps

Known gaps, where the code does not yet meet a requirement:

- **AC citations.** No check ties the tests to these criteria; the tests name behavior, not IDs.

Open questions:

- **An acceptance suite.** agent-record proves its criteria with a suite that drives the CLI and a check that ties it to the spec. Here AGENTS.md keeps the tests in process and lets only `src/cli.test.ts` spawn the CLI. Should this repo gain such a suite and check?
- **A moved primary.** FR-4 keys by path, so after the primary moves, its worktrees read as gone and `prune` would tear them down. Should agent-worktree refuse instead, naming `git worktree repair`?
- **When FR-41 to FR-45 go.** They serve only worktrees made before the move to FR-1; they can be deleted once the owner's machines hold none.
