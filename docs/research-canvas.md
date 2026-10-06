# Research canvas

SymbiKnow can turn a research question into a connected, editable canvas. It stays open for the current chat session, so follow-up questions can extend the same map. The ordinary workspace canvas remains available, and you can return to the research map from the assistant header.

## Start with a question

1. Open a canvas and connect a chat model in **Settings → Models**.
2. Ask a question that benefits from several linked findings, such as “Map the architecture and show how the API, MCP server, and document store connect.” You can explicitly ask for a **temporary research canvas**.
3. Local retrieval selects relevant documents. While the agent works, the research canvas shows the selected evidence. The agent can draw several answer blocks and meaningful edges; each block cites the documents that support it.

Quick facts and status questions usually get a direct chat answer. If the request could mean drawing a map, answering from the current view, or finding the right source, the assistant asks you to choose. **Answer briefly in chat** and **Turn this into a map** are also available after a response. Source selection helps the agent choose what to read; it does not prove a claim by itself.

## Work with the map

- Ask another question to extend the same session graph. Earlier answer blocks remain in place. The **Research path** and **Read this answer** controls help you revisit a question or step.
- Use **View & export → Layout** to switch between **Roadmap**, **Kanban**, **Architecture**, and **Mind map**. Pan, zoom, search, select, open, move, group, connect, edit, add, upload, and delete blocks with the same canvas controls used elsewhere in SymbiKnow. Manual changes can be undone from **Undo** or **Session history**.
- Use Markdown, images, Mermaid diagrams, tables, task lists, HTML pages, Marp slides, or supported MDX components inside blocks. Source citations appear inside the answer blocks and link back to the original documents.
- The assistant receives the visible group or blocks, selected document, search, and zoom focus with each request. The **Using** control in chat lets you switch to **Whole canvas**, **Selected documents**, or **Research canvas**. Suggested follow-up questions change with your view and selection.
- If the agent opens a source or group, use the chat return action to go back. **Research canvas** in the assistant header opens the session map after navigating to another canvas. A changed cited document prompts you to recheck the research.

## Keep the work

**Save canvas** creates a regular canvas in the workspace with the current answer blocks, connections, and links back to available cited documents. You can open that saved canvas from the confirmation and continue editing it like any other canvas. Saving again creates a new copy. **View & export → Export Markdown** downloads the current research as `research-canvas.md`.

Unsaved research lives in the current page session. **New chat** or a page reload clears it, so save or export before leaving the page. Session edits do not change source documents unless you separately edit those documents on the main canvas.

For integrators, the [API contract](../API.md#session-research-canvas-events) describes the streaming events and source references.
