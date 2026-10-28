# Development

Setup, checks, layout and rules, for working on this repo.

## Setup

agent-worktree runs on [Bun](https://bun.sh), which [mise](https://mise.jdx.dev) installs for it. With mise installed:

```bash
git clone https://github.com/cniska/agent-worktree.git
cd agent-worktree
mise trust && mise install
bin/agent-worktree create <name>
```

- `mise install` installs actionlint, Bun and the dependencies, and the `bun install` its postinstall runs calls the `prepare` script, which points `core.hooksPath` at `.githooks/`. Only in the clone, never in a worktree, does it put `agent-worktree` in `~/.bun/bin` with `bun link`, so removing a worktree never leaves the command pointing at a deleted checkout. Add `~/.bun/bin` to your `PATH` if it is not there yet.
- `bin/agent-worktree create <name>` makes a task worktree and runs the repository's own `.worktree-hooks/setup` in it, which installs the same way without linking the CLI.
- `bin/agent-worktree` finds Bun through mise in `$MISE_DATA_DIR`, or `~/.local/share/mise` when that is unset, never through `XDG_DATA_HOME`, so a test or command that points `XDG_DATA_HOME` at a scratch directory still runs the CLI; `scripts/source-launcher.test.ts`, in the check, holds this. If you set `XDG_DATA_HOME` for your whole shell, set `MISE_DATA_DIR` to where mise keeps its installs.
- `.githooks/` holds the commit-subject, format and no-comments gates.

## Checks

- `bun run check` runs the lint, the typecheck, knip (an export, file or dependency nothing uses) and the tests, and `.githooks/pre-commit.d/check` runs it before each commit.
- `bun run acceptance` proves the criteria in [`SPEC.md`](../SPEC.md) through the CLI alone, as [`AGENTS.md`](../AGENTS.md) describes. Each test gets 20 seconds rather than Bun's default 5, since one drives git and the CLI dozens of times and a `create` with a remote also reads and fetches it.
- `scripts/build-compiled.sh <outfile>` compiles the CLI into one executable that needs no Bun, the binary a release ships.
- `scripts/smoke.sh <executable> <version>` is the release's smoke test: the executable prints the version, then runs `create` and `remove` on a made-up worktree name in a scratch repository; the release runs it on each build and on each registry install.
- `scripts/release.sh patch|minor|major` bumps the version and tags it; `.github/workflows/release.yml` builds the tag into a GitHub release, the npm packages and a Homebrew repin, as [Releasing](releasing.md) says.
- `bun run format` formats `src/`, `acceptance/` and `scripts/` with Biome, and the format gate runs it with the linter off before each commit and stages what it changes in the staged files.
- `npm/agent-worktree` is the npm package's launcher, a POSIX shell script `scripts/build-npm.ts` fills with the release builds; `scripts/launcher.test.ts`, in the check, runs it over the layouts `npm` and `bun` install, with no runtime on `PATH`.
- `.github/workflows/check.yml` runs the check and actionlint over `.github/workflows/` at the version `mise.toml` pins, on each push and pull request; `commits.yml`, `format.yml` and `no-comments.yml` run the gates.
- `.github/workflows/acceptance.yml` runs the acceptance suite on macOS, by `workflow_dispatch` and as the first job of each release.

## Layout

- The plugin lives in `plugin/`, apart from the repository root, so the CLI's `bin/` stays off the `PATH` Claude Code gives a plugin.
- [`src/README.md`](../src/README.md) maps the modules and the boundaries between them.

## Rules

[`AGENTS.md`](../AGENTS.md) holds the repository's rules, and [`SPEC.md`](../SPEC.md) states what must hold.
