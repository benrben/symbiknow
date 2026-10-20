#!/bin/sh
# One shared backend owner, plus Vite's frontend hot reload.
set -eu
cd "$(dirname "$0")/.."
if [ -d .tools/node/bin ]; then PATH="$PWD/.tools/node/bin:$PATH"; export PATH; fi
command -v npm >/dev/null || { echo 'Install Node.js 22+ first.' >&2; exit 1; }
uv run --locked uvicorn symbiknow.api.http:create_app --factory --reload --reload-dir backend/symbiknow --host 127.0.0.1 --port 8765 &
ui_backend_pid=$!
npm --prefix frontend run dev &
ui_frontend_pid=$!
cleanup() { kill -INT "$ui_backend_pid" "$ui_frontend_pid" 2>/dev/null || true; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
wait "$ui_backend_pid"
