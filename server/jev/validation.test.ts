import { expect, it } from 'vitest';
import type { JevMutation, JevVocabularyTerm } from '../../shared/jev-types.js';
import { updatedJevSettings, validateRequest } from './configuration.js';
import { mutationIdentity, validateMutation } from './mutations.js';
import { emptyJevWorkspace } from './workspace.js';
import { checkVocabularyMutation } from './vocabulary.js';

it('rejects malformed selections and bounded operation arguments instead of broadening action scope', () => {
  const request = { action: 'profile', canvasId: 'canvas' } as const;
  expect(() => validateRequest(request)).not.toThrow();
  for (const invalid of [null, [], { ...request, action: 'invented' }, { ...request, canvasId: '../outside' },
    ...['set_headline', 'set_freshness', 'flag_sensitive', 'order_reading', 'suggest_archive', 'mark_supersedes',
      'flag_gap', 'create_task_from_line', 'suggest_task_done', 'prioritize', 'where_to_put', 'route_chat',
      'digest', 'review_agent_edit'].map(action => ({ ...request, action })),
    ...[null, false, 'doc', ['../outside'], Array.from({ length: 101 }, () => 'doc')].map(blockIds => ({ ...request, blockIds })),
    ...[4, 'x'.repeat(8001)].map(query => ({ ...request, query })),
    ...[null, [], { text: 'x'.repeat(1_100_001) }].map(options => ({ ...request, options })),
    ...[5, 'x'.repeat(201)].map(idempotencyKey => ({ ...request, idempotencyKey }))]) {
    expect(() => validateRequest(invalid as never)).toThrowError(expect.objectContaining({ status: 400 }));
  }
  expect(() => validateRequest({ ...request, blockIds: ['doc'], query: 'Find sources', options: { limit: 5 }, idempotencyKey: 'once' })).not.toThrow();
});

it('validates people and rejects removed schedules, allowlists and manual action modes', () => {
  const previous = emptyJevWorkspace().settings;
  const person = { id: 'reviewer', name: 'Reviewer', role: 'Engineering' };
  const schedule = { id: 'daily', canvasIds: ['canvas'], time: '09:30', timezone: 'Asia/Jerusalem', enabled: true };
  const configured = updatedJevSettings(previous, { people: [person], modes: { file: 'auto' } as never });
  expect(configured.people).toEqual([person]); expect(configured.schedules).toEqual([]);
  for (const invalid of [null, { unknown: true }, { paused: 'yes' }, { externalProcessing: 1 },
    { modes: null }, { modes: [] }, { modes: { profile: 'invented' } }, { modes: { invented: 'auto' } }, { modes: { file: 'suggest' } },
    { people: null }, { people: Array.from({ length: 201 }, () => person) }, { people: [null] },
    { people: [person, person] }, { people: [{ ...person, name: ' ' }] },
    { schedules: null }, { schedules: Array.from({ length: 21 }, () => schedule) }, { schedules: [null] },
    { schedules: [{ ...schedule, time: '25:00' }] }, { schedules: [{ ...schedule, canvasIds: [] }] },
    { schedules: [{ ...schedule, timezone: 'not/a/timezone' }] }, { schedules: [schedule, schedule] },
    { calibratedActions: null }, { calibratedActions: 'file' }, { calibratedActions: ['invented'] }]) {
    expect(() => updatedJevSettings(previous, invalid as never)).toThrowError(expect.objectContaining({ status: 400 }));
  }
  expect(previous).toEqual(emptyJevWorkspace().settings);
});

