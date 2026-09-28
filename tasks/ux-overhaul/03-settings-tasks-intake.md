# Settings, MCP setup UI, Tasks, and uploads

**Owner:** settings worker (GPT-6 Luna). **Owned production files:** `src/SettingsPage.tsx`, `src/settings.css`, `src/TasksPanel.tsx`, `src/tasks.css`, `src/SmartIntakeDialog.tsx`. Own corresponding tests. Root owns backend MCP permissions/activity contracts and `src/App.tsx`; coordinate API changes with root before wiring.

## Tasks

1. Fix MCP server form at 800px in light and dark. Give the name, URL, auth secret, Test, and Add controls persistent labels and enough width. Do not allow a 22px URL field.
2. Separate the setup language for **external tools Symbi can use** and **agents that can access this workspace**. Show connection status and tested tool names with their capabilities when backend supplies them. Provide client-specific instructions only after choosing a client.
3. Clarify token actions: creation/revocation take effect immediately even when other Settings changes are pending. Make this visible and provide a confirmation for revoke. Do not interpolate a newly created raw token into instructions intended for a shared repository; keep secret copying deliberate and one-time.
4. Improve the long Settings page with scannable sections and clear pending/saved/error states. Keyboard radio group must support arrow keys. Preserve the existing models, agents/secrets, plugins/loaders, and Jev controls.
5. Add Task deletion Undo or confirmation for a task with comments/assignee/linked docs. Make empty and AI analysis states explain the next user action. Support a finding-to-task handoff when root provides a finding reference.
6. For upload intake with no Jev suggestions, replace the empty bordered box with an explicit no-suggestions explanation and summarize title/destination before Add. Keep cancel and skip behavior clear.
7. **A1/A4:** Once root supplies an Agent Activity contract, expose connection health, effective permissions, recent tool calls and outcomes, affected objects, linked revisions, and revoke in Settings or a dedicated view. Task cards created from findings should retain evidence, affected documents, a proposed owner, and a route back to the investigation, not just a copied title.
8. **A5/D3:** Show operation status consistently for connection tests, token actions, task changes, and intake: preparing, ready for review, applying, applied, partially applied, failed safely, reverted when applicable. Explain what saved and whether Retry is safe. Show only chosen client instructions by default; full setup details remain expandable.

## Acceptance

- At 800px in both themes, every MCP form control is readable and operable.
- Users can tell whether a control is pending Settings save or takes effect immediately.
- No copied shared-project config includes a raw bearer token. Revoke has clear consequence text.
- Tasks deleted in the UI can be recovered, or consequential deletion is confirmed.
- No-suggestion upload review explains that the file can still be added.
- Provider radio keys work with arrows and expose selection semantically.

## Evidence

Screenshots: `/tmp/allteam-800-mcp-servers-deep.png`, `/tmp/allteam-800-dark-mcp-servers-deep.png`, `/tmp/allteam-800-mcp-connections-deep.png`, `/tmp/allteam-1440-task-details.png`, `/tmp/allteam-1440-upload-ready.png`. Relevant code: `SettingsPage.tsx:262`, `settings.css:47`, `TasksPanel.tsx:66`, `SmartIntakeDialog.tsx:31`.
