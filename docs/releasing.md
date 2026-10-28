# Releasing

A `v*` tag on `main` runs `.github/workflows/release.yml`. It first runs the acceptance suite on macOS through `acceptance.yml`, and builds nothing if it fails. It compiles darwin-arm64 and linux-x64 with `scripts/build-compiled.sh`, smoke-tests each build with `scripts/smoke.sh` (it prints its version, then runs `create` and `remove` on a made-up worktree name in a scratch repository), attaches each build's tarball and sha256, `install.sh` and `SHA256SUMS.txt` to a GitHub release, publishes the three npm packages with provenance, and dispatches `cniska/homebrew-tap` to repin `Formula/agent-worktree.rb`. Once the registry serves all three published packages, a job on each platform installs the version with `npm install -g` and with `bun add -g`, and runs `scripts/smoke.sh` on each install's launcher with no `node` or `bun` on `PATH`; either install failing fails the run, and a patch release carries the fix. Run by `workflow_dispatch` instead, it builds, smoke-tests and packs everything and publishes nothing: the release files and `npm pack --dry-run` are its output.

A release never updates itself. Each channel updates the way it installed: `brew upgrade agent-worktree`, `npm update -g @cniska/agent-worktree`, `bun update -g @cniska/agent-worktree`, or the curl line run again.

## The owner's setup, once

1. Publish each npm package once by hand, so trusted publishing can be set on it: `@cniska/agent-worktree-darwin-arm64`, `@cniska/agent-worktree-linux-x64`, then `@cniska/agent-worktree`. Build them from the first release's files with `bun scripts/build-npm.ts <release files> dist/npm`, then `npm publish ./dist/npm/<package> --access public` for each.
2. On npmjs.com, add a trusted publisher to each of the three packages: GitHub Actions, repository `cniska/agent-worktree`, workflow `release.yml`. Later releases publish with no npm token.
3. In each package's settings on npmjs.com, require two-factor authentication and disallow tokens, so only the trusted publisher can publish.
4. In `cniska/agent-worktree`'s Actions secrets, add `TAP_DISPATCH_TOKEN`: a fine-grained token on `cniska/homebrew-tap` with Contents read and write, which the `homebrew` job uses to dispatch the repin.

## Each later release

1. On a clean `main`, run `scripts/release.sh patch|minor|major`. It bumps `package.json`, refuses a version the release check rejects, runs `bun run check`, commits `chore: release vX.Y.Z` and tags it.
2. Push `main`, then the tag, as it prints.
3. The release body is GitHub's generated notes.

The release check, `scripts/release-check.ts`, runs on every tag in the workflow too: the tag must be `v` and the `package.json` version, and newer than the previous tag.

## A bad release

A tag whose build failed published nothing, since every publish job waits on the builds. To tag the same version again after a run that published no release, delete any draft the `release` job left for the tag (`gh release delete vX.Y.Z`), then the tag on origin and locally, then, once the fix is on `main`, tag `main` again (`git tag -m vX.Y.Z vX.Y.Z`) and push that tag. Once a tag has published anything, publish the fix as a new, higher version; a tag is never moved. With release immutability on, GitHub enforces that: a published release's tag can be neither moved nor deleted, and its name cannot be used again even after the release is deleted. A machine that installed the bad release takes the fix through its channel's update.
