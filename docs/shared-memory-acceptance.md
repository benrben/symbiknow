# Shared memory acceptance checklist

**Story:** you, Symbi chat, Reflex, and coding agents work on one shared memory, and every change stays named. The runtime and stored actor IDs use Jev internally; automatic changes are displayed as **Reflex**.

Use a new, disposable launch canvas for this run. A scene passes only when its observable behavior is demonstrated on the actual app and its saved state survives reload. Keep source IDs, revisions, actor names, elapsed times, and screenshots with the result. Title cards and diagrams are presentation assets rather than evidence of app behavior.

## Launch inputs

- [ ] Upload the exact eight files in [launch-dry-run](../features/fixtures/launch-dry-run/), alphabetically into a fresh canvas in one burst. Titles come from their first heading; no extra tags or category headings are added.
- [ ] Keep the rollback copy’s distinct heading and filename. Its substantive body is identical to the original; both documents retain their own IDs and source bytes.
- [ ] Preserve **Oct 21** and its SSO-review condition exactly as supplied in Launch blockers. Date checks should report uncertainty when the question needs an unspecified year.
- [ ] Give Launch blockers and SSO security review explicit unresolved launch blockers. Make the pricing decision and pricing copy consistent enough to verify their relationship.
- [ ] Use the same workspace, canvas, and document IDs for the browser, Symbi, Jev, and all MCP clients throughout the run.

## Scene checks

| Scene | Acceptance check | Evidence required |
| --- | --- | --- |
| 0 — Title | The title reads “People, Symbi, Jev and AI agents. One shared memory.” | Approved title copy; no app behavior claimed. |
| 1 — Files arrive | All eight files become readable cards on the new canvas. Content, distinct IDs, and the heading-only rollback copy survive reload. | Upload recording, saved canvas readback, and reload. |
| 2 — Jev organizes them on its own | Upload alone starts Jev: tags appear, Security/Pricing/Release groups form, useful links appear, and the rollback copy is flagged as a duplicate. No manual analyze, organize, or approval action supplies the result. Opening Symbi Reflex only observes per-file progress. | Timestamped upload-to-result measurements, job states, saved classifications/groups/links, duplicate finding, unchanged source bodies, and reload. **Keep this scene pending until the live behavior is proved.** |
| 3 — A person edits | Open Launch blockers, add a blocker, and save. A named human revision is recorded and Jev rechecks that new source revision automatically. | Before/after source hashes, human author, refreshed job generation, and new findings tied to the changed source. |
| 4 — Named history | File history exposes each source revision, its author and timestamp. Inspect and restore an earlier revision; restoration creates a new named revision and survives reload. | History UI, restored bytes, new revision ID, and reload. |
| 5 — Symbi chat | “What is still blocking the launch?” yields a grounded answer citing Launch blockers and SSO security review. Symbi proposes a useful edit; source stays unchanged before review. Applying the reviewed edit saves it with attribution. | Live answer and clickable citations, proposal preview, pre-apply source hash, applied revision/author, and reload. Run with the configured chat provider; fixture-provider tests alone do not prove this scene. |
| 6 — Agents connect | Claude Desktop, Claude Code, and Codex can be configured against the same MCP endpoint and shared canvas. Scoped tokens keep their canvas and write permissions. | Endpoint/configuration, successful tool discovery and reads, token-denial checks. A diagram may illustrate clients that are unavailable locally, but does not verify their connections. |
| 7 — An agent works | Claude Code calls `ask_symbi` in logic mode, `symbi_reflex` on “Launch is Oct 21”, then `edit_doc` with the current source hash. The saved card updates in the already-open browser without a manual reload. | Actual tool arguments/results, cited source IDs and reasoning, stale-write protection, named saved revision, and a timed browser update. Chips must reflect these real calls. |
| 8 — Attribution | The same document exposes the human, Symbi, Jev, and Claude Code contributions by name, with timestamps and a link to what each changed. | Source revisions for content edits plus Reflex receipts/activity for organization changes. Verify the UI exposes both; automatic metadata organization alone does not create a Jev Git source revision. |
| 9 — Four actors, one memory | The diagram shows the human, Symbi, Jev, and agents around the shared memory demonstrated above. | Shared canvas/document IDs from the completed checks; approved diagram. |
| 10 — Outro | The outro reads “Logical search memory for agents and people.” and links to the real repository. | Approved copy and `https://github.com/benrben/symbiknow`. |

## Recovery and consistency

