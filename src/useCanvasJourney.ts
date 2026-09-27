import { useEffect, useState } from 'react';

export type CanvasViewport = { x: number; y: number; zoom: number };
export type CanvasPlace = { canvasId: string; canvasName: string; blockId?: string; title?: string; viewport?: CanvasViewport };
export type CanvasBookmark = CanvasPlace & { id: string; name: string };

type Journey = { entries: CanvasPlace[]; index: number };

function readSaved<T>(key: string, fallback: T): T {
  try {
    const stored = window.localStorage.getItem(key);
    return stored ? JSON.parse(stored) as T : fallback;
  } catch { return fallback; }
}

function save(key: string, value: unknown) {
  try { window.localStorage.setItem(key, JSON.stringify(value)); }
  catch { /* Private browsing may not allow local storage; navigation still works for this session. */ }
}

export function useCanvasJourney() {
  const [journey, setJourney] = useState<Journey>({ entries: [], index: -1 });
  const [bookmarks, setBookmarks] = useState<CanvasBookmark[]>(() => readSaved('symbiknow:bookmarks', []));
  const [recent, setRecent] = useState<CanvasPlace[]>(() => readSaved('symbiknow:recent', []));
  const [headerHidden, setHeaderHidden] = useState(() => readSaved('symbiknow:header-hidden', false));

  useEffect(() => save('symbiknow:bookmarks', bookmarks), [bookmarks]);
  useEffect(() => save('symbiknow:recent', recent), [recent]);
  useEffect(() => save('symbiknow:header-hidden', headerHidden), [headerHidden]);

  function visit(place: CanvasPlace) {
    setJourney(current => {
      const previous = current.entries[current.index];
      if (previous?.canvasId === place.canvasId && previous.blockId === place.blockId &&
        (!place.viewport || previous.viewport === place.viewport)) return current;
      const entries = [...current.entries.slice(0, current.index + 1), place].slice(-100);
      return { entries, index: entries.length - 1 };
    });
    if (place.blockId) setRecent(current => [place, ...current.filter(item => item.canvasId !== place.canvasId || item.blockId !== place.blockId)].slice(0, 12));
  }

  function updateViewport(canvasId: string, viewport: CanvasViewport) {
    setJourney(current => {
      if (current.index < 0 || current.entries[current.index]?.canvasId !== canvasId) return current;
      const old = current.entries[current.index].viewport;
      if (old && old.x === viewport.x && old.y === viewport.y && old.zoom === viewport.zoom) return current;
      const entries = [...current.entries];
      entries[current.index] = { ...entries[current.index], viewport };
      return { ...current, entries };
    });
  }

  function moveHistory(direction: number): CanvasPlace | undefined {
    const index = journey.index + direction;
    const place = journey.entries[index];
    if (place) setJourney(current => ({ ...current, index }));
    return place;
  }

  function addBookmark(name: string, place: CanvasPlace) {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBookmarks(current => [{ ...place, id: crypto.randomUUID(), name: trimmed }, ...current].slice(0, 50));
  }

  function removeBookmark(id: string) { setBookmarks(current => current.filter(item => item.id !== id)); }

  return { journey, current: journey.entries[journey.index], visit, updateViewport, moveHistory,
    bookmarks, addBookmark, removeBookmark, recent, headerHidden, setHeaderHidden };
}
