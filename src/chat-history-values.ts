import { z } from 'zod';
import type { DisplayTurn } from './chat-types';

const savedActivity = z.object({
  key: z.number(),
  type: z.enum(['thinking', 'tool']),
  id: z.string().optional(),
  name: z.string().optional(),
  message: z.string(),
  status: z.enum(['active', 'complete', 'stopped']),
});
const savedTurn = z.object({
  id: z.number().refine(Number.isInteger),
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  activities: z.array(savedActivity),
});

/** Validate without replacing the snapshot: proposal and research fields retain their original values. */
export function isSavedTurn(value: unknown): value is DisplayTurn {
  return savedTurn.safeParse(value).success;
}
