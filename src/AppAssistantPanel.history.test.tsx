// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CanvasStore } from '../server/storage';
import type { CanvasBlock, CanvasDocument } from '../shared/types';
import type { DisplayTurn } from './chat-types';
import { assistantFixture, installAssistantBrowser, jsonBody, turn } from './AppAssistantPanel.test.helpers';
import { chatHistoryKey } from './chat-history';

installAssistantBrowser();
function history(turn: Partial<DisplayTurn>) {
  localStorage.setItem(chatHistoryKey, JSON.stringify([{ id: 1, role: 'assistant', content: 'Saved chat changes', activities: [], ...turn }]));
}
describe('Assistant restored history through the real App and persisted canvas', () => {
  it.each([false, true])('reveals a saved created block with an explicit canvas target %s', async explicit => {
    let created!: CanvasBlock;
    await assistantFixture(undefined, false, async request => {
      created = await request('/api/canvases/product-roadmap/blocks', jsonBody({ title: 'Saved chat document', content: '# Saved chat document\nDurable content.' })).then(response => response.json()) as CanvasBlock;
      history({ createdBlocks: [created], ...(explicit ? { createdCanvasId: 'product-roadmap' } : {}) });
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Show Saved chat document on canvas' }));
    await waitFor(() => {
      const node = document.querySelector(`[data-id="${created.id}"]`);
      expect(node?.getAttribute('class')).toContain('selected');
      expect(node?.textContent).toContain('Saved chat document');
    });
  });

  it('opens an updated document and restores its saved edit through Undo', async () => {
    let before!: CanvasBlock;
    let undoWrite: Promise<Response> | undefined;
    let undoRefresh: Promise<Response> | undefined;
    const fixture = await assistantFixture((route, init, forward) => {
      const response = forward();
      if (route === '/api/canvases/product-roadmap/jev/undo-parent' && init.method === 'POST') undoWrite = response.then(value => value.clone());
      if (route === '/api/canvases/product-roadmap' && undoWrite) undoRefresh = response.then(value => value.clone());
      return response;
    }, false, async request => {
      const document = await request('/api/canvases/product-roadmap').then(response => response.json()) as CanvasDocument;
      before = document.blocks[0];
      const after = await request('/api/canvases/product-roadmap/blocks/' + before.id, { ...jsonBody({ content: '# Reviewed evidence\nUpdated source.' }), method: 'PUT' }).then(response => response.json()) as CanvasBlock;
      history({ editedBlocks: [{ before, after }], createdCanvasId: 'product-roadmap' });
    });
    fireEvent.click(await screen.findByText('Review changes to ' + before.title));
    fireEvent.click(screen.getByRole('button', { name: 'Open updated document' }));
    await waitFor(() => expect(document.querySelector(`[data-id="${before.id}"]`)?.getAttribute('class')).toContain('selected'));
    const card = document.querySelector(`[data-id="${before.id}"] .canvas-card`);
    expect(card).toBeTruthy();
    await within(card as HTMLElement).findByText('Updated source.');
    fireEvent.click(screen.getByRole('button', { name: 'Undo edit' }));
    await waitFor(() => expect(undoWrite).toBeDefined());
    await act(async () => {
      const response = await undoWrite!;
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ id: before.id, content: before.content, contentHash: before.contentHash });
    });
    await waitFor(() => expect(undoRefresh).toBeDefined());
    await act(async () => {
      const response = await undoRefresh!;
      expect(response.status).toBe(200);
      const document = await response.json() as CanvasDocument;
      expect(document.blocks.find(block => block.id === before.id)).toMatchObject({ content: '', contentLoaded: false, title: before.title });
    });
    await screen.findByText('Undid edit to ' + before.title + '.');
    const restarted = new CanvasStore(fixture.root); await restarted.init();
    expect((await restarted.getCanvas('product-roadmap')).blocks.find(block => block.id === before.id))
      .toMatchObject({ content: before.content, contentHash: before.contentHash });
    expect((await fixture.read('product-roadmap')).blocks.find(block => block.id === before.id))
      .toMatchObject({ content: before.content, contentHash: before.contentHash });
  });

  it('opens research from the header and the saved research turn, and keeps assistant panes across navigation', async () => {
    const taskRequests: string[] = [];
    let linkedId = '';
    const fixture = await assistantFixture(async (route, _init, forward) => { if (/\/tasks(?:\/|$)/.test(route)) taskRequests.push(route); return forward(); }, true,
      async request => {
        history({ researchPatch: turn.patch });
        const canvas = await request('/api/canvases/product-roadmap').then(response => response.json()) as CanvasDocument;
        linkedId = canvas.blocks[0].id;
        expect((await request('/api/canvases/product-roadmap/tasks', jsonBody({ title: 'Existing release work', blockIds: [linkedId] }))).status).toBe(201);
      });
    fireEvent.click(screen.getByRole('button', { name: 'Open research canvas' }));
    const research = await screen.findByRole('region', { name: 'Research canvas' });
    expect(within(research).getByRole('heading', { name: 'Release evidence' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Return to main canvas' }));
    expect(screen.queryByRole('region', { name: 'Research canvas' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Open research canvas ·/ }));
    await screen.findByRole('region', { name: 'Research canvas' });
    fireEvent.click(screen.getByRole('button', { name: 'Return to main canvas' }));
    expect(within(screen.getByRole('tablist', { name: 'Assistant views' })).getAllByRole('tab').map(tab => tab.textContent)).toEqual(['Chat', 'Symbi Reflex']);
    expect(screen.queryByRole('tab', { name: 'Tasks' })).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: 'Message Symbi' }), { target: { value: 'Continue this research' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Symbi Reflex' }));
    await screen.findByRole('spinbutton', { name: 'Understand documents confidence threshold' });
    expect(within(screen.getByRole('region', { name: 'Automatic action thresholds' })).getAllByRole('spinbutton')).toHaveLength(6);
    expect(screen.queryByRole('textbox', { name: 'New task' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Chat' }));
    expect((screen.getByRole('textbox', { name: 'Message Symbi' }) as HTMLTextAreaElement).value).toBe('Continue this research');
    fireEvent.click(screen.getByRole('button', { name: 'Close Symbi panel' }));
    expect(screen.queryByRole('complementary', { name: 'Symbi assistant' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Toggle Symbi' }));
    expect(screen.getByRole('textbox', { name: 'Message Symbi' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Symbi settings' }));
    await screen.findByRole('dialog');
    expect(screen.getByRole('button', { name: 'Save settings' })).toBeTruthy();
    expect(taskRequests).toEqual([]);
    expect(await fixture.request('/api/canvases/product-roadmap/tasks').then(response => response.json())).toEqual([
      expect.objectContaining({ title: 'Existing release work', blockIds: [linkedId] }),
    ]);
  });
});
