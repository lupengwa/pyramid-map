#!/bin/zsh
set -euo pipefail

APP_DIRECTORY=${0:A:h}
cd "$APP_DIRECTORY"

if command -v bun >/dev/null 2>&1; then
  BUN_EXECUTABLE=$(command -v bun)
elif [[ -x "${HOME}/.bun/bin/bun" ]]; then
  BUN_EXECUTABLE="${HOME}/.bun/bin/bun"
else
  print "Bun is required but was not found in PATH or ~/.bun/bin/bun."
  exit 1
fi

exec "$BUN_EXECUTABLE" run start
