import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SymbiDocumentProgress } from '../shared/symbi-contract';
import type { CanvasDocument } from '../shared/types';
import { JevDocumentProgress } from './JevDocumentProgress';

const canvas = { id: 'canvas', blocks: [{ id: 'source', title: 'Source document' }] } as CanvasDocument;
const result: SymbiDocumentProgress = {
  version: 1, jobId: 'job-1', canvasId: 'canvas', blockId: 'source', contentHash: 'hash-1', durable: false,
  updatedAt: '2026-10-06T00:00:00.000Z', actions: [
    { action: 'profile', state: 'changed' },
    { action: 'label', state: 'no_change', reason: 'No supported label' },
    { action: 'link', state: 'failed', reason: 'Timed out' },
    { action: 'flag_duplicate', state: 'waiting' },
    { action: 'file', state: 'waiting' },
    { action: 'suggest_home_canvas', state: 'waiting' },
  ],
};

describe('shared document progress in the UI', () => {
  it('shows each current action and withholds completion until the checkpoint is durable', () => {
    const pending = renderToStaticMarkup(<JevDocumentProgress canvas={canvas} documents={[result]}/>);
    expect(pending).toContain('3 of 6 checks finished');
    expect(pending).toContain('No supported label');
    expect(pending).toContain('Timed out');
    expect(pending).not.toContain('Complete and saved');
    const durable = renderToStaticMarkup(<JevDocumentProgress canvas={canvas} documents={[{ ...result, durable: true }]}/>);
    expect(durable).toContain('Complete and saved');
  });

  it('only displays documents still present in the selected canvas', () => {
    const html = renderToStaticMarkup(<JevDocumentProgress canvas={canvas} documents={[
      { ...result, canvasId: 'other' }, { ...result, blockId: 'deleted' }, result,
    ]}/>);
    expect(html.match(/Source document/g)).toHaveLength(1);
  });
});
