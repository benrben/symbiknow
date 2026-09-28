import type { Dispatch, FormEvent, SetStateAction } from 'react';
import type { CanvasNavigationTarget } from '../shared/answer-canvas';
import type { InsightAction, InsightItem, ReadingPath } from '../shared/insights';
import type { CanvasBlock, CanvasDocument, ChatSettings, WorkspaceSummary } from '../shared/types';
import type { BlockDraft, Dialog } from './app-model-helpers';
import type { SettingsPayload } from './SettingsPage';

type MergeReview = {
  canvasId: string;
  item: InsightItem;
  action: Extract<InsightAction, { type: 'merge' }>;
  blocks: CanvasBlock[];
  content: string;
};

/** The data and commands used by dialog surfaces, independent of App's full model. */
export interface AppDialogModel {
  dialog: Dialog;
  setDialog: Dispatch<SetStateAction<Dialog>>;
  busy: boolean;
  error: string;
  setError: Dispatch<SetStateAction<string>>;
  canvas: CanvasDocument | null;
  canvasId: string;
  crossLinkLabels: Record<string, string>;
  showChat: boolean;

  draftName: string;
  setDraftName: Dispatch<SetStateAction<string>>;
  createNamed: (event: FormEvent) => Promise<void>;
  canvasToDelete: { id: string; name: string; workspaceId: string } | null;
  workspaceToDelete: WorkspaceSummary | null;
  deleteCanvas: () => Promise<void>;
  deleteWorkspace: () => Promise<void>;

  settings: ChatSettings;
  setSettings: Dispatch<SetStateAction<ChatSettings>>;
  saveSettings: (payload: SettingsPayload) => Promise<void>;
  openActivityHistory: (canvasId: string, blockId: string, revision: string) => void;

  draftBlock: BlockDraft;
  setDraftBlock: Dispatch<SetStateAction<BlockDraft>>;
  draftLock: CanvasBlock['lock'];
  takeOverLock: (blockId: string) => Promise<void>;
  saveBlock: (event: FormEvent) => Promise<void>;
  importEditedFile: (file: File) => Promise<void>;
  deleteBlock: () => Promise<void>;
  updateBlock: (blockId: string, patch: Partial<CanvasBlock>) => Promise<void>;
  openDocumentAssistant: () => void;

  versionBlockId: string;
  versionRevision: string | undefined;
  refreshAfterVersionChange: () => Promise<void>;
  readerId: string;
  readingPath: ReadingPath | null;
  sourceFocus: Extract<CanvasNavigationTarget, { kind: 'document' }> | null;
  showReaderDocument: (blockId: string) => void;
  closeReader: () => void;
  openVersionHistory: (block: CanvasBlock) => void;
  openBlock: (block: CanvasBlock) => void;
  openCrossLink: (canvasId: string, blockId: string) => void;

  mergeReview: MergeReview | null;
  setMergeReview: Dispatch<SetStateAction<MergeReview | null>>;
  mergeBusy: boolean;
  applyMergeReview: () => Promise<void>;
}
