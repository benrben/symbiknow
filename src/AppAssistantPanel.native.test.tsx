// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { assistantFixture, completedResearchSave, confirmNewChat, heldSave, installAssistantBrowser, storedResearch, turn } from './AppAssistantPanel.test.helpers';

installAssistantBrowser();
describe('New chat confirmation through the real App and canvas API', () => {
  it('cycles both focus boundaries, restores the opener, and distinguishes inner clicks from the backdrop', async () => {
    const user = userEvent.setup();
    await assistantFixture();
    const trigger = screen.getByRole('button', { name: 'New chat' });
    const dialog = await confirmNewChat();
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Keep working' }));
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Discard and start' }));
    await user.tab();
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Keep working' }));
    await user.tab();
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Save research and start' }));
    fireEvent.keyDown(dialog, { key: 'ArrowRight' });
    fireEvent.mouseDown(dialog);
    expect(screen.getByRole('alertdialog')).toBe(dialog);
    expect(screen.getByRole('button', { name: 'New workspace', hidden: true }).closest('[inert]')).toBeTruthy();
    fireEvent.mouseDown(dialog.parentElement!);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(trigger.closest('[inert]')).toBeNull();
    await confirmNewChat();
    fireEvent.click(screen.getByRole('button', { name: 'Keep working' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(storedResearch().turns).toEqual([turn]);
  });

  it('saves through HTTP and clears the conversation only for the current confirmation', async () => {
    const fixture = await assistantFixture();
    await confirmNewChat();
    fireEvent.click(screen.getByRole('button', { name: 'Save research and start' }));
    const saved = await completedResearchSave(fixture);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await waitFor(() => expect(storedResearch()?.turns).toEqual([]));
    const persisted = await fixture.read(saved.id);
    expect(persisted.blocks[0]).toMatchObject({ title: 'Release review', kind: 'markdown' });
    expect(persisted.blocks[0].content).toContain('Review before release.');
    fireEvent.click(screen.getByRole('button', { name: 'Open canvas: ' + saved.name }));
    await screen.findByRole('heading', { name: saved.name });
    fixture.unmount();
    const { CanvasStore } = await import('../server/storage');
    const restarted = new CanvasStore(fixture.root);
    await restarted.init();
    expect(await restarted.getCanvas(saved.id)).toEqual(persisted);
  });

  it('recovers from a failed save without clearing the research or closing the dialog', async () => {
    let unavailable = true;
    const fixture = await assistantFixture((route, init, forward) => unavailable && init.method === 'POST' && /\/workspaces\/[^/]+\/canvases$/.test(route)
      ? Promise.resolve(Response.json({ error: 'Save temporarily unavailable' }, { status: 503 })) : forward());
    const before = await fixture.documents();
    await confirmNewChat();
    fireEvent.click(screen.getByRole('button', { name: 'Save research and start' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toBe('Save temporarily unavailable');
    expect(storedResearch().turns).toEqual([turn]);
    expect(await fixture.documents()).toEqual(before);
    unavailable = false;
    fireEvent.click(screen.getByRole('button', { name: 'Save research and start' }));
    // Observe persisted content and refreshed navigation before expecting the
    // current confirmation to close after the complete native save.
    await completedResearchSave(fixture);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(screen.queryByRole('alert')).toBeNull();
    await waitFor(() => expect(storedResearch()?.turns).toEqual([]));
  });

  it('does not put an earlier save failure in a reopened confirmation', async () => {
    const pending = heldSave();
    await assistantFixture(pending.network);
    const earlier = await confirmNewChat();
    fireEvent.click(screen.getByRole('button', { name: 'Save research and start' }));
    await waitFor(() => expect(pending.count).toBe(1));
    fireEvent.keyDown(earlier, { key: 'Escape' });
    const newer = await confirmNewChat();
    await pending.release(0, Response.json({ error: 'Earlier save failed' }, { status: 503 }));
    expect(screen.getByRole('alertdialog')).toBe(newer);
    expect(screen.queryByRole('alert')).toBeNull();
    expect((within(newer).getByRole('button', { name: 'Save research and start' }) as HTMLButtonElement).disabled).toBe(false);
    expect(storedResearch().turns).toEqual([turn]);
  });

  it('keeps a later save pending when an earlier save completes', async () => {
    const pending = heldSave();
    const fixture = await assistantFixture(pending.network);
    const earlier = await confirmNewChat();
    fireEvent.click(screen.getByRole('button', { name: 'Save research and start' }));
    await waitFor(() => expect(pending.count).toBe(1));
    fireEvent.keyDown(earlier, { key: 'Escape' });
    const newer = await confirmNewChat();
    fireEvent.click(screen.getByRole('button', { name: 'Save research and start' }));
    await waitFor(() => expect(pending.count).toBe(2));
    await pending.release(0);
    await completedResearchSave(fixture);
    expect(screen.getByRole('alertdialog')).toBe(newer);
    expect((within(newer).getByRole('button', { name: 'Saving…' }) as HTMLButtonElement).disabled).toBe(true);
    expect(storedResearch().turns).toEqual([turn]);
    await pending.release(1, Response.json({ error: 'Current save failed' }, { status: 503 }));
    await screen.findByText('Current save failed');
    expect((within(newer).getByRole('button', { name: 'Save research and start' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('does not reset the newer chat after an earlier authorized save finishes', async () => {
    const pending = heldSave();
    const fixture = await assistantFixture(pending.network);
    const earlier = await confirmNewChat();
    fireEvent.click(screen.getByRole('button', { name: 'Save research and start' }));
    await waitFor(() => expect(pending.count).toBe(1));
    fireEvent.keyDown(earlier, { key: 'Escape' });
    await confirmNewChat();
    fireEvent.click(screen.getByRole('button', { name: 'Discard and start' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Message Symbi' }), { target: { value: 'A later chat draft' } });
    await pending.release();
    await completedResearchSave(fixture);
    expect((screen.getByRole('textbox', { name: 'Message Symbi' }) as HTMLTextAreaElement).value).toBe('A later chat draft');
    expect(storedResearch().turns).toEqual([]);
  });

  it('allows New chat immediately for an empty conversation and confirms history without a research-save option', async () => {
    const fixture = await assistantFixture(undefined, false);
    fireEvent.change(screen.getByRole('textbox', { name: 'Message Symbi' }), { target: { value: 'Unsaved input' } });
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(storedResearch().turns).toEqual([]);
    expect((screen.getByRole('textbox', { name: 'Message Symbi' }) as HTMLTextAreaElement).value).toBe('Unsaved input');
    // Restoring a saved investigation is the public way to load conversation-only history.
    const canvas = await fixture.read('product-roadmap');
    const response = await fixture.request('/api/investigations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      title: 'Conversation only', workspaceId: canvas.workspaceId, canvasId: canvas.id, visibility: 'shared',
      messages: [{ role: 'user', content: 'Saved question' }, { role: 'assistant', content: 'Saved answer' }], sourceRefs: [], proposalRefs: [],
    }) });
    expect(response.status).toBe(201);
    fireEvent.click(screen.getByText(/Saved investigations/));
    await screen.findByRole('textbox', { name: 'Investigation name' });
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
    await screen.findByText('Saved answer');
    await confirmNewChat();
    expect(screen.queryByRole('button', { name: 'Save research and start' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Discard and start' }));
    expect(screen.queryByText('Saved answer')).toBeNull();
    expect(await fixture.request('/api/investigations/list', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspaceId: canvas.workspaceId }) }).then(response => response.json())).toMatchObject({ investigations: [expect.objectContaining({ title: 'Conversation only' })] });
  });
  it('keeps keyboard focus in the confirmation while all save controls are disabled', async () => {
    const user = userEvent.setup();
    const pending = heldSave();
    const fixture = await assistantFixture(pending.network);
    const dialog = await confirmNewChat();
    await user.click(screen.getByRole('button', { name: 'Save research and start' }));
    await waitFor(() => expect(pending.count).toBe(1));
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await pending.release();
    await completedResearchSave(fixture);
  });
  it('keeps current research and the newer draft when Escape closes a held save', async () => {
    const pending = heldSave();
    const fixture = await assistantFixture(pending.network);
    const before = await fixture.documents();
    const dialog = await confirmNewChat();
    fireEvent.click(screen.getByRole('button', { name: 'Save research and start' }));
    await waitFor(() => expect(pending.count).toBe(1));
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: 'Message Symbi' }), { target: { value: 'Keep working with the current research' } });
    await pending.release();
    const saved = await completedResearchSave(fixture);
    expect((await fixture.read(saved.id)).blocks[0].title).toBe('Release review');
    expect((await fixture.documents()).flatMap(workspace => workspace.canvases)).toHaveLength(before.flatMap(workspace => workspace.canvases).length + 1);
    await waitFor(() => expect(screen.getByRole('button', { name: 'New chat' }).hasAttribute('disabled')).toBe(false));
    expect(storedResearch().turns).toEqual([turn]);
    expect((screen.getByRole('textbox', { name: 'Message Symbi' }) as HTMLTextAreaElement).value).toBe('Keep working with the current research');
    expect(screen.getByRole('button', { name: 'Open research canvas' })).toBeTruthy();
  });
});
