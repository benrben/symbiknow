# Symbiknow / Operations / Local security and content rendering boundaries

Repository implementation guide. Snapshot: 12 October 2026.
## Deployment boundary
The application is a local loopback service, normally on 127.0.0.1:8765. Its design is not a public multi-user authenticated service. Do not infer account permissions, tenant isolation or internet exposure controls from the current local routes.

UI mutations require matching local Host/Origin and the X-Symbiknow-UI header. Foreign-origin cases have regressions. Tool input validates file size, base64, identifiers, offsets, versions and expected-head conflicts. Human bulk ZIP validates the explicit selected versions before producing a successful archive and sanitizes filenames/collisions.

## Untrusted documents
Markdown raw HTML and remote image/link loading are disabled. HTML preview is sanitized in an opaque sandboxed frame with restrictive CSP. Originals are downloadable separately and remain byte-exact. Cards use bounded extracted evidence, avoiding full-document embeds for a large grid.

Jev receives document text as data and selects supplied evidence/choices. Wrong entities, rejected proposals and injected document instructions must not become direct-answer support. These model safeguards need independent quality/security evaluation beyond small tests.

## Secrets and external processing
Credentials stay in local configuration. Hosted Jev can receive selected textual passages; local embedding is a separate path. Uploading a guide should never include a real .env, token dump or private cache. Provider exceptions are sanitized before returning an outage result.

## Qualification
Passing tested origin/script fixtures is not an exhaustive security audit or permission system certification.

## Source references
- `app/ui.py`
- `app/server.py`
- `frontend/src/components/DocumentInspector.tsx`
- `frontend/src/components/Markdown.tsx`

This guide summarizes the checked repository implementation; it is not a separately validated external specification.
