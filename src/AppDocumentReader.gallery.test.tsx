// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { CanvasBlock, CanvasDocument } from '../shared/types';
import type { AppDialogModel } from './app-dialog-contract';
import { FullPageReader } from './AppDocumentReader';

vi.mock('./useDocumentContent', () => ({ useDocumentContent: (block: CanvasBlock) => ({ block, retry: vi.fn() }) }));
vi.mock('./JevDocumentReview', () => ({ JevDocumentReview: () => null }));

afterEach(cleanup);

function model(block: CanvasBlock): AppDialogModel {
  const canvas: CanvasDocument = { id: 'guide', workspaceId: 'team', name: 'Guides', blocks: [block] };
  return { canvas, canvasId: canvas.id, readerId: block.id, showChat: false, closeReader: vi.fn(),
    showReaderDocument: vi.fn(), openVersionHistory: vi.fn(), openBlock: vi.fn(),
    updateBlock: vi.fn(), setError: vi.fn() } as unknown as AppDialogModel;
}

it('suppresses only a matching leading Markdown H1 in reader presentation while retaining source', () => {
  const block: CanvasBlock = { id: 'intro', title: 'Release guide', kind: 'markdown', file: 'intro.md',
    content: '---\ncategory: release\n---\n# Release guide\n\nRead the checklist.',
    x: 0, y: 0, width: 400, height: 300, links: [] };
  const view = render(<FullPageReader model={model(block)}/>);
  expect(view.container.querySelector('.page-reader__document > h1')?.textContent).toBe('Release guide');
  expect(view.container.querySelector('.page-reader__content--duplicate-title .loader-markdown > h1')?.textContent).toBe('Release guide');
  expect(block.content).toBe('---\ncategory: release\n---\n# Release guide\n\nRead the checklist.');
  view.rerender(<FullPageReader model={model({ ...block, title: 'Atlas: Release guide' })}/>);
  expect(view.container.querySelector('.page-reader__content--duplicate-title .loader-markdown > h1')?.textContent).toBe('Release guide');
  view.rerender(<FullPageReader model={model({ ...block, content: '# Different heading\n\nRead the checklist.' })}/>);
  expect(view.container.querySelector('.page-reader__content--duplicate-title')).toBeNull();
  view.rerender(<FullPageReader model={model({ ...block, content: 'Read the checklist without a heading.' })}/>);
  expect(view.container.querySelector('.page-reader__content--duplicate-title')).toBeNull();
  view.rerender(<FullPageReader model={model({ ...block, kind: 'slides' })}/>);
  expect(view.container.querySelector('.page-reader__content--duplicate-title')).toBeNull();
});
