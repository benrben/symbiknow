# Desktop UX implementation plan

Scope: implement the 2026-09-28 UI/UX review for 1440px and 800px desktop in light and dark themes. Mobile is out of scope. The running app must remain usable while work proceeds. Existing uncommitted changes belong to the user and must be preserved.

## Product contract

The user's journey is **question or signal → scope → evidence → finding → proposed change → selection and approval → execution receipt → verification → Undo or follow-up task**. Chat, Jev, document history, MCP agents, uploads, and Tasks should use the same language and status meanings. Proposed changes must be reviewable before they mutate saved work. Every result should say what changed, what did not, and how to recover.

## Chosen palette

These colors are implementation requirements for both themes, including inline component styles and modal overlays. Status also needs a text label or icon.

| Role | Light | Dark | Use |
| --- | --- | --- | --- |
| Base text / canvas | `#172B31` / `#F7F5EF` | `#EAF1ED` / `#1C2E34` | Reading and primary hierarchy |
| Interactive blue | `#3858B8` on white | `#AFC0FF` on `#1C2E34` | Links, focus, selected navigation |
| Shared action mint | `#172B31` on `#BCE7C9` | `#172B31` on `#BCE7C9` | Apply and collaborative creation |
| Needs review amber | `#8A5A14` on `#FFF4DE` | `#FFD28B` on `#3E3423` | Uncertain findings and pending approval |
| Destructive red | `#A92E43` on `#FFF0F2` | `#FFB4BE` on `#40272D` | Delete, revoke, failed action |

The shared semantic tokens are `--sk-text`, `--sk-canvas`, `--sk-blue` / `--sk-link` / `--sk-focus`, `--sk-action` / `--sk-action-bg`, `--sk-pending` / `--sk-pending-bg`, and `--sk-error` / `--sk-error-bg`. Verify computed colors on representative controls at 1440px and 800px in each theme.

## Ownership and sequence

| Brief | Owner | Model | Production area |
| --- | --- | --- | --- |
| [01-shell-search-history.md](01-shell-search-history.md) | shell worker | GPT-6 Sol | `AppDialogs`, `VersionPanel`, `CanvasSearch`, shell/search/editor CSS |
| [02-jev-theme.md](02-jev-theme.md) | Jev worker | GPT-6 Sol | `InsightsPanel`, Jev/group CSS and brand theme tokens |
| [03-settings-tasks-intake.md](03-settings-tasks-intake.md) | settings worker | GPT-6 Luna | `SettingsPage`, Settings/Tasks/upload UI and CSS |
| [04-chat-mcp-integration.md](04-chat-mcp-integration.md) | root, Jev worker on proposals, shell worker on Agent Activity | GPT-6 Astra / GPT-6 Sol | `App`, Chat/research UI, MCP/backend/shared contracts, integration |

Workers are not alone in the codebase. Do not revert anyone else's edits. Ask the root agent for an App/backend/interface change rather than editing outside owned files. Tests for an owned component stay with its worker. The root coordinates shared types, acceptance scenarios, build, browser review, and the full quality gate. No worker edits `.quality/` or commits.

## Release sequence

1. **Usability and data protection:** 800px layout, focus and dirty guards, dark contrast, MCP field layout, honest search/error states, Task Undo, Chat/research recovery.
2. **Decision quality:** Jev evidence and all six views, branch diffs, Chat source navigation and verification coverage, full preview/Apply/Undo receipts.
3. **Agent operations:** scoped MCP access, tool and action activity, persistent investigations/conversations, findings-to-task links, navigation and copy simplification.
4. **Certification:** focused tests; typecheck/lint; browser checks at both widths/themes; then `scripts/quality --root . --local-changes` with `QUALITY_LOOP=PASS`.

## Shared acceptance checks

- At 800px, topbar, sidebar, reader, editor, Settings forms, research, and assistant controls do not overlap or clip; all primary actions are reachable.
- Light and dark text, controls, selected states, focus, warnings, and errors remain readable. Color is never the only status cue.
- Keyboard access includes modal focus containment and restoration, dirty-discard choice, Jev tab arrows, Settings radio arrows, and search result navigation.
- A user can inspect evidence and affected revisions before approving a change, choose individual actions when relevant, and see an applied/reverted receipt.
- Chat clearly distinguishes checked, unchecked, unsupported, and unavailable claims; cited evidence navigates to the relevant document passage and offers return navigation.
- MCP setup distinguishes external tools from access granted to external agents; permission scope and activity are visible.
- No existing user data or uncommitted source changes are reverted by implementation or tests.

