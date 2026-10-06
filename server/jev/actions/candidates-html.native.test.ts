import { describe, expect, it } from 'vitest';
import type { JevEvaluationContext, JevInputDocument } from './context.js';
import { neighbors } from './candidates.js';

function source(id: string, title: string, content: string): JevInputDocument {
  return { canvasId: 'canvas', snapshot: { workspaceId: 'workspace', canvasId: 'canvas', blockId: id,
    incarnation: id, sourceGeneration: 1, metadataRevision: 1, contentHash: id },
  block: { id, title, content, file: `${id}.html`, kind: 'markdown', x: 0, y: 0, width: 1, height: 1, links: [] } };
}

describe('HTML knowledge candidate retrieval', () => {
  it.each(['frontmatter', 'plain HTML'])('ranks visible knowledge above shared page templates for %s', format => {
    const css = Array.from({ length: 80 }, (_, index) => `--decorative-token-${index}: ${index}px;`).join('\n');
    const html = (body: string) => `${format === 'frontmatter' ? '---\nformat: html\n---\n' : ''}<html><head><style>${css}</style></head><body>${body}</body></html>`;
    const origin = source('origin', 'Architecture', html('<h1>Architecture</h1><p>Revision history stores document snapshots in Git.</p>'));
    const unrelated = source('unrelated', 'Brand', html('<h1>Brand</h1><p>Colors and typography express our visual identity.</p>'));
    const related = source('related', 'Storage', 'Revision history stores document snapshots in Git.');
    const input = { workspaceId: 'workspace', documents: [origin, unrelated, related] } as JevEvaluationContext;
    expect(neighbors(input, origin, 1).map(document => document.block.id)).toEqual(['related']);
  });
});
