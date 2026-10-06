import { useEffect } from 'react';
import type { AnswerSource } from '../shared/answer-canvas';
import type { CanvasDocument } from '../shared/types';
import { api } from './api';
import { sourceKey } from './answer-canvas-helpers';
import type { AnswerCanvasState } from './useAnswerCanvasState';

export function useAnswerSourceFreshness(sources: AnswerSource[], setFreshness: AnswerCanvasState['setFreshness']) {
  const sourceFingerprint = sources.map(source => sourceKey(source) + ':' + (source.contentHash ?? '')).join('|');
  useEffect(() => {
    const tracked = sources.filter(source => source.contentHash);
    if (!tracked.length) {
      setFreshness('current');
      return;
    }
    let active = true;
    const check = async () => {
      try {
        const canvases = await Promise.all([...new Set(tracked.map(source => source.canvasId))]
          .map(id => api<CanvasDocument>('/canvases/' + encodeURIComponent(id))));
        if (!active) return;
        const documents = new Map(canvases.map(item => [item.id, item]));
        setFreshness(tracked.some(source => documents.get(source.canvasId)?.blocks.find(block => block.id === source.blockId)
          ?.contentHash !== source.contentHash) ? 'changed' : 'current');
      } catch { if (active) setFreshness('unavailable'); }
    };
    void check();
    const timer = window.setInterval(() => void check(), 8000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [sourceFingerprint]);
}
