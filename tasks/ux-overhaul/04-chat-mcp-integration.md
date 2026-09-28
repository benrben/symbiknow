# Chat, research, MCP backend, and integration

**Owner:** root (GPT-6 Astra), with bounded backend follow-ups delegated to the Jev and shell workers (GPT-6 Sol). **Root-owned production files:** `src/App.tsx`, `src/AIElementsChat.tsx`, `src/ai-chat.css`, `src/chatStream.ts`, `src/AnswerCanvas.tsx`, `src/answer-canvas.css`, shared contracts, and non-Chat routing integration. **Jev worker proposal files:** `server/chat-stream.ts`, Chat proposal routes in `server/index.ts`, `server/chat-stream.test.ts`, and new `server/chat-proposals.ts`/tests. **Shell worker Agent Activity files:** `server/mcp.ts`, `server/mcp-http.ts`, `server/storage.ts` MCP activity methods, and new `server/mcp-activity.ts`/tests. Root also owns `.quality/`, task briefs, browser certification, and coordination. Do not edit another agent's owned production files; send interface requests.

## Tasks

1. Establish a shared investigation/change record for question, scope, evidence, proposed actions, selected approval, execution receipt, verification, and Undo. Keep existing Jev workspace run behavior working. Connect Jev, Chat edits, MCP changes, Tasks, and document history through a common user-facing trail in staged increments.
2. Make Chat source verification accurately report checked versus unchecked claims and unavailable checks. Expose source passage and document revision for each claim; navigate directly there and offer a return path. Persist source navigation across long answers.
3. Replace post-write Chat edit review with a full pre-apply proposal/diff and explicit Apply/Undo. Preserve separate merge approval safety. Show tool activity as observable reads, proposals, writes, results, and errors without presenting private model reasoning.
4. Persist conversations and session research, or at minimum make refresh/New chat recoverable with Save/Discard/Keep. At 800px, research should favor a readable answer outline and let Chat collapse into a drawer.
5. Provide MCP tokens with scoped read/propose/write capability and workspace/canvas/tool restrictions, plus a user-facing activity ledger. Keep token author attribution, lock/conflict behavior, and existing clients. Provide Settings UI contracts to the settings worker early.
6. Link Jev findings, Tasks, Chat proposals, MCP operations, and resulting document revisions. Integrate terminology and navigation changes from the other workers.
7. Run browser flows at both widths/themes, real read/write/read-back/Undo, failure recovery, focused tests, typecheck, lint, and full quality ship report. Keep `npm run dev` available at `http://127.0.0.1:5173/`.
8. **A1:** Build a persistent Agent Activity view/ledger that joins token and connection health, effective access, tool call and result, affected canvas/document, linked Git revision, and revoke. Make failures and read-only calls visible; do not infer activity solely from last-used timestamp.
9. **A2:** Save named conversations and investigations with a private/shared choice, recovery after refresh, and links to their source documents and proposed changes. Browser-local automatic recovery is a first stage, not the full completion criterion.
10. **A3:** Define and persist a shared evidence object containing the supported claim, exact passage, document ID, content revision, last checked time, and navigation target. Render it consistently in Jev, Chat claim verification, search, research, and findings-to-Tasks. An approximate excerpt must be labeled as such.
11. **A4/A5:** Persist the investigation reference and suggested owner on finding-derived Tasks. Standardize operation states across Chat, Jev, MCP, search, upload, and version actions: preparing → ready for review → applying → applied/partially applied/failed safely → reverted. Each result says what saved, what remains selected, and whether Retry is safe.
12. **D2:** Integrate one Browse groups navigation control and one Jev Organize change route, with a clear link between them.
13. **C1 (optional after essentials):** Replayable investigation timeline with source, approval, agent action, and revision snapshots at each step.
14. **C2 (optional after essentials):** Detect saved answers whose source revision changed; mark them stale and offer one-click recheck with a before/after comparison.

## Acceptance

- Every saved assistant change has a reviewable proposed state and a visible applied/reverted receipt; no normal Chat edit writes first and asks for review second.
- Claim badge gives exact coverage; a cited claim opens its supporting passage/revision and allows return.
- New chat or refresh does not silently discard unsaved research or the current conversation.
- MCP setup displays effective scope, agents cannot call tools beyond scope, and activity identifies actor, operation, result, and affected object.
- Named/private/shared investigations survive refresh. Their evidence and task links reopen the exact source revision and passage when available.
- A partially applied or failed operation has an honest receipt stating exactly what did and did not save; retries never silently repeat successful writes.
- The desktop UI passes the shared acceptance checks in `README.md`, with the full quality gate green.
