import type { z } from 'zod';
import type { AnswerCanvasTurn, ResearchLayout } from '../shared/answer-canvas.js';
import type { ResearchCanvasEdits } from '../src/research-edits.js';
import type { createFields, updateFields } from './investigations-schema.js';

type ResearchSnapshot = { turns: AnswerCanvasTurn[]; edits: ResearchCanvasEdits; layout: ResearchLayout };
export type Investigation = Omit<z.infer<typeof createFields>, 'researchSnapshot'> & { researchSnapshot?: ResearchSnapshot;
  id: string; revision: number; createdAt: string; updatedAt: string };
export type InvestigationSummary = Pick<Investigation, 'id' | 'workspaceId' | 'canvasId' | 'title' | 'visibility' | 'question' | 'revision' | 'createdAt' | 'updatedAt'>
  & { sourceCount: number; proposalCount: number; messageCount: number };
export type SavedInvestigation = Investigation & { keyHash?: string };
export type InvestigationPatch = z.infer<typeof updateFields>;
