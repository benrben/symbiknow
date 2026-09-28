# Jev investigation views and visual system

**Owner:** Jev worker (GPT-6 Sol). **Owned production files:** `src/InsightsPanel.tsx`, `src/insights.css`, `src/brand-theme.css`, `src/GroupSuggestions.tsx`, `src/group-suggestions.css`. Own related tests. Root owns `src/App.tsx`, Canvas integration, backend decision contracts, and cross-surface change model; request needed changes.

## Tasks

1. Repair Jev dark mode contrast using semantic light/dark tokens. Audit headings, evidence, dismiss/secondary actions, counters, previews, badges, inputs, and focus states. Keep selected, warning, success, error, and destructive meanings distinct. Preserve the current warm canvas, dark teal shell, mint, blue, and coral identity.
2. Improve all six in-place views. Review findings should present the issue, affected passage, impact, confidence limits, proposal, and next action; hide raw Jev question IDs behind a technical detail. Groups must distinguish inferred grouping from saved canvas groups. Connections and Labels need current-state/coverage context before asking for a run. Duplicates needs an explanatory zero-result state and clearer review path. More should be a focused workspace-runs view with repeated canvas actions removed or linked to their primary views.
3. Implement ARIA tab keyboard behavior (Left/Right, Home/End, roving tab stop) and maintain a visible selected view name at 800px.
4. Make preview, selection, Apply, Undo, and reverted states read as one decision flow. Show affected documents and before/after values. Coordinate any canvas ghost preview with root; do not claim visual preview exists unless implemented.
5. Simplify the oversized Jev hero after first entry so the first actionable finding is visible without excessive scrolling. Harmonize topbar Groups, Browse groups, Places, and Jev Groups terminology with root.
6. **A3/A4:** Each finding should link its claim and impact to a reusable evidence record: exact passage, source document and revision, last checked time, and navigation target. **Create task from finding** should pass that evidence, affected documents, suggested owner, and an investigation backlink to Tasks. Root owns the shared type and storage contract.
7. **A5/D1/D2/D3:** Use the shared operation states and partial/failure receipts. Keep More for Workspace runs and remove repeated canvas action buttons; each removed action stays available in Groups, Connections, or Labels. Keep one Browse groups navigation route and one Jev Organize route. Collapse repeated intro/preview copy after first use, while keeping full guidance available on demand.

## Acceptance

- Six icons each reveal a focused view in place at 1440px and 800px, light and dark.
- The first Review finding states evidence and impact in plain language; technical fields remain accessible on demand.
- An empty Connections/Duplicates result has no `Apply selected (0)` affordance and explains what was checked.
- Groups distinguishes proposal from saved state; preview selection persists correctly through Apply and Undo and ends in an explicit reverted receipt.
- Keyboard arrows switch Jev tabs; focus is visible. Dark normal text is legible on its actual background.

## Evidence

Screenshots: `/tmp/allteam-1440-jev-review.png`, `/tmp/allteam-1440-jev-dark.png`, `/tmp/allteam-800-dark-jev-review-deep.png`, `/tmp/allteam-1440-jev-groups.png`, `/tmp/allteam-1440-jev-connections-result-deep.png`, `/tmp/allteam-1440-jev-duplicates-result-deep.png`, `/tmp/allteam-800-jev-preview.png`, `/tmp/allteam-800-jev-undone.png`.
