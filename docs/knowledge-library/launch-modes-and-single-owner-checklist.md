# Symbiknow / Operations / Launch modes and single owner checklist

Repository implementation guide. Snapshot: 12 October 2026.
## Built web app
From the repository root, `.venv/bin/python -m app.server --web` serves the built frontend and MCP on port 8765. `sh scripts/web.sh` installs frontend dependencies, builds and starts that same owner. The app URL is http://127.0.0.1:8765 and MCP is http://127.0.0.1:8765/mcp. --port selects a different port.

## Development mode
`sh scripts/dev.sh` uses the existing environment, starts backend reload on 8765 and Vite on 5173, and uses the bundled Node runtime when present. Open the Vite URL for hot frontend reload. The proxy preserves the relevant Host/Origin behavior for local UI mutations.

## Agent connection
Connect official MCP SDK HTTP clients to the running endpoint. Discover the advertised tools; expect upload, download and search. Do not use a stdio client launcher to start a second owner against the same library. A separate isolated fixture must have its own data directory and port.

## Shutdown and restart
Use clean termination, wait for the worker and let the owner release its lock before another process starts or a backup is copied. Python backend edits require restart unless reload mode is active. A built frontend must be rebuilt after source changes, and existing browser tabs need refresh to receive the new asset bundle.

## Runtime truth
A server being reachable does not prove every document is indexed or Jev is available. Check the per-file state and any pending/failed organization summary separately.

## Source references
- `scripts/web.sh`
- `scripts/dev.sh`
- `app/server.py`
- `docs/operations.md`
- `UI.md`

This guide summarizes the checked repository implementation; it is not a separately validated external specification.
