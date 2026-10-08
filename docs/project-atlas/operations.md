# Run and test

How to run SymbiKnow, configure it, check a change, and what the project's terms mean.

## Run locally

```sh
npm ci
npm run dev            # API on :8787 (tsx watch) + Vite on http://127.0.0.1:5173
```

Production:

```sh
npm run build          # avatar sync → tsc → vite build → SDK build
npm start              # tsx server/index.ts, serves dist/ and the API
```

The first run creates the example workspace *Acme Team*. The app does not load `.env`; set variables in your shell or platform (see `.env.example`).

| Script | Does |
| --- | --- |
| `npm run dev` | Server and web app together (`concurrently`) |
| `npm run mcp` | stdio MCP server for a local agent |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm test` | Build, then Vitest through `.quality/run-tests.mjs` (4 workers, JSON report, prints failures) |
| `npm run acceptance` | Build, then Cucumber + Playwright scenarios |
| `npm run smoke` | SDK build, then `features/smoke.js` |
| `npm run build:sdk` | Emits `dist/sdk/sdk.js` and declarations for the Jev SDK |

## Environment

| Variable | Purpose |
| --- | --- |
| `HOST`, `PORT` | Bind address (default `127.0.0.1`) and port (default `8787`). The server warns when `HOST` is public without an access token |
| `DATA_DIR` | Content folder (default `./data`); keep it on persistent storage |
| `PUBLIC_URL` | Address shown in Settings for MCP connections and used in deep links |
| `SYMBIKNOW_ACCESS_TOKEN` | Protects the workspace; browsers get an HTTP-only `symbiknow_session` cookie |
| `SYMBIKNOW_MCP_TOKEN` | Fixed MCP token for automation |
| `SYMBIKNOW_AGENT_NAME` | Author name for a local stdio agent |
| `SYMBI_MODEL_ROOT` | Override for the offline model folder; defaults to `<DATA_DIR>/models`, containing `Xenova/all-MiniLM-L6-v2/model_int8.onnx` |
| `TYPESAFE_API_KEY`, `TYPESAFE_MODEL` | Symbi Reflex provider key and model (default `jev-1.13.0`) |
| `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` | Fallbacks for chat provider keys saved in Settings |
| `CANVAS_API_URL`, `CANVAS_API_TOKEN` | Where the stdio MCP server sends API calls |
| `ALLTEAM_*` | Older names, still accepted |

## Self-hosting checklist

1. Run behind HTTPS (Caddy, nginx, or a platform load balancer) with `HOST=0.0.0.0`.
2. Set `SYMBIKNOW_ACCESS_TOKEN` and `PUBLIC_URL`.
3. Put `DATA_DIR` on persistent storage and back it up.
4. Optional: install MkDocs (`uv pip install -r requirements-site.txt`), Hugo, or Docusaurus for website blocks.
5. For offline semantic search, install the pinned MiniLM artifacts under `<DATA_DIR>/models` or the `SYMBI_MODEL_ROOT` override. This checkout already has the verified artifacts in `data/models`.

## Checks before a change

```sh
npx playwright install chromium   # once
npm run lint
npm run typecheck
npm test
npx cucumber-js
```

CI (`.github/workflows/ci.yml`) runs the same checks on pushes and pull requests.

## How the tests are organized

| Kind | Naming | Notes |
| --- | --- | --- |
| Unit | `*.test.ts(x)` | Next to the code |
| Public behavior | `*.public.test.ts(x)` | Through public functions and routes |
| Native | `*.native.test.ts(x)` | Real files, real SDK, loopback HTTP providers, isolated temp folders |
| Native persistence | listed in `vitest.config.ts` | Run alone (no file parallelism) to measure canonical writes |
| Fixtures | `*.test.fixture.ts`, `*.test.helpers.tsx` | Shared setup |
| Acceptance | `features/*.feature` + `.feature.yaml` + `step_definitions/*.js` | 12 features: app-safety, assistant-avatar, canvas, canvas-discovery, canvas-loading, chat-avatar, engine, jev-document-operation, jev-indexed-grouping, jev-removal, review-fixes, symbi-reflex |

Tests never touch the live `data/` folder; they create temporary data directories. Provider tests use local fixture providers, so they make no paid calls.

## Glossary

| Term | Meaning |
| --- | --- |
| Workspace | A set of canvases with shared Reflex settings |
| Canvas | An infinite board of document cards |
| Block / card / document | One document on a canvas, backed by `docs/<id>.md` |
| Kind / loader | How a document renders: markdown, html, slides, mdx, website |
| Group | A named area on a canvas (`group` path) that collects related documents |
| Link / cross-link | A relation between documents on the same / another canvas |
| `contentHash` | 16-hex SHA-256 prefix of a document; the basis of safe writes |
| Actor | Who made a change, from `x-symbiknow-actor` (Browser, Symbi, agent name) |
| Lock | A time-limited claim on editing a document |
| Symbi | The chat assistant |
| Symbi Reflex | The automatic organizer that runs six actions |
| Jev | The TypeSafe decision engine behind Reflex and the brain tools; also the internal name for Reflex |
| Choice / Score / Noul | Jev question types: pick an option, pick a level, give a probability |
| Proposal | A prepared change waiting to be applied (chat or agent) |
| Receipt | A record of an applied Reflex change, with an inverse proof for Undo |
| Document plan | Reflex's durable plan for running the six actions on one source |
| Checkpoint | The durable point at which all six actions for a source are complete |
| Threshold | Minimum confidence (0.5–1.0, default 0.7) per action |
| Incarnation / generation / metadata revision | Server counters that detect replaced files and changed metadata |
| Brain tools | `ask_symbi` and `symbi_reflex`, the default agent-facing search and claim-check tools |
| Coverage | How much of the scoped workspace a search actually checked: ready, pending, or degraded |
| Research canvas | A temporary answer graph the assistant draws next to chat |
| WebMCP | Browser-side MCP that lets an agent drive the open tab |
