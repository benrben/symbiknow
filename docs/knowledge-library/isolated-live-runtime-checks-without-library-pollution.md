# Symbiknow / Operations / Isolated live runtime checks without library pollution

Repository implementation guide. Snapshot: 12 October 2026.

## Runtime-only probe
check-runtime.py constructs actual local query/document/image embeddings and optional hosted Jev judgment over supplied synthetic text. Its colored-square comparison is a narrow visual ranking diagnostic. It does not need to import those passages into the user's app library.

## End-to-end isolated probe
check-mcp.py creates a temporary data directory, connects a real stdio MCP owner there, sends actual bytes, verifies downloads and waits for indexing before answering. It uses a distinct owner/data path rather than starting another process on the live library. Runtime configuration can still send that explicit synthetic text to the hosted provider.

## Browser fixture
tests/ui_fixture.py supplies an isolated OCFL/LanceDB library with deterministic embedding/Jev. Playwright runs it on its fixture port and uses a separate Vite proxy. Those model responses validate interaction contracts, not hosted quality.

## Operational checklist
Keep synthetic documents out of the real project library. Record which provider/model was real and which was deterministic. Distinguish independent labels from authored known examples. Stop temporary fixture processes after the check and retain evidence outside the library unless the user explicitly asks to import a report.

A runtime availability pass is not a corpus accuracy or target-capacity qualification.

## Source references
- `scripts/check-runtime.py`
- `scripts/check-mcp.py`
- `tests/ui_fixture.py`
- `frontend/playwright.config.ts`

This guide describes the checked implementation and its stated limits, not a separately certified external specification.
