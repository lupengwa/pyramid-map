#!/bin/zsh
set -euo pipefail

MAP_DIRECTORY=${0:A:h}
PYRAMID_MAP_DIRECTORY=${MAP_DIRECTORY:h:h}

if command -v bun >/dev/null 2>&1; then
  BUN_EXECUTABLE=$(command -v bun)
elif [[ -x "${HOME}/.bun/bin/bun" ]]; then
  BUN_EXECUTABLE="${HOME}/.bun/bin/bun"
else
  print "Bun is required but was not found in PATH or ~/.bun/bin/bun."
  exit 1
fi

cd "$PYRAMID_MAP_DIRECTORY"
exec "$BUN_EXECUTABLE" run bin/pyramid-map --map "$MAP_DIRECTORY" open
