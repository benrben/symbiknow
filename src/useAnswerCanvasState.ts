import { useEffect, useMemo, useRef, useState } from 'react';
import type { Viewport } from '@xyflow/react';
import type { AnswerCanvasViewFocus } from '../shared/answer-canvas';
import type { EditorMode } from './MarkdownEditor';
import type { AnswerCanvasProps, AnswerDraft } from './answer-canvas-types';
import type { AnswerCanvasGraph } from './useAnswerCanvasGraph';

export function useAnswerCanvasState({ turns, layout, edits, actionRequest }: AnswerCanvasProps, { graph, latest }: AnswerCanvasGraph) {
  const [focusRequest, setFocusRequest] = useState<{ blockId: string; sequence: number }>();
  const [fitRequest, setFitRequest] = useState(0);
  const [focusedTurnId, setFocusedTurnId] = useState<number | null>(latest?.id ?? null);
  const [search, setSearch] = useState('');
  const searchInput = useRef<HTMLInputElement>(null);
  const seenAction = useRef(actionRequest?.sequence ?? 0);
  const [viewportRequest, setViewportRequest] = useState<Viewport & { sequence: number }>();
  const [draft, setDraft] = useState<AnswerDraft | null>(null);
  const [editorMode, setEditorMode] = useState<EditorMode>('source');
  const [readerId, setReaderId] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [duplicateId, setDuplicateId] = useState('');
  const [freshness, setFreshness] = useState<'current' | 'changed' | 'unavailable'>('current');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saved, setSaved] = useState<{ id: string; name: string } | null>(null);
  const focusedKey = useRef('');
  const focusState = useRef<AnswerCanvasViewFocus>({ level: 'big-picture', visibleAnswerIds: [], visibleSourceKeys: [] });
  const snapshot = useMemo(() => ({}), [turns, layout, edits]);
  const live = useRef({ graph, edits, latest, snapshot });
  live.current = { graph, edits, latest, snapshot };
  const active = useRef(true);
  const generation = useRef(0);
  useEffect(() => {
    active.current = true;
    // A restarted effect must not revive file reads started by its prior lifetime.
    return () => {
      active.current = false;
      ++generation.current;
    };
  }, []);
  return {
    focusRequest, setFocusRequest, fitRequest, setFitRequest, focusedTurnId, setFocusedTurnId, search, setSearch,
    searchInput, seenAction, viewportRequest, setViewportRequest, draft, setDraft, editorMode, setEditorMode,
    readerId, setReaderId, historyOpen, setHistoryOpen, duplicateId, setDuplicateId, freshness, setFreshness, saving,
    setSaving, saveError, setSaveError, saved, setSaved, focusedKey, focusState, snapshot, live, active, generation,
  };
}
export type AnswerCanvasState = ReturnType<typeof useAnswerCanvasState>;
