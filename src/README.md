# src/

Flat, so a module is found by name. A file's prefix is its module: `cli-output.ts` belongs to `cli`. A module that is one file carries its bare name (`ledger.ts`, `coded-error.ts`). A test sits beside its module as `<module>.test.ts`; a file several tests share is `<name>.test-support.ts`, and `test-env.ts` is the environment `bunfig.toml` preloads for every test.

`cli` is the one module of several files, each named for its part:

| File | Holds |
| --- | --- |
| `cli.ts` | The entry: parse the command line, run the command, print its result or refusal and set the exit code |
| `cli-commands.ts` | Every command: parse its arguments, call the domain, format its result |
| `cli-contract.ts` | What a command is, and the usage refusal |
| `cli-output.ts` | Writing result lines to stdout and a refusal to stderr |

Another module reaches a module only through its bare-named file, so `cli`'s parts are its own and no module imports the entry. Only `git` and `scripts` start a process; among the tests here, only `cli.test.ts`, which holds the one CLI runner, and the repo fixtures do. A module makes no error but a `CodedError`, and every `switch` ends in a `default` that calls `unreachable`. [`modules.test.ts`](modules.test.ts) holds each of these.

## Modules

| Prefix | Responsibility |
| --- | --- |
| `cli` | The `agent-worktree` command line, over the domain below |
| `worktrees` | The lifecycle: create, init, remove, prune and list, from a worktree's state read fresh each time |
| `hook` | Parse a Claude Code `WorktreeCreate` or `WorktreeRemove` event into a worktree name |
| `project` | The project a directory belongs to, worktree names, and where a worktree lives: under the data directory, keyed by project, or in the earlier location inside the primary |
| `paths` | The XDG data directory, read from the environment on every call |
| `ledger` | The record of registered worktrees and whether their setup finished, under the git common dir, and of which worktree holds which port block, under the data directory for every project on the machine |
| `ports` | Port blocks: the range, and whether another program binds a block's ports |
| `git` | Run git and parse what it prints; the only module that runs git |
| `scripts` | Find and run the project's setup and teardown scripts |
| `exit` | How a process ended |
| `directory` | List a directory that may not exist |
| `log` | A progress note on stderr |
| `coded-error`, `assert` | Refusals and faults with a code and the act that resolves them; `unreachable` and `invariant` |

## Where to start

- `cli-commands.ts` lists the commands and what each calls.
- `worktrees.ts` holds a worktree's states and the refusal each one meets.
- `repo.test-support.ts` builds the throwaway repos and fake scripts the tests run against.
- Read a module's `.test.ts` before changing what it exports.
- `spec.test.ts` ties [`../SPEC.md`](../SPEC.md)'s criteria to the acceptance suite in `../acceptance`, which drives the CLI alone; `syntax.test-support.ts` walks a source file's syntax for it and for `modules.test.ts`.
