// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { CanvasBlock, CanvasDocument } from '../shared/types';
import type { AppModel } from './App';
import { FullPageReader } from './AppDialogs';

vi.mock('./Loaders', async () => {
  const React = await import('react');
  return { BlockContent: ({ block }: { block: CanvasBlock }) => React.createElement('div', {}, block.content) };
});

function block(crossLinks: CanvasBlock['crossLinks'] = []): CanvasBlock {
  return { id: 'rate-limits', title: 'API rate limits', content: '# Rate limits', file: 'docs/rate-limits.md',
    kind: 'markdown', x: 0, y: 0, width: 400, height: 320, links: [], crossLinks };
}

function modelFor(document: CanvasBlock, labels: Record<string, string> = {}) {
  const canvas: CanvasDocument = { id: 'api', name: 'API', workspaceId: 'team', blocks: [document] };
  const openCrossLink = vi.fn();
  const model = { canvas, canvasId: canvas.id, readerId: document.id, crossLinkLabels: labels,
    openCrossLink, closeReader: vi.fn(), showReaderDocument: vi.fn(), openVersionHistory: vi.fn(),
    openBlock: vi.fn(), updateBlock: vi.fn(), setError: vi.fn() } as unknown as AppModel;
  return { model, openCrossLink };
}

afterEach(cleanup);

describe('full-page reader cross-canvas links', () => {
  it('lists related documents with resolved labels and opens the selected target', () => {
    const { model, openCrossLink } = modelFor(block([
      { canvasId: 'billing', blockId: 'client', relation: 'implements' },
      { canvasId: 'operations', blockId: 'runbook', relation: 'prerequisite' },
    ]), { 'billing:client': 'Billing · Billing client', 'operations:runbook': 'Operations · Retry runbook' });
    render(<FullPageReader model={model}/>);
    const related = screen.getByRole('complementary', { name: 'Related on other canvases' });
    expect(within(related).getByText('implements')).toBeTruthy();
    fireEvent.click(within(related).getByRole('button', { name: 'Open Billing · Billing client' }));
    expect(openCrossLink).toHaveBeenCalledWith('billing', 'client');
    expect(within(related).getByRole('button', { name: 'Open Operations · Retry runbook' })).toBeTruthy();
  });

  it('omits the related section when the document has no cross links', () => {
    const { model } = modelFor(block());
    render(<FullPageReader model={model}/>);
    expect(screen.queryByRole('complementary', { name: 'Related on other canvases' })).toBeNull();
  });
});
