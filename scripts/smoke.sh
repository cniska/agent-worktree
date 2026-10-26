#!/usr/bin/env bash
set -euo pipefail

main() {
  local executable="${1:?usage: smoke.sh <executable> <version>}"
  local version="${2:?usage: smoke.sh <executable> <version>}"
  local scratch
  test "$("$executable" --version)" = "$version"
  scratch="$(mktemp -d)"
  export XDG_DATA_HOME="$scratch/data"
  git init -q -b main "$scratch/project"
  cd "$scratch/project"
  git -c user.name=Smoke -c user.email=smoke@example.test commit -q --allow-empty -m "made-up commit"
  "$executable" create made-up-task
  test "$(worktrees)" = 2
  "$executable" remove made-up-task
  test "$(worktrees)" = 1
}

worktrees() {
  git worktree list --porcelain | grep -c '^worktree '
}

main "$@"
