import { useEffect, useRef } from 'react';
import type { CanvasDocument, SearchHit } from '../shared/types';
import { api } from './api';
import type { DocumentActions } from './app-documents';
import type { CanvasNavigationActions } from './app-navigation';
import type { AppState } from './app-state';
import { errorText } from './app-state-helpers';

export function useCanvasSearch(state: AppState, navigation: CanvasNavigationActions, documents: DocumentActions) {
  const searchVersion = useRef(0);
  const resultVersion = useRef(0);
  const {
    canvas, setError, dialogVersion, navigationVersion, setSearchOpen, searchQuery, setSearchHits,
    setSearching, setSearchResultQuery, setSearchError, searchRetry, setActiveSearchId,
    activeCanvasId,
  } = state;
  const { navigateTo, showBlockOnCanvas, navigateFromChat } = navigation;
  const { openBlock } = documents;

  useEffect(() => {
    searchVersion.current++;
    const query = searchQuery.trim();
    setSearchError('');
    if (!query) { setSearchHits([]); setSearching(false); setSearchResultQuery(''); return; }
    setSearching(true);
   
    setSearchHits([]);
    let active = true;
    const timer = window.setTimeout(() => {
      api<SearchHit[]>('/search?q=' + encodeURIComponent(query))
        .then(hits => {
          if (!active) return;
          setSearchHits(hits); setSearchResultQuery(query); setSearching(false); setSearchError('');

        })
        .catch(failure => { if (active) { setSearchResultQuery(query); setSearching(false); setSearchError(errorText(failure)); } });
    }, 220);
    return () => { active = false; window.clearTimeout(timer); };
  }, [searchQuery, searchRetry]);

  function currentResultRequest() {
    const request = ++resultVersion.current;
    const query = searchVersion.current;
    const navigation = navigationVersion.current;
    const editor = dialogVersion.current;
    return () => resultVersion.current === request && searchVersion.current === query
      && navigationVersion.current === navigation && dialogVersion.current === editor;
  }

  async function selectSearchHit(hit: SearchHit) {
    setSearchOpen(false);
    navigateTo({ canvasId: hit.canvasId, canvasName: hit.canvasName, blockId: hit.blockId, title: hit.title });
    const ownsRequest = currentResultRequest();
    const isCurrent = () => activeCanvasId.current === hit.canvasId && ownsRequest();
    try {
      const document = await api<CanvasDocument>('/canvases/' + encodeURIComponent(hit.canvasId) + '?summary=1', { cache: 'no-store' });
      if (!isCurrent()) return;
      if (document.id !== hit.canvasId) throw new Error('The returned canvas does not match this search result. Search again.');
      const block = document.blocks.find(item => item.id === hit.blockId);
      if (block) await openBlock(block);
    } catch (failure) { if (isCurrent()) setError(errorText(failure)); }
  }

  async function revealSearchHit(hit: SearchHit) {
    const isCurrent = currentResultRequest();
    try {
      const document = await api<CanvasDocument>('/canvases/' + encodeURIComponent(hit.canvasId) + '?summary=1', { cache: 'no-store' });
      if (!isCurrent()) return;
      if (document.id !== hit.canvasId) throw new Error('The returned canvas does not match this search result. Search again.');
      const block = document.blocks.find(item => item.id === hit.blockId);
      if (!block) throw new Error('This document no longer exists on the canvas.');
      setActiveSearchId(block.id);
      showBlockOnCanvas(hit.canvasId, block.id, block.title, true);
    } catch (failure) { if (isCurrent()) setError(errorText(failure)); }
  }

  function openSearchEvidence(hit: SearchHit) {
    if (!hit.evidence) return;
    navigateFromChat({ kind: 'document', canvasId: hit.evidence.navigation.canvasId,
      blockId: hit.evidence.navigation.blockId, title: hit.title,
      excerpt: hit.evidence.passage, contentHash: hit.evidence.contentHash });
  }

  const searchCurrentContentHashes = Object.fromEntries((canvas ? [canvas] : [])
    .flatMap(document => document.blocks.filter(block => block.contentHash)
      .map(block => [`${document.id}:${block.id}`, block.contentHash!] as const)));

  return { selectSearchHit, revealSearchHit, openSearchEvidence, searchCurrentContentHashes };
}

export type CanvasSearchActions = ReturnType<typeof useCanvasSearch>;
