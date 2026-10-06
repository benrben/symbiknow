# Project documentation

- [Architecture and feature atlas](project-atlas/README.md): repository map, system behavior, and operations.
- [Symbi Reflex and SDK](jev/README.md): engine behavior and integration contracts.
- [Research canvas](research-canvas.md): research workflow.
- [Historical Symbi engine plan](plans/symbi-engine.md): the earlier implementation goals, including the retired Tasks feature.

Source code lives in `src/` (React client), `server/` (API and storage), and `shared/` (cross-boundary types). Acceptance scenarios and browser steps live in `features/`; focused tests sit beside the code they exercise. `brand/` contains design sources, `public/` contains served assets, and `vendor/` contains the pinned local WebMCP dependency.

Build output, local workspace data, quality reports, and local benchmark runs are excluded from Git. Benchmark traces in `work/` can contain workspace content; keep them on the machine where they were captured. Historical design briefs remain available in Git history; the current product contract is in the root README and API reference.
