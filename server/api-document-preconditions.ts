import type { IncomingMessage } from 'node:http';
import { z } from 'zod';
import type { BlockDeletionPreconditions } from '../shared/document-state.js';
import { ApiError } from './errors.js';
import { readBody } from './api-http.js';

const preconditions = z.object({ expectedDocumentState: z.string().optional(), expectedSavedCrossLinks: z.string().optional(),
  expectedContentHash: z.string().optional(), requireUnreferenced: z.boolean().optional() });

export async function readDeletionPreconditions(request: IncomingMessage): Promise<BlockDeletionPreconditions | undefined> {
  // Ordinary DELETE requests have no body and keep their existing behavior.
  if (!request.headers['transfer-encoding'] && Number(request.headers['content-length'] ?? 0) === 0) return;
  const parsed = preconditions.safeParse(await readBody(request));
  if (!parsed.success) throw new ApiError(400, 'Invalid document deletion preconditions');
  return parsed.data;
}
