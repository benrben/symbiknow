# Symbiknow OCFL metadata reader

Read-only metadata helper using the pinned rocfl library. Build from the repository root:

```sh
sh scripts/setup/install_ocfl_reader.sh
```

The runtime binary is `.tools/native/bin/symbiknow-ocfl-reader`; its argument is the
OCFL root (`data/files`). The Python owner is `backend/symbiknow/library/storage.py`.

Protocol, limits, recovery, and the optional benchmark seeder are documented in MCP:
**Symbiknow — Preserve originals and versions**, `4c7ff531-dcb1-5b4e-95c9-8b630928ccae`.
See [AGENTS.md](../../AGENTS.md) for retrieval. Without MCP, inspect `src/main.rs`
and the Python owner before changing the protocol.
