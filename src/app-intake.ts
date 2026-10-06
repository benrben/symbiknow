import { useEffect, useRef } from 'react';
import type { CanvasBlock } from '../shared/types';
import { api } from './api';
import type { CanvasDataActions } from './app-canvas-data';
import type { DocumentActions } from './app-documents';
import { importedFile } from './app-model-helpers';
import type { CanvasNavigationActions } from './app-navigation';
import type { AppState } from './app-state';

/** Import files directly into the chosen canvas, without semantic review or classification. */
export function useIntakeActions(state: AppState, data: CanvasDataActions, navigation: CanvasNavigationActions, documents: DocumentActions) {
  const generation = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const { canvasId, uploadRef } = state;
  async function uploadFile(file: File, targetCanvasId: string) {
    const imported = await importedFile(file);
    return api<CanvasBlock>('/canvases/' + encodeURIComponent(targetCanvasId) + '/blocks', {
      method: 'POST', body: JSON.stringify({ title: file.name.replace(/\.(md|mdx|html)$/i, ''), ...imported }),
    });
  }
  async function uploadFiles(files: FileList | null) {
    if (!files?.length || !canvasId) return;
    const version = ++generation.current;
    const navigationVersion = state.navigationVersion.current;
    const isCurrent = () => mounted.current && state.activeCanvasId.current === canvasId
      && state.navigationVersion.current === navigationVersion && generation.current === version;
    await documents.perform(async () => {
      let last: CanvasBlock | undefined;
      for (const file of Array.from(files)) last = await uploadFile(file, canvasId);
      if (!isCurrent()) return;
      await data.loadCanvas(canvasId);
      if (last && isCurrent()) navigation.showBlockOnCanvas(canvasId, last.id, last.title);
    });
    if (uploadRef.current) uploadRef.current.value = '';
  }
  return { uploadFile, uploadFiles };
}
export type IntakeActions = ReturnType<typeof useIntakeActions>;
