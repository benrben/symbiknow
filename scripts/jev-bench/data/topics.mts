// Topic answer key on real atlas docs: [doc, topic, true = a main subject of the doc].
export const topics: Array<[string, string, boolean]> = [
  ['brand-and-ui', 'Color tokens', true], ['brand-and-ui', 'Typography', true], ['brand-and-ui', 'HTTP status codes', false], ['brand-and-ui', 'Deployment', false],
  ['errors', 'HTTP status codes', true], ['errors', 'Error handling', true], ['errors', 'Brand colors', false], ['errors', 'Typography', false],
  ['testing', 'Continuous integration', true], ['testing', 'Automated testing', true], ['testing', 'Color tokens', false], ['testing', 'Pricing', false],
  ['security-and-access', 'Access tokens', true], ['security-and-access', 'Secrets management', true], ['security-and-access', 'Zoom levels', false], ['security-and-access', 'Avatar animation', false],
  ['canvas-ui', 'Canvas navigation', true], ['canvas-ui', 'Zoom levels', true], ['canvas-ui', 'Access tokens', false], ['canvas-ui', 'Continuous integration', false],
  ['chat-internals', 'Chat assistant', true], ['chat-internals', 'Streaming responses', true], ['chat-internals', 'Typography', false], ['chat-internals', 'Color tokens', false],
  ['data-model', 'Data storage', true], ['data-model', 'Chat streaming', false], ['data-model', 'Avatar animation', false],
  ['document-operations', 'Document import', true], ['document-operations', 'Git version history', true], ['document-operations', 'Rate limiting', false], ['document-operations', 'Brand colors', false],
  ['safe-collaboration', 'Concurrent editing', true], ['safe-collaboration', 'Brand colors', false], ['safe-collaboration', 'Search ranking', false],
  ['operations', 'Self-hosting', true], ['operations', 'Local development setup', true], ['operations', 'Avatar animation', false], ['operations', 'Brand colors', false],
  ['sdk-and-webmcp', 'SDK', true], ['sdk-and-webmcp', 'Canvas zoom', false], ['sdk-and-webmcp', 'Typography', false],
  ['history', 'Project history', true], ['history', 'Color tokens', false], ['history', 'Zoom levels', false],
  ['plan-status', 'Project roadmap', true], ['plan-status', 'Typography', false], ['plan-status', 'Brand colors', false],
];
export const byDoc = () => { const m = new Map<string, Array<{ topic: string; truth: boolean }>>();
  for (const [doc, topic, truth] of topics) m.set(doc, [...(m.get(doc) ?? []), { topic, truth }]); return m; };
