import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFile } from 'node:fs/promises';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { createApiServer } from '../server/index.js';
import type { DeepAgentFactory } from '../server/chat-agent.js';
import type { CanvasBlock, SearchHit } from '../shared/types.js';
import type { ResearchCanvasPatch } from '../shared/answer-canvas.js';
import { auditedReflexProvider } from './acceptance-provider-audit.js';

type ResearchBlock = ResearchCanvasPatch['blocks'][number];

function requiredTool(tools: StructuredToolInterface[], name: string): StructuredToolInterface {
  const selected = tools.find(item => item.name === name);
  if (!selected) throw new Error(`Acceptance chat did not expose ${name}`);
  return selected;
}

async function evidence(tools: StructuredToolInterface[], signal: AbortSignal) {
  const search = requiredTool(tools, 'search_docs');
  const hits = JSON.parse(String(await search.invoke({ query: 'Launch evidence' }, { signal }))) as SearchHit[];
  const hit = hits.find(item => item.title === 'Launch evidence');
  if (!hit) throw new Error('Acceptance research needs a saved Launch evidence document');
  const document = JSON.parse(String(await requiredTool(tools, 'read_doc').invoke({
    blockId: hit.blockId, sourceCanvasId: hit.canvasId,
  }, { signal }))) as CanvasBlock;
  return { sourceId: `${hit.canvasId}:${document.id}`, document };
}

function researchBlocks(number: number, sourceId: string): ResearchBlock[] {
  return [
    { id: 'summary', type: 'text', title: `Finding ${number}`, content: `Answer ${number}.`, sourceIds: [sourceId] },
    { id: 'flow', type: 'diagram', title: `Launch flow ${number}`,
      content: '```mermaid\nflowchart LR\nEvidence-->Decision\n```', sourceIds: [sourceId] },
    { id: 'next', type: 'task', title: `Next action ${number}`,
      content: '- [ ] Review the failing tests', sourceIds: [] },
  ];
}

function richBlocks(sourceId: string): ResearchBlock[] {
  return [
    { id: 'image', type: 'text', kind: 'markdown', title: 'Visual evidence',
      content: '![Launch status](/symbiknow-favicon.svg)', sourceIds: [sourceId] },
    { id: 'html', type: 'section', kind: 'html', title: 'HTML report',
      content: '<!doctype html><html><body><h1>Rendered report</h1></body></html>', sourceIds: [sourceId] },
    { id: 'diagram', type: 'diagram', kind: 'markdown', title: 'System flow',
      content: '```mermaid\nflowchart LR\nEvidence-->Decision\n```', sourceIds: [] },
    { id: 'slides', type: 'section', kind: 'slides', title: 'Briefing slides',
      content: '---\nmarp: true\n---\n# Release briefing', sourceIds: [] },
    { id: 'chart', type: 'diagram', kind: 'mdx', title: 'Health chart',
      content: '<Chart title="Release health" values="2,4,6" />', sourceIds: [] },
    { id: 'site', type: 'section', kind: 'website', title: 'Documentation site',
      content: '---\ngenerator: mkdocs\nsource: sites/team-docs\n---\n# Team docs', sourceIds: [] },
  ];
}

function answerNumber(messages: BaseMessage[]): number {
  return messages.filter(message => message instanceof AIMessage && /^Answer \d+\.$/u.test(String(message.content))).length + 1;
}

async function draw(tools: StructuredToolInterface[], messages: BaseMessage[], latest: string, signal: AbortSignal) {
  const source = await evidence(tools, signal);
  const number = answerNumber(messages);
  const rich = latest === 'Show me every format on a temporary research canvas';
  const blocks = rich ? richBlocks(source.sourceId) : researchBlocks(number, source.sourceId);
  const patch: ResearchCanvasPatch = { query: latest, layout: rich ? 'roadmap' : 'architecture', blocks,
    edges: rich ? [] : [{ from: 'summary', to: 'flow', label: 'explains' }, { from: 'flow', to: 'next', label: 'leads to' }] };
  const result = JSON.parse(String(await requiredTool(tools, 'draw_research_canvas').invoke(patch, { signal })));
  return { answer: rich ? 'I mapped each format.' : `Answer ${number}.`, sourceId: source.sourceId,
    sourceTitle: source.document.title, drawResult: result };
}

export function acceptanceAgent(dataDir: string): DeepAgentFactory {
  return (_settings, tools) => async function* (messages, signal) {
    const latest = String(messages.at(-1)?.content ?? '');
    await appendFile(path.join(dataDir, 'chat-requests.jsonl'), JSON.stringify({ latest, tools: tools.map(item => item.name) }) + '\n');
    if (tools.some(item => item.name === 'draw_research_canvas')) {
      const research = await draw(tools, messages, latest, signal);
      await appendFile(path.join(dataDir, 'chat-research.jsonl'), JSON.stringify(research) + '\n');
      yield { messages: [...messages, new AIMessage(research.answer)] };
      return;
    }
    const answer = latest === 'yes'
      ? 'Chat cannot delete Temporary Note directly. Open the document and use Delete in its editor, then confirm the deletion there.'
      : latest === 'Which tests failed?' ? 'The mobile release has two failing tests.' : 'Ready.';
    yield { messages: [...messages, new AIMessage(answer)] };
  };
}

async function start(): Promise<void> {
  const port = Number(process.env.PORT);
  const dataDir = process.env.DATA_DIR;
  if (!Number.isInteger(port) || !dataDir) throw new Error('Acceptance server needs PORT and DATA_DIR');
  const server = await createApiServer({ dataDir, fetcher: auditedReflexProvider(dataDir), agentFactory: acceptanceAgent(dataDir) });
  server.listen(port, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Acceptance server did not bind a TCP port');
    console.log(`SymbiKnow acceptance server listening on ${address.port}`);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await start();
