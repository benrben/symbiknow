import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import type { SearchHit } from '../shared/types';
import { groupLabel } from '../shared/groups';
import { searchCanvasName } from './canvas-search-model';
import { useModalFocus } from './useModalFocus';

type Props = { hit: SearchHit; fallbackFocus: RefObject<HTMLInputElement | null>; onCancel: () => void; onConfirm: () => void };

export function CanvasSearchConfirmation({ hit, fallbackFocus, onCancel, onConfirm }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocus(dialogRef, onCancel, false);
  useEffect(() => () => {
    // A refreshed result list may remove the opener before modal focus is restored.
    if (document.activeElement === document.body) fallbackFocus.current?.focus();
  }, [fallbackFocus]);
  return <div ref={dialogRef} tabIndex={-1} className="canvas-search__confirm" role="dialog" aria-modal="true" aria-label="Switch canvas">
    <strong>Switch to {searchCanvasName(hit)}?</strong>
    <p>{hit.title}{hit.group ? ` · ${groupLabel(hit.group)}` : ''} is on another canvas.</p>
    <div><button type="button" onClick={onCancel}>Cancel</button><button type="button" onClick={onConfirm}>Switch canvas</button></div>
  </div>;
}
