import type { SharedQuestionSourceState } from './question-state-pool.js';

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function validPassage(value: unknown): boolean {
  return object(value) && exactKeys(value, ['id', 'text']) && typeof value.id === 'string' && typeof value.text === 'string';
}
function validCoverage(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}
function validSourceFields(value: Record<string, unknown>): boolean {
  return typeof value.id === 'string' && typeof value.title === 'string' && validCoverage(value.coverage)
    && Array.isArray(value.passages) && value.passages.every(validPassage);
}
function validSource(value: unknown): value is SharedQuestionSourceState {
  return object(value) && exactKeys(value, ['id', 'title', 'passages', 'coverage']) && validSourceFields(value);
}
function sourcePool(value: unknown): SharedQuestionSourceState[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(validSource)) throw new Error('Invalid synthetic provider source pool');
  return value;
}
function referencedSource(reference: Record<string, unknown>, pool: SharedQuestionSourceState[]): SharedQuestionSourceState {
  if (!exactKeys(reference, ['$jevSourceRef'])) throw new Error('Ambiguous synthetic provider source reference');
  const index = reference.$jevSourceRef;
  if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || index >= pool.length) {
    throw new Error('Invalid synthetic provider source reference index');
  }
  return structuredClone(pool[index]);
}

/** Decode only fixture transport references; production evaluations and exact cache inputs stay untouched. */
export function resolveSharedQuestionSources<T>(value: T, sourceStates?: unknown): T {
  const pool = sourcePool(sourceStates);
  function resolve(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(resolve);
    if (!object(input)) return input;
    if (Object.hasOwn(input, '$jevSourceRef')) return referencedSource(input, pool);
    return Object.fromEntries(Object.entries(input).map(([key, item]) => [key, resolve(item)]));
  }
  return resolve(value) as T;
}

function questionTextPool(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every(text => typeof text === 'string')) throw new Error('Invalid synthetic provider question text pool');
  return value;
}
function resolveText(text: string, pool: string[]): string {
  return text.replace(/\$jevQuestionText:(\d+)/g, (_reference, digits: string) => {
    const index = Number(digits);
    if (!Number.isSafeInteger(index) || index >= pool.length) throw new Error('Invalid synthetic provider question text reference index');
    return pool[index];
  });
}

/** Expand a generated reference once; original quoted marker text must remain literal. */
export function resolveSharedQuestionTexts<T>(value: T, questionTexts?: unknown): T {
  if (questionTexts === undefined) return structuredClone(value);
  const pool = questionTextPool(questionTexts);
  function resolve(input: unknown): unknown {
    if (typeof input === 'string') return resolveText(input, pool);
    if (Array.isArray(input)) return input.map(resolve);
    if (!object(input)) return input;
    return Object.fromEntries(Object.entries(input).map(([key, item]) => [key, resolve(item)]));
  }
  return resolve(value) as T;
}
