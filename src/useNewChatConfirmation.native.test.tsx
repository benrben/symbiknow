// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CanvasStore } from '../server/storage';
import { useAppModel } from './app-model';
import { researchStorageKey } from './app-state-helpers';
import { emptyResearchEdits } from './research-edits';
import { NewChatConfirmation } from './NewChatConfirmation';
import { useNewChatConfirmation } from './useNewChatConfirmation';
import { closeWorkspaceFixtures, workspaceFixture } from './native-workspace.test.fixture';
import { turn } from './AppAssistantPanel.test.helpers';

afterEach(async () => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  await closeWorkspaceFixtures();
});

function NativeConfirmationOwner() {
  const model = useAppModel();
  const confirmation = useNewChatConfirmation(model);
  return <form aria-label="Research save request" onSubmit={event => { event.preventDefault(); void confirmation.save(); }}>
    <output>{model.canvas?.name}</output>
    <button type="button" onClick={confirmation.start}>New chat</button>
    <NewChatConfirmation canSave={model.answerTurns.length > 0} {...confirmation}
      onClose={confirmation.close} onDiscard={confirmation.discard} onSave={confirmation.save}/>
  </form>;
}

it('coalesces repeated public save submissions while one authorized native research save is pending', async () => {
  const fixture = await workspaceFixture();
  window.history.replaceState(null, '', '/?canvas=' + fixture.canvas.id);
  localStorage.setItem(researchStorageKey, JSON.stringify({ turns: [turn], edits: emptyResearchEdits(), layout: 'mindmap' }));
  const route = '/api/workspaces/' + fixture.workspace.id + '/canvases';
  const pending = fixture.hold(route);
  const before = await fixture.store.listWorkspaces();
  render(<NativeConfirmationOwner/>);
  await screen.findByText(fixture.canvas.name);
  fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
  await screen.findByRole('alertdialog', { name: 'Start a new chat' });
  const form = screen.getByRole('form', { name: 'Research save request' }) as HTMLFormElement;
  act(() => { form.requestSubmit(); form.requestSubmit(); });
  const createdResponse = await pending.response;
  expect(createdResponse.status).toBe(201);
  expect(fixture.calls.filter(call => call.route === route && call.method === 'POST')).toHaveLength(1);
  expect((screen.getByRole('button', { name: 'Saving…' }) as HTMLButtonElement).disabled).toBe(true);
  const created = await createdResponse.clone().json() as { id: string };
  await act(async () => { await pending.release(); });
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  const restarted = new CanvasStore(fixture.root);
  await restarted.init();
  const saved = await restarted.getCanvas(created.id);
  expect(saved.blocks).toHaveLength(1);
  expect(saved.blocks[0]).toMatchObject({ title: 'Release review', kind: 'markdown' });
  expect(saved.blocks[0].content).toContain('Review before release.');
  expect(await fixture.reload(created.id)).toEqual(saved);
  expect((await restarted.listWorkspaces()).flatMap(workspace => workspace.canvases)).toHaveLength(before.flatMap(workspace => workspace.canvases).length + 1);
  expect(JSON.parse(localStorage.getItem(researchStorageKey) ?? 'null')).toMatchObject({ turns: [] });
  expect(fixture.calls.filter(call => call.route === route && call.method === 'POST')).toHaveLength(1);
});
