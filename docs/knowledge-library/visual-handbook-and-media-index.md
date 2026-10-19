# Symbiknow / Development / Visual handbook and media index

Repository documentation. Snapshot: 17 October 2026.

## Purpose

The visual handbook supplements Symbiknow's Markdown guides with a six-page PDF, three implementation diagrams and two screenshots of the live UI as captured on 13 October 2026. The images/PDF remain dated media; the current Markdown guides describe the later runtime and interface. These are documentation files imported as actual PNG/PDF bytes through MCP. They are not fictional test-library examples or a replacement for the implementation guides.

## Media inventory

| Library filename | Content and source |
| --- | --- |
| Symbiknow visual handbook.pdf | Architecture, transfers, search evidence, desktop/PDF reading, Canvas recovery and MCP operation. Source: `output/pdf/Symbiknow visual handbook.pdf`. |
| Symbiknow architecture diagram.png | Browser and MCP agents share one Python owner, OCFL originals, derived LanceDB evidence and existing model boundaries. |
| Symbiknow MCP file flow diagram.png | Actual upload bytes, version commit, retry identity, asynchronous indexing and direct version-pinned download. |
| Symbiknow search evidence diagram.png | Ranked retrieval, six-window context, bounded Jev assessment, current-head publication and exact source access. |
| Symbiknow library cards screenshot.png | Current real Symbiknow folder in Cards, captured on 13 October in a fresh browser context. |
| Symbiknow library canvas screenshot.png | Current real Symbiknow folder in Canvas, captured in the same fresh context. |

PNG originals are under `docs/media/`. Diagrams are generated from checked source facts; their arrow layout is explanatory rather than a full dependency graph. Screenshots show the library before this media import and are a dated snapshot, not a fabricated UI mockup. A screenshot's OCR or visual similarity does not establish accepted textual answer support.

## Contracts described by the 13 October handbook

The HTTP owner serves UI at `http://127.0.0.1:8765` and MCP at `/mcp`. That historical handbook describes upload, download and search; the current API also adds upload_folder and download_folder on 19 October 2026. Originals and independent versions live in OCFL managed by rocfl. Local EmbeddingGemma 2 indexes representations; hosted Jev checks selected text. Policy `answer-routing-10` retains support, correction, coverage, disagreement, possible references and uncertainty as separate concepts.

The current interface supports Dark/Light/System, real media previews, version-bound PDF page navigation and repeated evidence activation. Canvas geometry version 3 reserves manual coordinates; old unknown compact search layouts retain compatibility until explicit Reflow, with persisted Undo. Presentation actions do not change stored content versions or rerun retrieval.

## Reproduction and import provenance

`outputs/library-media-refresh/create_handbook.py` builds the diagrams and PDF. `capture-ui.mjs` records screenshots without changing the user's saved map/preferences. PDF authoring dependencies were placed in an isolated temporary folder rather than added to the application environment. All six PDF pages were rendered with the application's existing PDFium runtime and visually checked; extractable page text was checked independently.

`docs/library-media-refresh-receipt.json` records source paths, MIME types, source hashes, request IDs, document IDs, versions, download-integrity checks and indexing/search outcomes. Unchanged documents retain their current version. Existing changed docs retain their identity and history.

## References

- `README.md`, `UI.md`, `VALIDATION.md`
- `docs/architecture.md`, `docs/mcp-reference.md`, `docs/project-library.md`
- `app/server.py`, `app/storage.py`, `app/search.py`, `app/jev.py`
- `frontend/src/components/LibraryCanvas.tsx`, `ContentCard.tsx`, `DocumentInspector.tsx`

The handbook describes current implementation and dated recorded validation; it does not certify independent model accuracy or target-machine capacity.

## 17 October interpretation

The media sources are preserved as the 13 October snapshot. Current source uses prompt `project-membership-5/search-evidence-14`, routing `answer-routing-12`, the PyTorch INT8 runtime on tested MPS and the newer Overview/readable Map/focused reader. Use `docs/current-status.md`, `docs/memory-runtime.md` and `UI.md` for current behavior. Unchanged media stays on its existing version during sync; it is not presented as a newly captured interface.
