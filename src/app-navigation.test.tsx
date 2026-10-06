// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanvasBlock, CanvasDocument } from '../shared/types';
import { normalizeEvidence } from '../shared/evidence';
import { useAppState } from './app-state';
import { useCanvasNavigationActions } from './app-navigation';
import { CanvasSearch } from './CanvasSearch';
import { useEscapeLayer } from './escape-layers';

const block: CanvasBlock = { id: 'evidence', title: 'Evidence', content: '# Evidence', file: 'evidence.md', kind: 'markdown', x: 0, y: 0, width: 400, height: 290, links: [] };
const canvas: CanvasDocument = { id: 'planning', name: 'Planning', workspaceId: 'team', blocks: [block] };
const other: CanvasDocument = { ...canvas, id: 'delivery', name: 'Delivery' };
function session() {
  const hook = renderHook(() => { const state = useAppState(); return { state, actions: useCanvasNavigationActions(state) }; });
  act(() => {
    hook.result.current.state.setWorkspaces([{ id: 'team', name: 'Team', canvases: [{ id: canvas.id, name: canvas.name }, { id: other.id, name: other.name }] }]);
    hook.result.current.state.setCanvasId(canvas.id); hook.result.current.state.setCanvas(canvas);
  });
  return hook;
}
beforeEach(() => { window.localStorage.clear(); window.history.replaceState(null, '', '/?canvas=planning'); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('canvas navigation', () => {
  it.each(['640', 'invalid', 'Infinity', '200'])('restores a valid assistant width or defaults invalid preference %s', value => {
    window.localStorage.setItem('symbiknow.assistant.document-width', value);
    const { result } = renderHook(useAppState);
    expect(result.current.documentAssistantWidth).toBe(value === '640' ? 640 : 360);
  });
  it('starts the app when browser preference storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('Storage denied', 'SecurityError'); });
    const { result } = renderHook(useAppState);
    expect(result.current.documentAssistantWidth).toBe(360);
  });

  it('keeps an assistant width change usable when saving browser preferences fails', () => {
    const { result } = session();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage full'); });
    act(() => result.current.actions.updateDocumentAssistantWidth(640));
    expect(result.current.state.documentAssistantWidth).toBe(640);
    expect(warning).toHaveBeenCalledWith('Document assistant width cannot be saved; it remains available for this session.', expect.any(Error));
  });

  it('saves assistant width and opens the assistant in chat with a new focus request', () => {
    const { result } = session();
    act(() => result.current.actions.updateDocumentAssistantWidth(700));
    expect(window.localStorage.getItem('symbiknow.assistant.document-width')).toBe('700');
    act(() => { result.current.state.setShowChat(false); result.current.state.setAssistantView('reflex'); });
    act(() => result.current.actions.openDocumentAssistant());
    expect(result.current.state).toMatchObject({ showChat: true, assistantView: 'chat', assistantFocusRequest: 1 });
  });

  it('resolves names from the workspace, active canvas, and identifier fallbacks', () => {
    const { result } = session();
    expect(result.current.actions.canvasName('delivery')).toBe('Delivery');
    act(() => result.current.state.setWorkspaces([]));
    expect(result.current.actions.canvasName('planning')).toBe('Planning');
    expect(result.current.actions.canvasName('missing')).toBe('missing');
    act(() => result.current.state.setCanvas(null));
    expect(result.current.actions.canvasName('planning')).toBe('planning');
  });

  it('navigates with document and viewport requests, clears previous view state, and supports sequence repeats', () => {
    const { result } = session();
    act(() => { result.current.state.setAnswerCanvasOpen(true); result.current.state.setReaderId('old');
      result.current.state.setSelectedBlockIds(['old']); result.current.state.setVisibleBlockIds(['old']); });
    const viewport = { x: 100, y: 120, zoom: .7 };
    act(() => result.current.actions.navigateTo({ canvasId: other.id, canvasName: other.name, blockId: 'evidence', viewport }));
    expect(result.current.state).toMatchObject({ canvasId: 'delivery', canvas: null, readerId: '', selectedBlockIds: [], visibleBlockIds: [], answerCanvasOpen: false,
      viewportRequest: { ...viewport, sequence: 1 }, focusRequest: { canvasId: 'delivery', blockId: 'evidence', title: 'Document', sequence: 1 } });
    expect(window.location.search).toBe('?canvas=delivery');
    act(() => result.current.state.setCanvas(other));
    act(() => result.current.actions.navigateTo({ canvasId: other.id, canvasName: other.name, blockId: 'evidence', title: 'Reviewed', viewport }));
    expect(result.current.state.canvas).toBe(other);
    expect(result.current.state.viewportRequest?.sequence).toBe(2);
    expect(result.current.state.focusRequest).toMatchObject({ title: 'Reviewed', sequence: 2 });
    act(() => result.current.actions.navigateTo({ canvasId: 'unloaded', canvasName: 'Unloaded' }, false));
    expect(result.current.state.canvas).toBeNull();
    expect(result.current.state.focusRequest).toBeNull();
    expect(result.current.state.viewportRequest).toBeUndefined();
  });

  it('does not add a history entry for an unchanged canvas URL but replaces document navigation with the canvas', () => {
    const { result } = session();
    const push = vi.spyOn(window.history, 'pushState');
    act(() => result.current.actions.navigateTo({ canvasId: 'planning', canvasName: 'Planning' }, false));
    expect(push).not.toHaveBeenCalled();
    expect(result.current.state.canvas).toBe(canvas);
    window.history.replaceState(null, '', '/?canvas=planning&doc=evidence');
    act(() => result.current.actions.navigateTo({ canvasId: 'planning', canvasName: 'Planning' }, false));
    expect(push).toHaveBeenCalledOnce();
    expect(window.location.search).toBe('?canvas=planning');
  });

  it('selects a known workspace and preserves its preference when selecting an unknown canvas', () => {
    const { result } = session();
    act(() => { result.current.state.setSearchOpen(true); result.current.state.setBrowseGroupsOpen(true); });
    act(() => result.current.actions.selectCanvas('delivery'));
    expect(result.current.state).toMatchObject({ searchOpen: false, browseGroupsOpen: false, canvasId: 'delivery', canvas: null });
    expect(result.current.state.preferredWorkspaceId.current).toBe('team');
    act(() => result.current.actions.selectCanvas('missing'));
    expect(result.current.state.preferredWorkspaceId.current).toBe('team');
  });

  it('clears canvas data on browser back/forward switches, preserves the current canvas, and falls back for deleted canvases', () => {
    const { result } = session();
    const pop = (url: string) => { window.history.replaceState(null, '', url); act(() => window.dispatchEvent(new PopStateEvent('popstate'))); };
    pop('/?canvas=delivery&doc=evidence');
    expect(result.current.state).toMatchObject({ canvasId: 'delivery', canvas: null, readerId: 'evidence' });
    act(() => result.current.state.setCanvas(other));
    pop('/?canvas=delivery');
    expect(result.current.state.readerId).toBe('');
    expect(result.current.state.canvas).toBe(other);
    pop('/?canvas=planning&doc=evidence');
    expect(result.current.state.canvas).toBeNull();
    pop('/?canvas=deleted&doc=obsolete');
    expect(result.current.state).toMatchObject({ canvasId: 'planning', readerId: '' });
    expect(window.location.search).toBe('?canvas=planning');
    act(() => result.current.state.setWorkspaces([]));
    pop('/?canvas=deleted');
    expect(result.current.state).toMatchObject({ canvasId: '', readerId: '' });
    expect(window.location.search).toBe('');
  });

  it('opens search using either keyboard shortcut and respects modal ownership of Escape', () => {
    let state!: ReturnType<typeof useAppState>;
    function NavigationLayers() {
      state = useAppState(); useCanvasNavigationActions(state);
      useEscapeLayer(Boolean(state.dialog), () => state.setDialog(null));
      return <>{state.searchOpen && <CanvasSearch query="" hits={[]} loading={false} currentCanvasId={canvas.id}
        onQuery={() => undefined} onClose={() => state.setSearchOpen(false)} onReveal={() => undefined} onEdit={() => undefined}/>}
        {state.dialog && <div role="dialog" aria-label="Settings owner"><button>Settings control</button></div>}</>;
    }
    render(<NavigationLayers/>);
    const send = (key: string, modifiers = {}) => { const event = new KeyboardEvent('keydown', { key, ...modifiers, cancelable: true }); act(() => window.dispatchEvent(event)); return event; };
    expect(send('K', { metaKey: true }).defaultPrevented).toBe(true);
    expect(state.searchOpen).toBe(true); expect(screen.getByRole('dialog', { name: 'Search documents' })).toBeTruthy();
    act(() => state.setSearchOpen(false));
    expect(send('k', { ctrlKey: true }).defaultPrevented).toBe(true);
    act(() => state.setDialog('settings'));
    send('Escape');
    expect(state.searchOpen).toBe(true); expect(state.dialog).toBeNull();
    expect(screen.queryByRole('dialog', { name: 'Settings owner' })).toBeNull();
    send('Escape');
    expect(state.searchOpen).toBe(false); expect(screen.queryByRole('dialog', { name: 'Search documents' })).toBeNull();
    send('x');
    expect(state.searchOpen).toBe(false);
  });

  it('focuses a block on compact screens and can retain the search panel', () => {
    const { result } = session();
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    window.history.replaceState(null, '', '/?canvas=planning&doc=old');
    act(() => { result.current.state.setSearchOpen(true); result.current.state.setDialog('block'); });
    act(() => result.current.actions.showBlockOnCanvas('delivery', 'evidence', 'Evidence', true));
    expect(result.current.state).toMatchObject({ searchOpen: true, dialog: null, showChat: false, canvasId: 'delivery', readerId: '' });
    expect(window.location.search).toBe('?canvas=delivery');
    vi.stubGlobal('matchMedia', undefined);
    act(() => result.current.actions.showBlockOnCanvas('planning', 'evidence', 'Evidence'));
    expect(result.current.state.searchOpen).toBe(false);
  });

  it('opens chat source excerpts and returns to the research canvas', () => {
    const { result } = session();
    act(() => result.current.state.setAnswerCanvasOpen(true));
    const target = { kind: 'document' as const, canvasId: 'delivery', blockId: 'evidence', title: 'Evidence', excerpt: 'Quoted evidence' };
    act(() => result.current.actions.navigateFromChat(target));
    expect(result.current.state.sourceFocus).toEqual(target);
    expect(result.current.state.readerId).toBe('evidence');
    act(() => result.current.actions.returnFromChatNavigation());
    expect(result.current.state).toMatchObject({ canvasId: 'planning', answerCanvasOpen: true, sourceFocus: null, readerId: '' });
    expect(result.current.state.chatReturn.current).toBeNull();
  });

  it('supports group navigation, repeated focus requests, and return without a recorded prior journey', () => {
    const { result } = session();
    act(() => { result.current.state.journey.forgetCanvas('planning'); result.current.state.setCanvas(null); });
    act(() => result.current.actions.navigateFromChat({ kind: 'group', canvasId: 'delivery', group: 'Research', title: 'Research' }));
    expect(result.current.state.groupFocusRequest).toEqual({ canvasId: 'delivery', group: 'Research', sequence: 1 });
    act(() => result.current.actions.navigateFromChat({ kind: 'group', canvasId: 'delivery', group: 'Review', title: 'Review' }));
    expect(result.current.state.groupFocusRequest?.sequence).toBe(2);
    act(() => result.current.actions.returnFromChatNavigation());
    expect(result.current.state.answerCanvasOpen).toBe(false);
  });

  it('uses the saved return place when history has been removed and tolerates an empty return history', () => {
    const { result } = session();
    act(() => result.current.actions.navigateFromChat({ kind: 'document', canvasId: 'delivery', blockId: 'evidence', title: 'Evidence' }));
    act(() => { result.current.state.journey.forgetCanvas('planning'); result.current.state.journey.forgetCanvas('delivery'); result.current.state.setCanvas(null); });
    act(() => result.current.actions.returnFromChatNavigation());
    expect(result.current.state.canvasId).toBe('planning');
    act(() => result.current.actions.returnFromChatNavigation());
    expect(result.current.state.canvasId).toBe('planning');
  });

  it('opens readers, changes their document URL, and closes using browser history or direct URL cleanup', () => {
    const { result } = session();
    act(() => result.current.actions.openReader('evidence'));
    expect(result.current.state.readerId).toBe('evidence');
    expect(result.current.state.journey.current).toMatchObject({ blockId: 'evidence', title: 'Evidence' });
    act(() => result.current.actions.showReaderDocument('other-document'));
    expect(window.location.search).toBe('?canvas=planning&doc=other-document');
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    act(() => result.current.actions.closeReader());
    expect(back).toHaveBeenCalledOnce();
    window.history.replaceState(null, '', '/?canvas=planning&doc=direct-link');
    act(() => result.current.actions.closeReader());
    expect(result.current.state.readerId).toBe('');
    expect(window.location.search).toBe('?canvas=planning');
    act(() => result.current.actions.openReader('missing'));
    expect(result.current.state.readerId).toBe('missing');
    act(() => result.current.state.setCanvas(null));
    act(() => result.current.actions.openReader('unloaded'));
    expect(result.current.state.readerId).toBe('unloaded');
  });

  it('closes a chat excerpt reader without changing canvas history when its URL has no document parameter', () => {
    const { result } = session();
    act(() => result.current.actions.navigateFromChat({ kind: 'document', canvasId: canvas.id,
      blockId: block.id, title: block.title, excerpt: 'Quoted evidence' }));
    expect(result.current.state.readerId).toBe(block.id);
    expect(result.current.state.sourceFocus).toMatchObject({ excerpt: 'Quoted evidence' });
    expect(window.location.search).toBe('?canvas=planning');
    const place = result.current.state.journey.current;
    const navigationVersion = result.current.state.navigationVersion.current;
    const back = vi.spyOn(window.history, 'back');
    const push = vi.spyOn(window.history, 'pushState');
    const replace = vi.spyOn(window.history, 'replaceState');
    act(() => result.current.actions.closeReader());
    expect(result.current.state).toMatchObject({ readerId: '', sourceFocus: null, canvasId: canvas.id, canvas });
    expect(result.current.state.navigationVersion.current).toBe(navigationVersion + 1);
    expect(result.current.state.journey.current).toBe(place);
    expect(window.location.search).toBe('?canvas=planning');
    expect(back).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it('guards missing cross-link targets, clears switched canvas data, and retains the current linked canvas', () => {
    const { result } = session();
    act(() => result.current.actions.openCrossLink('', 'evidence'));
    act(() => result.current.actions.openCrossLink('delivery', ''));
    expect(result.current.state.canvasId).toBe('planning');
    act(() => result.current.actions.openCrossLink('delivery', 'evidence'));
    expect(result.current.state).toMatchObject({ canvasId: 'delivery', canvas: null, readerId: 'evidence' });
    expect(window.location.search).toBe('?canvas=delivery&doc=evidence');
    act(() => result.current.state.setCanvas(other));
    act(() => result.current.actions.openCrossLink('delivery', 'evidence'));
    expect(result.current.state.canvas).toBe(other);
    act(() => result.current.actions.openCrossLink('unloaded', 'evidence'));
    expect(result.current.state.canvas).toBeNull();
  });

  it('focuses the linked document after clearing a previous canvas position', () => {
    const { result } = session();
    act(() => {
      result.current.state.setViewportRequest({ x: 40, y: 60, zoom: 0.4, sequence: 7 });
      result.current.state.setFocusRequest({ canvasId: 'planning', blockId: 'evidence', title: 'Evidence', sequence: 3 });
      result.current.state.setSelectedBlockIds(['evidence']);
      result.current.state.setVisibleBlockIds(['evidence']);
    });
    act(() => result.current.actions.openCrossLink('delivery', 'atlas-errors'));
    expect(result.current.state).toMatchObject({ canvasId: 'delivery', readerId: 'atlas-errors',
      focusRequest: { canvasId: 'delivery', blockId: 'atlas-errors', sequence: 4 },
      selectedBlockIds: [], visibleBlockIds: [] });
    expect(result.current.state.viewportRequest).toBeUndefined();
    expect(window.location.search).toBe('?canvas=delivery&doc=atlas-errors');
    act(() => result.current.actions.openCrossLink('delivery', 'atlas-errors'));
    expect(result.current.state.focusRequest?.sequence).toBe(5);
  });

  it.each([false, true])('opens research citations using evidence=%s and returns when closing the reader', withEvidence => {
    const { result } = session();
    act(() => result.current.state.setAnswerCanvasOpen(true));
    const evidence = withEvidence ? normalizeEvidence({ claim: 'Claim', passage: 'Evidence passage', sourceText: 'Evidence passage', canvasId: 'delivery', documentId: 'evidence', contentHash: 'evidence-hash', checkedAt: '2026-10-01T00:00:00Z' })! : undefined;
    act(() => result.current.actions.openResearchSource({ canvasId: 'delivery', canvasName: 'Delivery', blockId: 'evidence', title: 'Evidence', excerpt: 'Fallback passage', contentHash: 'fallback-hash', relevance: 1, evidence }));
    expect(result.current.state.sourceFocus).toMatchObject({ excerpt: withEvidence ? 'Evidence passage' : 'Fallback passage', contentHash: withEvidence ? 'evidence-hash' : 'fallback-hash' });
    expect(result.current.state.researchSourceReturn.current).toBe(true);
    act(() => result.current.actions.closeReader());
    expect(result.current.state).toMatchObject({ canvasId: 'planning', answerCanvasOpen: true, readerId: '' });
  });

  it('records only single selections and returns from chat through valid history entries', () => {
    const { result } = session();
    const initial = result.current.state.journey.journey.entries;
    act(() => result.current.actions.selectedOnCanvas([]));
    act(() => result.current.actions.selectedOnCanvas([block, { ...block, id: 'second' }]));
    expect(result.current.state.selectedBlockIds).toEqual(['evidence', 'second']);
    expect(result.current.state.journey.journey.entries).toBe(initial);
    act(() => result.current.actions.selectedOnCanvas([block]));
    expect(result.current.state.journey.current).toMatchObject({ blockId: 'evidence', title: 'Evidence' });
    act(() => result.current.actions.navigateTo({ canvasId: 'delivery', canvasName: 'Delivery' }));
    act(() => result.current.actions.returnFromChatNavigation());
    expect(result.current.state.canvasId).toBe('planning');
    act(() => result.current.actions.returnFromChatNavigation());
    expect(result.current.state.canvasId).toBe('planning');
    act(() => result.current.actions.returnFromChatNavigation());
    const current = result.current.state.journey.current;
    act(() => result.current.state.setCanvas(null));
    act(() => result.current.actions.selectedOnCanvas([block]));
    expect(result.current.state.journey.current).toBe(current);
  });
});
