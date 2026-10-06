import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CanvasTask } from '../shared/types.js';
import { claimedTask, commentedTask, DocumentLocks, newTask, patchedTask } from './coordination.js';
import { ApiError } from './errors.js';

const known = new Set(['one', 'two']);
const tasks = new Set(['dependency']);
const reference = { claim: 'The plan needs review', passage: 'Review before launch.', passageKind: 'exact', canvasId: 'canvas', documentId: 'one',
  checkedAt: '2026-10-01T00:00:00Z', navigation: { kind: 'document', canvasId: 'canvas', blockId: 'one' } };
const finding = { id: 'finding', title: 'Review the plan', canvasId: 'canvas', blockIds: ['one'] };
function create(input: Record<string, unknown> = {}) { return newTask({ title: 'Review', ...input }, 'Creator', known, tasks); }
function assertInvalid(input: Record<string, unknown>, message: string) {
  expect(() => create(input)).toThrow(new ApiError(400, message));
}
afterEach(() => vi.useRealTimers());

describe('task coordination requests', () => {
  it('creates a default task and keeps explicit empty optional fields valid', () => {
    expect(newTask({ title: ' Review ' }, 'Creator', known)).toMatchObject({ title: 'Review', detail: '', status: 'todo', blockIds: [], comments: [], createdBy: 'Creator', updatedBy: 'Creator' });
    const task = create({ detail: '', assignee: null, dueDate: '', dependsOnTaskIds: [], blockIds: ['one', 'one'], findingRef: finding });
    expect(task).toMatchObject({ detail: '', blockIds: ['one'], dependsOnTaskIds: [], findingRef: finding });
    expect(task.assignee).toBeUndefined(); expect(task.dueDate).toBeUndefined();
  });

  it('records supplied labels, planning fields, and a complete finding trail', () => {
    const richFinding = { ...finding, detail: ' Details ', suggestedOwner: ' Reviewer ', investigationId: ' investigation ',
      evidence: [{ questionId: ' question ', answer: ' yes ', excerpt: ' quote ', sourceIds: ['one'], sourceHashes: { one: 'abc' } }],
      references: [{ ...reference, passageKind: 'approximation', passageLabel: ' Approximate context ', documentTitle: ' Plan ', contentHash: ' hash ', revision: ' revision ' }] };
    const task = create({ detail: ' Details ', status: 'blocked', assignee: ' Reviewer ', dueDate: '2028-02-29', dependsOnTaskIds: ['dependency'], blockIds: ['one'], findingRef: richFinding });
    expect(task).toMatchObject({ detail: 'Details', status: 'blocked', assignee: 'Reviewer', dueDate: '2028-02-29', dependsOnTaskIds: ['dependency'],
      findingRef: { id: 'finding', detail: 'Details', suggestedOwner: 'Reviewer', investigationId: 'investigation',
        evidence: [{ questionId: 'question', answer: 'yes', excerpt: 'quote', sourceIds: ['one'], sourceHashes: { one: 'abc' } }],
        references: [{ ...reference, passageKind: 'approximation', passageLabel: 'Approximate context', documentTitle: 'Plan', contentHash: 'hash', revision: 'revision', checkedAt: '2026-10-01T00:00:00.000Z' }] } });
  });

  it('accepts minimal evidence, exact references, and an unset suggested owner', () => {
    const task = create({ findingRef: { ...finding, suggestedOwner: '', evidence: [{ questionId: 'q', answer: '', excerpt: '' }], references: [reference] } });
    expect(task.findingRef?.evidence).toEqual([{ questionId: 'q', answer: '', excerpt: '' }]);
    expect(task.findingRef?.references?.[0]).toMatchObject({ passageKind: 'exact', checkedAt: '2026-10-01T00:00:00.000Z' });
    expect(task.findingRef?.suggestedOwner).toBeUndefined();
  });

  it.each([
    [{ title: 12 }, 'title must be a nonempty string of at most 160 characters'],
    [{ title: 'x'.repeat(161) }, 'title must be a nonempty string of at most 160 characters'],
    [{ title: '  ' }, 'title must be a nonempty string of at most 160 characters'],
    [{ detail: 12 }, 'detail must be a string of at most 4000 characters'],
    [{ status: 'unknown' }, 'status must be todo, in_progress, blocked, or done'],
    [{ assignee: {} }, 'assignee must be a short name'],
    [{ blockIds: null }, 'blockIds must list up to 20 documents on this canvas'],
    [{ blockIds: Array(21).fill('one') }, 'blockIds must list up to 20 documents on this canvas'],
    [{ blockIds: [42] }, 'blockIds must list up to 20 documents on this canvas'],
    [{ blockIds: ['missing'] }, 'blockIds must list up to 20 documents on this canvas'],
    [{ dependsOnTaskIds: null }, 'dependsOnTaskIds must list distinct existing tasks on this canvas'],
    [{ dependsOnTaskIds: Array(21).fill('dependency') }, 'dependsOnTaskIds must list distinct existing tasks on this canvas'],
    [{ dependsOnTaskIds: [42] }, 'dependsOnTaskIds must list distinct existing tasks on this canvas'],
    [{ dependsOnTaskIds: ['missing'] }, 'dependsOnTaskIds must list distinct existing tasks on this canvas'],
    [{ dependsOnTaskIds: ['dependency', 'dependency'] }, 'dependsOnTaskIds must list distinct existing tasks on this canvas'],
  ])('rejects malformed task fields: %j', (input, message) => assertInvalid(input, message));

  it.each([12, '2026/10/01', '9999-99-99', '2026-02-30'])('rejects an invalid due date: %j', dueDate => {
    assertInvalid({ dueDate }, 'dueDate must be a valid YYYY-MM-DD date');
  });

  it.each([null, 12, []])('rejects a malformed finding: %j', findingRef => {
    assertInvalid({ findingRef }, 'findingRef must identify a finding');
  });

  it.each([null, {}, Array(13).fill({})])('rejects a malformed evidence list: %j', evidence => {
    assertInvalid({ findingRef: { ...finding, evidence } }, 'findingRef.evidence must contain up to 12 evidence items');
  });

  it.each([null, 12, []])('rejects a malformed evidence item: %j', evidence => {
    assertInvalid({ findingRef: { ...finding, evidence: [evidence] } }, 'findingRef.evidence[0] must be an object');
  });

  it.each([null, 12, []])('rejects malformed source hashes: %j', sourceHashes => {
    assertInvalid({ findingRef: { ...finding, evidence: [{ questionId: 'q', answer: '', excerpt: '', sourceHashes }] } }, 'findingRef evidence sourceHashes must be an object');
  });

  it.each([Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`id-${i}`, 'hash'])), { missing: 'hash' }, { one: 42 }, { one: 'x'.repeat(129) }])
    ('rejects invalid hash sources: %j', sourceHashes => {
      assertInvalid({ findingRef: { ...finding, evidence: [{ questionId: 'q', answer: '', excerpt: '', sourceHashes }] } }, 'findingRef evidence sourceHashes must reference documents on this canvas');
    });

  it.each([null, {}, Array(13).fill({})])('rejects a malformed reference list: %j', references => {
    assertInvalid({ findingRef: { ...finding, references } }, 'findingRef.references must contain up to 12 references');
  });

  it.each([null, 12, []])('rejects a malformed reference item: %j', entry => {
    assertInvalid({ findingRef: { ...finding, references: [entry] } }, 'findingRef.references[0] must be an object');
  });

  it.each([undefined, null, 12, {}, { kind: 'canvas', blockId: 'one' }, { kind: 'document' }, { kind: 'document', blockId: 'missing' }])
    ('rejects invalid reference navigation: %j', navigation => {
      assertInvalid({ findingRef: { ...finding, references: [{ ...reference, navigation }] } }, 'findingRef evidence navigation must target a document on this canvas');
    });

  it.each([{ documentId: 'missing' }, { documentId: 'two' }, { canvasId: 'another' }])('rejects mismatched reference identities: %j', patch => {
    assertInvalid({ findingRef: { ...finding, references: [{ ...reference, ...patch }] } }, 'findingRef evidence navigation must match its document');
  });

  it('rejects unsupported provenance and invalid check dates', () => {
    assertInvalid({ findingRef: { ...finding, references: [{ ...reference, passageKind: 'unknown' }] } }, 'findingRef evidence passageKind must be exact or approximation');
    assertInvalid({ findingRef: { ...finding, references: [{ ...reference, checkedAt: 'invalid' }] } }, 'findingRef evidence checkedAt must be a date');
  });

  it('patches selected fields, preserves omitted values, and removes cleared planning fields', () => {
    const task = create({ detail: 'Original', status: 'todo', assignee: 'Owner', dueDate: '2026-10-01', dependsOnTaskIds: ['dependency'], blockIds: ['one', 'two'] });
    const unchanged = patchedTask(task, {}, 'Updater', new Set(['one']));
    expect(unchanged).toMatchObject({ title: 'Review', detail: 'Original', status: 'todo', assignee: 'Owner', dueDate: '2026-10-01', dependsOnTaskIds: ['dependency'], blockIds: ['one'] });
    const changed = patchedTask(task, { title: ' Updated ', detail: ' New ', status: 'in_progress', blockIds: ['two'], assignee: 'Next', dueDate: '2026-12-01', dependsOnTaskIds: [] }, 'Updater', known, tasks);
    expect(changed).toMatchObject({ title: 'Updated', detail: 'New', status: 'in_progress', blockIds: ['two'], assignee: 'Next', dueDate: '2026-12-01', dependsOnTaskIds: [], updatedBy: 'Updater' });
    expect(patchedTask(task, { assignee: '', dueDate: null }, 'Updater', known)).not.toHaveProperty('assignee');
    expect(patchedTask(task, { assignee: null, dueDate: '' }, 'Updater', known)).not.toHaveProperty('dueDate');
    expect(() => patchedTask(task, { dependsOnTaskIds: [task.id] }, 'Updater', known, new Set([task.id]))).toThrow('dependsOnTaskIds must list distinct existing tasks on this canvas');
  });

  it('claims unassigned tasks, preserves completed work, and requires force for an active owner', () => {
    const task = create();
    expect(claimedTask(task, 'Owner', false)).toMatchObject({ assignee: 'Owner', status: 'in_progress' });
    const claimed = claimedTask(task, 'Owner', false);
    expect(claimedTask(claimed, 'Owner', false).assignee).toBe('Owner');
    expect(() => claimedTask(claimed, 'Other', false)).toThrow('Owner already claimed this task');
    expect(claimedTask(claimed, 'Other', true).assignee).toBe('Other');
    expect(claimedTask({ ...claimed, status: 'done' }, 'Other', false)).toMatchObject({ assignee: 'Other', status: 'done' });
  });

  it('validates comments and retains the most recent hundred without mutating the original', () => {
    const task: CanvasTask = { ...create(), comments: Array.from({ length: 100 }, (_, i) => ({ author: 'Owner', text: `${i}`, createdAt: '2026-10-01' })) };
    expect(() => commentedTask(task, '', 'Reviewer')).toThrow('text must be a nonempty string');
    const updated = commentedTask(task, ' New comment ', 'Reviewer');
    expect(updated.comments).toHaveLength(100); expect(updated.comments[0].text).toBe('1');
    expect(updated.comments.at(-1)).toMatchObject({ author: 'Reviewer', text: 'New comment' });
    expect(task.comments[0].text).toBe('0');
  });
});

