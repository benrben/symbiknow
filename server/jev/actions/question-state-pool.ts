import { ApiError } from '../../errors.js';

export type SharedQuestionSourceState = {
  id: string; title: string; passages: Array<{ id: string; text: string }>; coverage: number;
};
export type SharedQuestionStates = { sourceStates: SharedQuestionSourceState[]; questionSets: Record<string, unknown>[] };
const referenceKey = '$jevSourceRef';

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function coverage(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}
function passage(value: unknown): value is SharedQuestionSourceState['passages'][number] {
  return object(value) && exactKeys(value, ['id', 'text']) && typeof value.id === 'string' && typeof value.text === 'string';
}
function source(value: Record<string, unknown>): value is SharedQuestionSourceState {
  return exactKeys(value, ['id', 'title', 'passages', 'coverage']) && typeof value.id === 'string'
    && typeof value.title === 'string' && coverage(value.coverage) && Array.isArray(value.passages)
    && value.passages.every(passage);
}

/** Compact only transport states; exact judgment-cache keys remain the original unpooled inputs. */
export function compileSharedQuestionStates(states: Record<string, unknown>[]): SharedQuestionStates {
  // Match JSON's wire projection and own its values before introducing reserved references.
  const owned = JSON.parse(JSON.stringify(states)) as Record<string, unknown>[];
  const sourceStates: SharedQuestionSourceState[] = [];
  const indices = new Map<string, number>();
  function reference(value: SharedQuestionSourceState): Record<string, number> {
    const key = JSON.stringify(value); let index = indices.get(key);
    if (index === undefined) { index = sourceStates.length; indices.set(key, index); sourceStates.push(value); }
    return { [referenceKey]: index };
  }
  function compile(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(compile);
    if (!object(value)) return value;
    if (Object.hasOwn(value, referenceKey)) throw new ApiError(400, 'Jev source reference markers are reserved for compiled question states');
    if (source(value)) return reference(value);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, compile(item)]));
  }
  return { sourceStates, questionSets: owned.map(state => compile(state) as Record<string, unknown>) };
}