it('keeps each mutation target and allowed field set distinct, including internal checked Undo', () => {
  const document: JevMutation = { kind: 'document', canvasId: 'canvas', blockId: 'doc', patch: { group: 'custom:engineering' } };
  const mutations: JevMutation[] = [document, { kind: 'move', canvasId: 'canvas', blockId: 'doc', targetCanvasId: 'destination' },
    { kind: 'content', canvasId: 'canvas', blockId: 'doc', content: '# New', expectedContentHash: 'saved-hash', draftId: 'draft' },
    { kind: 'derived', values: { role: 'specification' } }, { kind: 'derived', blockId: 'doc', values: {} },
    { kind: 'task_create', canvasId: 'canvas', task: { title: 'Deliver', detail: 'Review delivery' } },
    { kind: 'task_create', canvasId: 'canvas', task: { id: 'task', title: 'Deliver', detail: 'Review delivery' } },
    { kind: 'task_update', canvasId: 'canvas', taskId: 'task', expectedUpdatedAt: '2026-10-03', patch: { status: 'done' } },
    { kind: 'task_delete', canvasId: 'canvas', taskId: 'task', expectedUpdatedAt: '2026-10-03' }];
  for (const mutation of mutations) expect(() => validateMutation(mutation)).not.toThrow();
  expect(new Set(mutations.map(mutationIdentity)).size).toBe(mutations.length);
  const task = { kind: 'task_create', canvasId: 'canvas', task: { title: 'Deliver', detail: 'Review', revision: 2 } };
  expect(() => validateMutation(task as never)).toThrowError(expect.objectContaining({ status: 400 }));
  expect(() => validateMutation(task as never, true)).not.toThrow();
  for (const mutation of [null, { kind: 'unknown', canvasId: 'canvas' }, { ...document, canvasId: '../outside' },
    { ...document, patch: { content: '# Unauthorized' } }, { kind: 'derived', values: null },
    ...[4, 'x'.repeat(1_000_001)].map(content => ({ kind: 'content', canvasId: 'canvas', blockId: 'doc', content, expectedContentHash: 'hash' })),
    { kind: 'content', canvasId: 'canvas', blockId: 'doc', content: '# New', expectedContentHash: 4 },
    { kind: 'task_delete', canvasId: 'canvas', taskId: 'task' },
    { kind: 'task_update', canvasId: 'canvas', taskId: 'task', expectedUpdatedAt: 'now', patch: { id: 'other' } }]) {
    expect(() => validateMutation(mutation as never)).toThrowError(expect.objectContaining({ status: 400 }));
  }
});

const root: JevVocabularyTerm = { id: 'engineering', name: 'Engineering', kind: 'group', groupKey: 'custom:engineering',
  definition: 'Engineering source material', aliases: [], members: [], state: 'active', version: 1 };
const child: JevVocabularyTerm = { ...root, id: 'backend', name: 'Backend', parentId: root.id, groupKey: 'custom:engineering/backend' };
it('guards native hierarchy parent identity, cycles, collisions and checked removal', () => {
  expect(() => checkVocabularyMutation([], { kind: 'vocabulary', operation: 'define', term: root })).not.toThrow();
  expect(() => checkVocabularyMutation([root], { kind: 'vocabulary', operation: 'define', term: child })).not.toThrow();
  expect(mutationIdentity({ kind: 'vocabulary', operation: 'define', term: child, previousId: root.id })).not.toBe(
    mutationIdentity({ kind: 'vocabulary', operation: 'define', term: child }));
  const noPaths = [{ ...root, groupKey: undefined }, { ...child, groupKey: undefined }];
  expect(() => checkVocabularyMutation([noPaths[0]], { kind: 'vocabulary', operation: 'define', term: noPaths[1] })).not.toThrow();
  for (const [vocabulary, term] of [[[], child], [[{ ...root, state: 'retired' }], child], [[{ ...root, kind: 'label', groupKey: undefined }], child],
    [[root], { ...child, groupKey: 'custom:elsewhere/backend' }], [[root], { ...root, version: 1 }],
    [[root], { ...root, id: 'collision' }], [[root], { ...child, id: 'collision', groupKey: root.groupKey }],
    [[{ ...root, parentId: child.id }, child], { ...child, version: 2 }]] as Array<[JevVocabularyTerm[], JevVocabularyTerm]>) {
    expect(() => checkVocabularyMutation(vocabulary, { kind: 'vocabulary', operation: 'define', term })).toThrowError(expect.objectContaining({ status: 409 }));
  }
  expect(() => checkVocabularyMutation([], { kind: 'vocabulary', operation: 'remove', term: root })).toThrowError(expect.objectContaining({ status: 409 }));
  expect(() => checkVocabularyMutation([root], { kind: 'vocabulary', operation: 'remove', term: { ...root, definition: 'Changed' } })).toThrowError(expect.objectContaining({ status: 409 }));
  expect(() => checkVocabularyMutation([root, child], { kind: 'vocabulary', operation: 'remove', term: root })).toThrowError(expect.objectContaining({ status: 409 }));
  expect(() => checkVocabularyMutation([root, { ...child, state: 'retired' }], { kind: 'vocabulary', operation: 'remove', term: root })).not.toThrow();
  expect(() => checkVocabularyMutation([], { kind: 'vocabulary', operation: 'define', term: { ...root, kind: 'label' } })).toThrowError(expect.objectContaining({ status: 400 }));
  expect(() => checkVocabularyMutation([{ ...root, kind: 'entity', groupKey: undefined }], { kind: 'vocabulary', operation: 'define', term: child })).toThrowError(expect.objectContaining({ status: 409 }));
});