## Added finding traceability

The 10 additional findings supplied by the user are assigned below. The item IDs stay in the briefs until their acceptance checks are met; an existing partial implementation does not close the broader item.

| ID | Area brief | Required result |
| --- | --- | --- |
| A1 | 04 | Agent Activity: health, effective permissions, recent tool calls, outcomes, affected objects, revisions, revoke |
| A2 | 04 | Named conversation and investigation recovery with private/shared choice and links back to sources/proposals |
| A3 | 04, 02, 01 | Shared evidence object: claim, exact passage, document revision, check time, navigation target |
| A4 | 02, 03, 04 | Finding → Task handoff with evidence, affected documents, owner proposal, investigation backlink |
| A5 | 04 with all UI owners | Consistent preparing/review/apply/partial/fail/revert states with retry and save receipts |
| D1 | 02 | Remove duplicate canvas actions from Jev More; use focused views, retain Workspace runs |
| D2 | 01, 02, 04 | One Browse groups navigation entry and one Jev Organize change route with links between them |
| D3 | 02, 03 | Short Jev intro and client-specific Settings instructions collapsed until requested |
| C1 | 04 | Optional replayable investigation timeline including evidence, approvals, agent actions, revisions |
| C2 | 04 | Optional stale-source marker and one-click recheck with comparison for saved answers |

Priority and effort from the supplied findings: **A1 P1/L, A2 P1/L, A3 P1/L, A4 P2/M, A5 P1/M, D1 P2/S, D2 P2/M, D3 P2/S, C1 P3/L, C2 P3/M.**

Verification for A3 must distinguish a literal passage from an approximate excerpt. A5 must say whether a partial operation saved any changes and whether retry is safe. D1 and D2 must retain a clear route to every affected capability. The screenshots named in the supplied findings are visual references, not implementation acceptance by themselves.

## Current handoff status

The desktop UI, Jev focused views, Chat source review and staged changes, document history/branch preview, uploads, Tasks handoff, MCP scopes/activity, named investigations, dark/light palette, and compact 800px navigation have working implementations and focused tests. The visible Chat suggestion overflow and document overflow menu contrast reported in screenshots are fixed.

The added finding acceptance status is explicit:

| Item | Status | Next result required |
| --- | --- | --- |
| A2 | Implemented | Named private/shared investigations persist messages, source and proposal references, and the complete research graph; they reopen after refresh. Chat proposal review and receipts currently remain available for one hour. |
| A3 | Implemented | Jev, Chat claim checks, search, and research use the shared evidence shape with a source passage, content hash, check time, and navigation; approximate context is labeled honestly. |
| A4 | Implemented | Finding-derived Tasks persist evidence, affected documents, owner suggestion, and an optional user-selected saved investigation ID with a return action. |
| A5 | Implemented | Jev, Chat, uploads, search, and version history distinguish preview, save, partial results, uncertain failures, receipts, and safe recovery guidance. |
| C1 | Planned optional | Build the replayable investigation timeline after essential flows are complete. |
| C2 | Implemented optional | Saved investigations compare stored source context/hash with current documents and offer a one-click Chat recheck when a source changed. |

Do not mark these items complete based on a passing focused test for only one surface. The repository's configured full quality gate also contains longstanding 100% line/branch coverage, complexity, error-path, and 600-line limits; track its actual report separately from the user-facing workflow checks.

## Latest verification

- Desktop browser checks at 1440px and 800px, light and dark: chosen palette tokens matched exactly; long Chat replies, research evidence, saved source comparisons, and source-reader return had no horizontal page overflow or browser errors.
- Unit suite: 668/668 passed. Cucumber: 45 scenarios and 363 steps passed. Typecheck, ESLint, and diff check passed. Web and API development servers both return HTTP 200.
- The full quality gate remains `QUALITY_LOOP=FAIL` with 210 items in 35 files under its 100% coverage, complexity, error-path, and file-size rules. Its test execution, Gherkin acceptance, lint, typecheck, smoke, dependency, and secret checks passed. This gate debt is recorded separately from the UX task acceptance.
- C1 remains an optional planned task. Saved Chat proposal artifacts expire after one hour; an older investigation still reopens its messages, research, sources, and proposal reference, but the proposal must be prepared again after expiry.
