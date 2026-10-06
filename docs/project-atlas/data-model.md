# Data model

What SymbiKnow stores, where it lives on disk, and what each field of a canvas card and workspace means.

## On-disk layout of `DATA_DIR`

Everything durable is under `DATA_DIR` (default `./data`). Back up this folder and you have backed up the workspace. JSON writes are atomic (temporary file, fsync, rename) and go through one serialized write queue.

```text
DATA_DIR/
├── workspaces.json                 WorkspaceSummary[]: workspaces, canvas ids and names
├── canvases/<canvasId>.json        one canvas: name, workspaceId, blocks (metadata only)
├── docs/<blockId>.md               the document source (source of truth)
├── .versions/<blockId>/            a separate Git repository per document
├── settings.json                   providers, keys, secrets, MCP servers, MCP token hashes
├── mcp-activity.json               recent MCP calls by token
├── investigations/<id>.json        saved research sessions
├── sites/<name>/                   website block sources (example: team-docs, MkDocs)
├── site-cache/                     generated website builds
├── jev/workspaces/<ws>/state.json  Reflex jobs, proposals, receipts, settings, profiles
├── jev/drafts/  jev/parent-undo/   staged edits and causal Undo records
├── jev-cache/<canvasId>.json       bounded Reflex projections, checked against file digests
├── jev-merges/<id>.json            merge transaction journals
├── jev-usage/YYYY-MM.jsonl         old monthly usage log (no longer written; jev-usage.ts was deleted)
├── symbi-index.sqlite              new: rebuildable search index (FTS5 + vectors)
├── symbi-judgments.json            new: cached brain-tool judgments (max 256)
└── model-cache/                    new: transformers.js cache for the MiniLM worker
```

> `tasks/`, `jev-feedback/`, `jev-inbox/`, and `jev-runs/` in older data folders belong to removed features. Their files are no longer written.

## Workspaces, canvases, blocks

A **workspace** holds **canvases**; a canvas holds **blocks**; each block is one document card. The example workspace `acme-team` has the canvases General, Projects, Knowleage, techs, wiki, planning, and Personal.

```json
{
  "id": "5d206584-9349-4e3e-9666-5c3bc858223e",
  "name": "Projects",
  "workspaceId": "acme-team",
  "blocks": [{
    "id": "rollback-runbook", "title": "Rollback runbook", "file": "docs/rollback-runbook.md",
    "kind": "markdown", "x": 120, "y": 80, "width": 400, "height": 320,
    "links": ["release-plan"], "linkTypes": { "release-plan": "implements" },
    "group": "release/operations", "tags": ["release"], "purpose": "runbook",
    "incarnation": "…", "sourceGeneration": 3, "metadataRevision": 7,
    "jevOwnership": { "pins": [], "removedLabels": [], "removedLinks": [], "managed": ["tags"] }
  }]
}
```

## `CanvasBlock` fields (`shared/types.ts`)

| Field | Meaning |
| --- | --- |
| `id`, `title`, `file` | Identity, display title, source path `docs/<id>.md` |
| `kind` | Stored loader: `markdown`, `slides`, `website`, `mdx`. HTML is stored as markdown with `format: html`; MCP reports `kind: "html"` plus `storageKind` |
| `content`, `contentLoaded` | Source text. Summary reads return `""` and `contentLoaded: false` |
| `contentHash` | First 16 hex chars of SHA-256 of the content; send back as `expectedContentHash` |
| `x`, `y`, `width`, `height` | Position and size (new cards are 400 × 320) |
| `links`, `linkTypes` | Same-canvas links and relation: `prerequisite`, `implements`, `decision_for`, `supersedes`, `contradicts`, `example_of`, `same_topic`, `related` |
| `crossLinks` | Links to other canvases `{ canvasId, blockId, relation?, confidence? }` |
| `group` | Group path such as `release/operations`; display names come from `groupLabels` |
| `tags`, `purpose`, `workArea`, `reviewer` | Labels and classification set by people or Reflex |
| `incarnation`, `sourceGeneration`, `metadataRevision` | Server-owned counters; Reflex uses them to reject stale work |
| `jevOwnership`, `jevMutationId` | What Reflex manages and what a person pinned or removed. Manual choices win |
| `lock` | Active edit lock `{ owner, expiresAt, note? }` |
| `archived`, `stale`, `processingExcluded` | Hidden, superseded, or excluded from Reflex |
| `headline`, `freshness`, `quality` | Historical fields from removed actions; still readable |

## Documents and frontmatter

A document is the exact file bytes. Frontmatter selects special loaders.

An uploaded HTML page:

```markdown
---
format: html
---
<!doctype html>
<html>…</html>
```

A website block:

```markdown
---
generator: mkdocs
source: sites/team-docs
---
```

## Settings and secrets

`settings.json` holds the chat provider and model, per-provider keys, agent profiles, plugin switches, named secrets, external MCP servers, and hashed MCP tokens. `GET /api/settings` never returns keys, secret values, or token values. The Reflex provider key is the secret `TYPESAFE_API_KEY` (or the same environment variable).
