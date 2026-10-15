#!/bin/sh
set -eu
docker compose --project-name "$(printf 'myapp-%s' "$WORKTREE_NAME" | tr 'A-Z.' 'a-z_')" down -v