describe('document lease coordination', () => {
  it('renews leases, rejects conflicting owners, and allows explicit takeover and release', () => {
    const locks = new DocumentLocks();
    expect(locks.active('canvas', 'one')).toBeUndefined();
    locks.release('canvas', 'one', 'Owner', false); locks.check('canvas', 'one', 'Owner');
    expect(locks.acquire('canvas', 'one', 'Owner', {})).toMatchObject({ owner: 'Owner' });
    const renewed = locks.acquire('canvas', 'one', 'Owner', { ttlSeconds: 30, note: ' Editing ' });
    expect(renewed.note).toBe('Editing'); locks.check('canvas', 'one', 'Owner');
    expect(() => locks.acquire('canvas', 'one', 'Other', {})).toThrow('Owner is editing this document');
    expect(() => locks.check('canvas', 'one', 'Other')).toThrow('Owner is editing this document');
    expect(locks.acquire('canvas', 'one', 'Other', { force: true }).owner).toBe('Other');
    expect(() => locks.release('canvas', 'one', 'Owner', false)).toThrow('Other holds this document');
    locks.release('canvas', 'one', 'Owner', true); expect(locks.active('canvas', 'one')).toBeUndefined();
    locks.acquire('canvas', 'one', 'Owner', {}); locks.release('canvas', 'one', 'Owner', false);
    expect(locks.active('canvas', 'one')).toBeUndefined();
  });

  it.each([1.5, 29, 3601])('rejects an invalid lease duration: %j', ttlSeconds => {
    expect(() => new DocumentLocks().acquire('canvas', 'one', 'Owner', { ttlSeconds })).toThrow('ttlSeconds must be between 30 and 3600');
  });

  it('expires leases and transfers only active leases across canvases', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
    const locks = new DocumentLocks(); locks.acquire('canvas', 'one', 'Owner', { ttlSeconds: 30 });
    locks.move('canvas', 'target', 'one'); expect(locks.active('canvas', 'one')).toBeUndefined();
    expect(locks.active('target', 'one')?.owner).toBe('Owner');
    vi.advanceTimersByTime(30_000); expect(locks.active('target', 'one')).toBeUndefined();
    locks.move('canvas', 'target', 'one'); expect(locks.active('target', 'one')).toBeUndefined();
    locks.acquire('canvas', 'one', 'Owner', {}); locks.forget('canvas', 'one');
    expect(locks.active('canvas', 'one')).toBeUndefined();
  });
});
