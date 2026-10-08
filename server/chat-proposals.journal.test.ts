import { expectRestoredCanvas } from './tests/restoration.js';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { CanvasStore } from './storage.js';
import { ChatProposalDraft, applyChatProposal, getChatProposal, undoChatProposal } from './chat-proposals.js';

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'symbi-proposal-journal-'));
  roots.push(root);
  const store = new CanvasStore(root);
  await store.init();
  const canvas = await store.getCanvas('product-roadmap');
  const draft = new ChatProposalDraft(store, canvas.id, canvas);
  draft.patch('launch-checklist', { content: '# Reviewed' }, 'edit');
  const proposal = draft.publish()!;
  const file = path.join(root, 'chat-proposals', `${proposal.id}.json`);
  return { store, canvas, proposal, file };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

type Field = string | number;
type Corruption = [string, Field[], unknown];
function replace(value: unknown, fields: Field[], replacement: unknown): unknown {
  if (!fields.length) return replacement;
  let object = value as Record<Field, unknown>;
  for (const field of fields.slice(0, -1)) object = object[field] as Record<Field, unknown>;
  object[fields.at(-1)!] = replacement;
  return value;
}
const change = ['proposal', 'changes', 0];
const before = [...change, 'before'];
const after = [...change, 'after'];
const pendingCorruptions: Corruption[] = [
  ['null root', [], null], ['array root', [], []], ['wrong version', ['version'], 2],
  ['nonfinite expiry', ['expires'], null], ['unknown state', ['kind'], 'unknown'],
  ['missing proposal', ['proposal'], null], ['missing changes', ['proposal', 'changes'], null],
  ['empty changes', ['proposal', 'changes'], []], ['non-object change', ['proposal', 'changes'], [null]],
  ['wrong proposal id', ['proposal', 'id'], 'another'], ['wrong status', ['proposal', 'status'], 'applied'],
  ['wrong canvas id', ['proposal', 'canvasId'], 3], ['wrong expiry type', ['proposal', 'expiresAt'], 3],
  ['invalid expiry text', ['proposal', 'expiresAt'], 'yesterday'],
  ['wrong change id', [...change, 'id'], 3], ['wrong block id', [...change, 'blockId'], 'another'],
  ['wrong change title', [...change, 'title'], 3], ['wrong change type', [...change, 'type'], 'archive'],
  ['invalid before snapshot', before, false], ['invalid after snapshot', after, false],
  ['wrong before id', [...before, 'id'], 'another'], ['wrong after id', [...after, 'id'], 'another'],
  ['wrong applicability', [...change, 'canApply'], false],
  ['wrong content hash', [...change, 'expectedContentHash'], 'bad'],
  ['wrong state hash', [...change, 'expectedStateHash'], 'bad'],
  ['wrong title type', [...after, 'title'], {}], ['wrong content type', [...after, 'content'], 3],
  ['missing content', [...after, 'content'], undefined], ['wrong file type', [...after, 'file'], []],
  ['invalid geometry', [...after, 'x'], null], ['wrong content digest', [...after, 'contentHash'], 'bad'],
  ['missing links', [...after, 'links'], undefined], ['invalid link', [...after, 'links'], [3]],
  ['wrong kind', [...after, 'kind'], 'unknown'], ['missing kind', [...after, 'kind'], undefined],
];
const document = ['receipt', 'documents', 0];
const appliedCorruptions: Corruption[] = [
  ['missing receipt', ['receipt'], null], ['wrong canvas', ['canvasId'], 2], ['wrong id', ['receipt', 'id'], 'another'],
  ['wrong status', ['receipt', 'status'], 'pending'], ['wrong applied list', ['receipt', 'applied'], null],
  ['wrong applied id', ['receipt', 'applied'], [3]], ['wrong skipped list', ['receipt', 'skipped'], null],
  ['invalid skipped item', ['receipt', 'skipped'], [null]],
  ['invalid skipped id', ['receipt', 'skipped'], [{ id: 3, reason: 'Failed' }]],
  ['invalid skipped reason', ['receipt', 'skipped'], [{ id: 'launch-checklist', reason: 3 }]],
  ['wrong documents list', ['receipt', 'documents'], null], ['invalid document', document, null],
  ['invalid document id', [...document, 'id'], 3], ['invalid before', [...document, 'before'], false],
  ['invalid after', [...document, 'after'], false], ['wrong created ids', ['receipt', 'createdBlockIds'], []],
  ['wrong created id value', ['receipt', 'createdBlockIds'], { draft: 3 }],
];

