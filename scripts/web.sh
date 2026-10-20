#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if [ -d .tools/node/bin ]; then PATH="$PWD/.tools/node/bin:$PATH"; export PATH; fi
npm --prefix frontend ci
npm --prefix frontend run build
exec uv run --locked python -m symbiknow.api.mcp --web "$@"
