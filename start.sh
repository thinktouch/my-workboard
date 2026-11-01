#!/bin/sh
set -eu
workboard_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$workboard_dir"
if [ -x "$workboard_dir/runtime/node" ]; then
  workboard_node="$workboard_dir/runtime/node"
elif command -v node >/dev/null 2>&1; then
  workboard_node=$(command -v node)
else
  printf '%s\n' 'Node.js 22.13 or later is required.' >&2
  exit 1
fi
exec "$workboard_node" "$workboard_dir/server.mjs"