describe('persisted Chat proposal validation', () => {
  it.each(pendingCorruptions)('refuses pending corruption: %s', async (_name, fields, value) => {
    const { store, canvas, proposal, file } = await fixture();
    const state = replace(JSON.parse(await readFile(file, 'utf8')), fields, value);
    await writeFile(file, JSON.stringify(state));
    await expect(applyChatProposal(store, proposal.id)).rejects.toMatchObject({ status: 410 });
    expect(await store.getCanvas(canvas.id)).toEqual(canvas);
  });

  it.each(appliedCorruptions)('refuses applied corruption: %s', async (_name, fields, value) => {
    const { store, canvas, proposal, file } = await fixture();
    await applyChatProposal(store, proposal.id);
    const applied = await store.getCanvas(canvas.id);
    const state = replace(JSON.parse(await readFile(file, 'utf8')), fields, value);
    await writeFile(file, JSON.stringify(state));
    await expect(undoChatProposal(store, proposal.id)).rejects.toMatchObject({ status: 410 });
    expect(await store.getCanvas(canvas.id)).toEqual(applied);
  });

  it('rejects duplicate persisted changes and a missing journal without writing', async () => {
    const { store, canvas, proposal, file } = await fixture();
    const state = JSON.parse(await readFile(file, 'utf8'));
    state.proposal.changes.push(state.proposal.changes[0]);
    await writeFile(file, JSON.stringify(state));
    expect(() => getChatProposal(store, proposal.id)).toThrow(/no longer available/);
    await rm(file);
    await expect(applyChatProposal(store, proposal.id)).rejects.toMatchObject({ status: 410 });
    expect(await store.getCanvas(canvas.id)).toEqual(canvas);
  });

  it('keeps traversal ids outside the journal directory and expires journals on read', async () => {
    const { store, proposal, file } = await fixture();
    expect(() => getChatProposal(store, '../canvases/product-roadmap')).toThrow(/no longer available/);
    await expect(applyChatProposal(store, 'not-a-uuid')).rejects.toMatchObject({ status: 410 });
    const state = JSON.parse(await readFile(file, 'utf8'));
    state.expires = Date.now() - 1;
    await writeFile(file, JSON.stringify(state));
    expect(() => getChatProposal(store, proposal.id)).toThrow(/expired/);
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('accepts snapshots without an optional content digest and persists a private journal', async () => {
    const { store, proposal, file } = await fixture();
    const state = JSON.parse(await readFile(file, 'utf8'));
    delete state.proposal.changes[0].before.contentHash;
    delete state.proposal.changes[0].after.contentHash;
    await writeFile(file, JSON.stringify(state));
    expect(getChatProposal(store, proposal.id)).toMatchObject({ status: 'pending' });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await applyChatProposal(store, proposal.id)).toMatchObject({ status: 'applied' });
  });

  it('requires a fresh proposal when its persisted state uses a noncanonical hash', async () => {
    const { store, canvas, proposal, file } = await fixture();
    const state = JSON.parse(await readFile(file, 'utf8'));
    const before = { ...state.proposal.changes[0].before };
    delete before.contentHash;
    delete before.lock;
    state.proposal.changes[0].expectedStateHash = createHash('sha256').update(JSON.stringify(before)).digest('hex').slice(0, 16);
    await writeFile(file, JSON.stringify(state));
    const restarted = new CanvasStore(store.root);
    await restarted.init();
    await expect(applyChatProposal(restarted, proposal.id)).rejects.toMatchObject({ status: 410 });
    expectRestoredCanvas(await restarted.getCanvas(canvas.id), canvas);
  });

  it('safely refuses Undo when a receipt has a null after snapshot', async () => {
    const { store, canvas, proposal, file } = await fixture();
    await applyChatProposal(store, proposal.id);
    const applied = await store.getCanvas(canvas.id);
    const state = JSON.parse(await readFile(file, 'utf8'));
    state.receipt.documents[0].after = null;
    await writeFile(file, JSON.stringify(state));
    expect(getChatProposal(store, proposal.id)).toMatchObject({ documents: [{ after: null }] });
    await expect(undoChatProposal(store, proposal.id)).rejects.toMatchObject({ status: 409,
      conflicts: [{ id: '', reason: 'Document changed since apply' }] });
    expect(await store.getCanvas(canvas.id)).toEqual(applied);
  });
});
