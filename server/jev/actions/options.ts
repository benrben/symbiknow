import { z } from 'zod';
import type { JevAction, JevActionRequest } from '../../../shared/jev-types.js';
import { ApiError } from '../../errors.js';

const text = z.string().optional();
const strings = z.array(z.string()).optional();
const schemas: Partial<Record<JevAction, z.ZodType>> = {
  link: z.object({ relation: z.enum(['', 'prerequisite', 'implements', 'decision_for', 'supersedes',
    'contradicts', 'example_of', 'same_topic', 'related']).optional() }).passthrough(),
  vocab_lifecycle: z.object({ operation: z.enum(['', 'nominate', 'define', 'promote', 'rename', 'alias', 'retire', 'restore', 'merge', 'split']).optional(),
    kind: z.enum(['', 'group', 'label', 'entity']).optional(), termId: text, targetId: text, name: text, definition: text,
    aliases: strings, splitNames: strings, memberBlockIds: strings, parentId: text, groupKey: text }).passthrough(),
  recall: z.object({ includeArchived: z.boolean().optional() }).passthrough(),
};

/** Invalid selectors must never silently become broader or different operations. */
export function validateActionOptions(request: JevActionRequest): void {
  const schema = schemas[request.action];
  if (!schema) return;
  if (!schema.safeParse(request.options ?? {}).success) throw new ApiError(400, `Invalid options for ${request.action}`);
}
