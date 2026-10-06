import type { AnswerCanvasResult } from '../shared/answer-canvas.js';
import { profileText, viewDescription } from './chat-input.js';
import type { AgentConfiguration, PreparedRequest } from './chat-stream-types.js';

function outsideStatus(toolCount: number): string {
  return toolCount ? ' Tools whose names start with an MCP server ID come from outside MCP servers the user connected.' : '';
}

export function chatPrompt(request: PreparedRequest, config: AgentConfiguration,
  answerCanvas: AnswerCanvasResult | null, externalToolCount: number, canvasEnabled: boolean): string {
  const { canvasId, activeCanvas, currentView } = request;
  const { settings } = config;
  const selectedSources = answerCanvas?.sources.map(source => ({ canvasId: source.canvasId,
    blockId: source.blockId, title: source.title, canvasName: source.canvasName })) ?? [];
  const presentationInstruction = canvasEnabled
    ? 'Build the answer on the separate session research canvas. Use draw_research_canvas to create distinct blocks for actual findings, evidence groups, components, phases, or diagrams. Each block can use the same loader as a normal canvas document: Markdown with images, Mermaid diagrams, tables, tasks, and video links; a complete HTML page (kind html); Marp slides; restricted MDX Chart or Calculator components; or a website source for an existing documentation folder. Pick the format that makes each piece clearest; do not turn everything into prose. Use only image URLs supported by a source or provided by the user. Give every block a clear purpose and connect blocks with edges that state a real relationship such as causes, depends on, supports, or precedes. Choose a layout that matches those relationships. Cite selected source IDs only in blocks they support. Do not add generic summary or next-action blocks just to fill a template. If the drawing tool is unavailable, write distinct Markdown headings for distinct findings so the answer can still become multiple blocks. Keep the chat reply brief; the canvas carries the answer.'
    : 'Answer directly in chat. This request does not need a research canvas. Use the current view and selected sources as context. Navigate to a document or group when the user asks to see it.';
  const draftInstruction = currentView.editorDraft
    ? 'The editor contains an unsaved draft. Review that draft when the user asks about their current text. Propose changes in chat. Do not claim you saved the draft or edit the open document until the user saves or discards it.' : '';
  return `${profileText(settings)}\n${settings.systemPrompt}\n\nThe active canvas ID is ${canvasId}. The user's current view at the moment of this request is ${viewDescription(activeCanvas, currentView)}. Treat this view as context for phrases like "this document", "here", and "what I am looking at". ${draftInstruction} Follow the user's full request.${outsideStatus(externalToolCount)} Local retrieval selected these potentially relevant documents for citation: ${JSON.stringify(selectedSources.map(source => ({ ...source, sourceId: `${source.canvasId}:${source.blockId}` })))}. Relevance is not proof: read the selected documents with read_doc (pass sourceCanvasId for another canvas), check their actual contents, and name the source documents that support the answer. Search for more when the selected sources are insufficient. ${presentationInstruction} When the user asks to open or see a specific document or group, use show_doc_on_canvas or show_group_on_canvas so the app navigates there. Document write tools only prepare a proposal; they do not save changes. Tell the user to review and apply the proposal. Send document deletion to the document UI, where it can be handled safely. Use the supplied canvas tools to inspect user-visible Markdown blocks. For questions about canvas documents, use canvas tools, not the Deep Agents scratch filesystem. Avoid repeating the same tool call once its result is known; answer when you have enough evidence. Deep Agents filesystem tools are scratch space for planning and context; they do not write canvas documents. Report changes accurately in ordinary Markdown: use short headings, lists, and tables where they help, and name the documents you used.`;
}