- [ ] A missing or unavailable Jev provider produces visible status and a retry path while documents remain editable.
- [ ] Reloading or reconciling unchanged sources does not restart completed Jev work or duplicate groups, links, or findings.
- [ ] Manual organization survives an automatic recheck; duplicate detection never merges or deletes a source.
- [ ] An agent or Symbi proposal with stale source evidence fails safely, preserves the competing edit, and can be reviewed again against the current revision.
- [ ] A revoked or read-only MCP token cannot change documents or tasks; a canvas-scoped token cannot read or write another canvas.
- [ ] Every browser run records zero page errors. Recovery checks include a successful retry and saved readback.

## Todo hand-off in the same memory

- [ ] Create a canvas task in the browser and read it through `list_todos`; create/edit it through MCP and observe the same saved task in the browser.
- [ ] Switch list/board layouts, search, and sort by priority, due date, size, and newest.
- [ ] Mark the task done through either interface: it moves to Archive automatically and stays archived after reload.
- [ ] Restore it to active work without losing its description, assignee, priority, size, or due date.
- [ ] A stale task revision returns a conflict; the browser keeps its draft and explicitly refreshes before retrying.

These todo workflows have native HTTP/MCP and browser coverage in [the todo feature](../features/todos.feature.yaml), [API tests](../server/api-todos.native.test.ts), [MCP tests](../server/mcp-todo-tools.native.test.ts), and [navigation tests](../src/AppTodoNavigation.native.test.tsx).

## Current evidence and remaining checks

The local app's public settings report a configured chat provider and a configured TypeSafe/Jev key. Readiness flags do not prove that either live service accepts requests or produces the expected launch results.

Existing [automatic Reflex acceptance scenarios](../features/symbi-reflex.feature.yaml) test automatic organization, source changes, persistence, reset, and missing-provider recovery through an isolated test provider. [Collaboration tests](../server/collaboration.test.ts) verify real Streamable HTTP MCP, named remote writes, revocation, and the new task tools. These are useful contract evidence; the exact eight-file launch run, live chat answer, real Claude client connections, and four-actor history presentation remain to be demonstrated.

The [file revision view](../src/VersionRevisions.tsx) renders Git source commits. Automatic organization appears in Symbi Reflex’s saved activity with the display actor **Reflex**, the recorded timestamp, and expandable mutation/source evidence. Cards show **Reflex did it**, briefly show **Updated by Reflex** when an already-mounted card changes, and show checked **Possible duplicate** references on both current sources. Findings disappear when either source becomes stale, unavailable, archived, or excluded; an unreadable findings ledger displays recovery status while the canvas remains editable.

[Card acceptance](../features/jev-canvas-status.feature.yaml) exercises real automatic engine writes through an isolated provider, both badges, transient and saved attribution, unchanged source bodies, reload persistence, and exact duplicate navigation with zero browser page errors. [Native launch tests](../server/jev/actions/source-launch-labels.native.test.ts) cover source-derived labels and automatic rechecks without pre-seeded labels or groups; [graph tests](../server/jev/actions/graph-batch.native.test.ts) cover useful links and the heading-only rollback duplicate.

The authorized live TypeSafe probe exposed cross-file request contamination: a pricing document was classified as SSO with probability .83 in a mixed batch, but .01 with identical isolated pricing evidence. Requests now group matching exact source objects; filing candidate context is kept separate from document profiling and labelling. A subsequent four-request live check produced Security/SSO labels and Security filing for the SSO review, and Pricing/Pricing decision labels and Pricing filing for the pricing decision. An additional isolated pricing-copy/decision link check returned no edge because typed evidence did not meet the existing threshold. The exact supplied eight-file burst is now retained as a regression fixture. Context-conflict recovery creates a fresh automatic root with current context, preserving completed receipts and applying bounded backoff. Checked broad topic definitions are carried into tag and group evaluation, and identical substantive bodies can flag a duplicate when only the leading document heading differs. Typed link checks distinguish a prerequisite from an implementation and still require local source evidence at the configured threshold. Body references can nominate a bounded pair when a title qualifier is omitted, such as “SSO review” referring to “SSO security review”; nomination never authorizes an edge.

[Exact-input native checks](../server/jev/actions/launch-dry-run.native.test.ts) pass shared Security/Pricing/Release groups and tags, canonical group definitions, all named launch connections, both duplicate badges, saved readback, and automatic source-edit rechecks. [The exact-input browser scenario](../features/launch-dry-run.feature.yaml) uploads the eight files alphabetically through the ordinary API, verifies automatic saved results, displays arrows and attribution, and reloads with unchanged source bytes and zero page errors. These checks use a synthetic provider and do not demonstrate live TypeSafe judgment. The complete eight-file live automatic rerun remains pending additional probe authorization; the earlier live run is diagnostic evidence, not a pass for scene 2.
