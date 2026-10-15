#!/bin/sh
set -eu
[ -n "${WORKTREE_NAME:-}" ] || exit 0
cat > .env <<ENV
COMPOSE_PROJECT_NAME=$(printf 'myapp-%s' "$WORKTREE_NAME" | tr 'A-Z.' 'a-z_')
WEB_PORT=$WORKTREE_PORT
DB_PORT=$((WORKTREE_PORT + 1))
ENV
