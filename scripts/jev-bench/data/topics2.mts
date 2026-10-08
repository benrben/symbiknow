import { topics as easy } from './topics.mts';
// Hard negatives: the doc mentions the topic 1-3 times, but it is not a subject of the doc.
export const hard: Array<[string, string, boolean]> = [
  ['data-model', 'Rollback', false], ['safe-collaboration', 'Rollback', false], ['safe-collaboration', 'Mermaid diagrams', false],
  ['testing', 'Dark mode', false], ['testing', 'Zoom levels', false], ['chat-internals', 'Zoom levels', false], ['chat-internals', 'Rate limiting', false],
  ['errors', 'Embedding model', false], ['sdk-and-webmcp', 'Rollback', false], ['history', 'Keyboard shortcuts', false],
  ['security-and-access', 'File uploads', false], ['security-and-access', 'Git version history', false], ['brand-and-ui', 'File uploads', false],
  ['brand-and-ui', 'Mermaid diagrams', false], ['canvas-ui', 'Server-sent events', false], ['document-operations', 'Caching', false],
  ['operations', 'Playwright browser tests', false],
];
export const all = [...easy, ...hard];
export const byDoc = () => { const m = new Map<string, Array<{ topic: string; truth: boolean; hard: boolean }>>();
  for (const [doc, topic, truth] of all) m.set(doc, [...(m.get(doc) ?? []), { topic, truth, hard: hard.some((h) => h[0] === doc && h[1] === topic) }]); return m; };
