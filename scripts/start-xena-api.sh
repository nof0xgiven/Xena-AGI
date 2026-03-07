#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

mkdir -p .trigger
export NODE_OPTIONS="--localstorage-file=.trigger/localstorage.json ${NODE_OPTIONS:-}"

exec pnpm api:start
