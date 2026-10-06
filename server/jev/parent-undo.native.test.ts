import { mkdtemp, readdir, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CanvasBlock } from '../../shared/types.js';
import type { JevPrincipal } from '../../shared/jev-types.js';
import { CanvasStore } from '../storage.js';
import { JevRuntime } from './runtime.js';
import { recoverParentUndos, withCausalParentUndo } from './parent-undo.js';
import { JevWorkspaceFiles } from './workspace.js';

const owner: JevPrincipal = { id: 'owner', kind: 'user', access: 'write', canApprove: true, canConfigure: true };
let root: string; let store: CanvasStore; let runtime: JevRuntime; let workspaceId: string; let canvasId: string; let block: CanvasBlock;
beforeEach(async () => {
  vi.stubEnv('TYPESAFE_API_KEY', '');
  root = await mkdtemp(path.join(tmpdir(), 'reflex-parent-native-'));
  store = new CanvasStore(root); await store.init();
  workspaceId = (await store.createWorkspace({ name: 'Undo workspace' })).id;
  canvasId = (await store.createCanvas(workspaceId, { name: 'Causal sources' })).id;
  block = await store.createBlock(canvasId, { title: 'Atlas', content: '# Atlas source' });
  // These fixtures exercise parent compensation; only the explicit checked mutation needs a provider.
  runtime = new JevRuntime(store, { startTimer: false, evaluate: async context => {
    context.apiKey = 'explicit-native-evaluator';
    const document = context.documents.find(item => item.block.id === block.id)!;
    return { result: {}, proposals: [{ action: 'file', title: 'Organize', explanation: 'Exact source', confidence: 0.99,
      evidence: [{ source: document.snapshot, quote: '# Atlas', start: 0, end: 7 }], sources: [document.snapshot],
      mutation: { kind: 'document', canvasId, blockId: block.id, patch: { group: 'custom:atlas', tags: ['atlas'], headline: 'Atlas source' } } }] };
  } });
  await runtime.configure(workspaceId, { externalProcessing: true, modes: { file: 'auto' } as never }, owner);
  await runtime.run(workspaceId, { action: 'file', canvasId, blockIds: [block.id] }, owner); await runtime.idle();
});
afterEach(async () => { runtime.close(); await runtime.idle().catch(() => undefined); await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });

it('compensates extractive labels and headlines whose original optional fields were absent before created-parent Undo', async () => {
  expect((await store.getCanvasBlock(canvasId, block.id))).toMatchObject({ group: 'custom:atlas', tags: ['atlas'], headline: 'Atlas source' });
  await runtime.undoParent(workspaceId, canvasId, { kind: 'created', after: block }, owner);
  expect((await store.getCanvas(canvasId, true)).blocks).toEqual([]);
});
it('rolls back causal compensation when the native parent guard rejects, preserving generation and advancing metadata', async () => {
  const organized = await store.getCanvasBlock(canvasId, block.id);
  await expect(withCausalParentUndo(store, workspaceId, canvasId, [{ kind: 'created', after: block }], owner,
    () => store.deleteBlock(canvasId, block.id, 'Browser', { expectedDocumentState: 'obsolete' }))).rejects.toMatchObject({ status: 409 });
  const restored = await new CanvasStore(root).getCanvasBlock(canvasId, block.id);
  expect(restored).toMatchObject({ group: organized.group, tags: organized.tags, headline: organized.headline,
    incarnation: organized.incarnation, sourceGeneration: organized.sourceGeneration });
  expect(restored.metadataRevision).toBeGreaterThan(organized.metadataRevision!);
  expect((await runtime.read(workspaceId, owner)).receipts[0].state).toBe('applied');
  expect(await readdir(path.join(root, 'jev', 'parent-undo'))).toEqual([]);
});
async function crashAt(stage: 'compensated' | 'parent_written'): Promise<void> {
  const storageUrl = pathToFileURL(path.resolve('server/storage.ts')).href;
  const parentUrl = pathToFileURL(path.resolve('server/jev/parent-undo.ts')).href;
  const script = `import {CanvasStore} from ${JSON.stringify(storageUrl)}; import {withCausalParentUndo} from ${JSON.stringify(parentUrl)};
    const store=new CanvasStore(${JSON.stringify(root)}); await store.init();
    await withCausalParentUndo(store,${JSON.stringify(workspaceId)},${JSON.stringify(canvasId)},[{kind:'created',after:${JSON.stringify(block)}}],${JSON.stringify(owner)},async()=>{
      if (${JSON.stringify(stage)}==='parent_written') await store.deleteBlock(${JSON.stringify(canvasId)},${JSON.stringify(block.id)},'Browser',{requireUnreferenced:true});
      process.stdout.write('BOUNDARY\\n'); await new Promise(()=>{setInterval(()=>{},1000)});
    });`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise<void>((resolve, reject) => {
    let error = ''; child.stderr.on('data', value => { error += value; });
    child.stdout.on('data', value => { if (String(value).includes('BOUNDARY')) resolve(); });
    child.once('exit', code => reject(new Error(`Boundary child exited ${code}: ${error}`)));
  });
  child.kill('SIGKILL'); await new Promise<void>(resolve => child.once('exit', () => resolve()));
}
it('recovers a real process kill after compensation without performing the interrupted parent deletion', async () => {
  const organized = await store.getCanvasBlock(canvasId, block.id);
  await crashAt('compensated');
  expect((await store.getCanvasBlock(canvasId, block.id)).group).toBeUndefined();
  await recoverParentUndos(new CanvasStore(root), workspaceId);
  const recovered = await store.getCanvasBlock(canvasId, block.id);
  expect(recovered.group).toBe(organized.group); expect(recovered.tags).toEqual(organized.tags);
  expect(recovered.metadataRevision).toBeGreaterThan(organized.metadataRevision!);
  expect((await runtime.read(workspaceId, owner)).receipts[0].state).toBe('applied');
});
it('recognizes a completed native deletion after a real kill before its completion record and does not resurrect content', async () => {
  await crashAt('parent_written');
  await recoverParentUndos(new CanvasStore(root), workspaceId);
  expect((await store.getCanvas(canvasId, true)).blocks).toEqual([]);
  const state = await new JevWorkspaceFiles(root).read(workspaceId);
  expect(state.receipts[0].state).toBe('undone');
  expect(await readdir(path.join(root, 'jev', 'parent-undo'))).toEqual([]);
});
it.each(['{', JSON.stringify({ schemaVersion: 1, parents: [] })])('rejects a corrupt recovery journal without altering saved metadata', async raw => {
  const before = await store.getCanvasBlock(canvasId, block.id);
  const directory = path.join(root, 'jev', 'parent-undo'); await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `${randomUUID()}.json`), raw);
  await expect(recoverParentUndos(store, workspaceId)).rejects.toMatchObject({ status: 503 });
  expect(await store.getCanvasBlock(canvasId, block.id)).toEqual(before);
});

it('recognizes an edited browser parent after a kill, including native absent-field restoration defaults', async () => {
  const before = await store.getCanvasBlock(canvasId, block.id);
  const after = await store.updateBlock(canvasId, block.id, { content: '# Atlas edited source' }, 'Symbi');
  await runtime.run(workspaceId, { action: 'file', canvasId, blockIds: [block.id] }, owner); await runtime.idle();
  const storageUrl = pathToFileURL(path.resolve('server/storage.ts')).href;
  const parentUrl = pathToFileURL(path.resolve('server/jev/parent-undo.ts')).href;
  const stampsUrl = pathToFileURL(path.resolve('server/jev/stamps.ts')).href;
  const script = `import {CanvasStore} from ${JSON.stringify(storageUrl)};import {withCausalParentUndo,browserUndoDefaults} from ${JSON.stringify(parentUrl)};import{initializeJevStamp}from ${JSON.stringify(stampsUrl)};
    const store=new CanvasStore(${JSON.stringify(root)});await store.init(); const before=${JSON.stringify(before)};const after=${JSON.stringify(after)};
    await withCausalParentUndo(store,${JSON.stringify(workspaceId)},${JSON.stringify(canvasId)},[{kind:'edited',before,after}],${JSON.stringify(owner)},async()=>{
      const patch={...before}; for(const [key,value]of Object.entries(browserUndoDefaults))patch[key]=patch[key]??value;
      await store.updateBlock(${JSON.stringify(canvasId)},before.id,patch,'Browser');
      await store.jevExecutor.setOwnership(${JSON.stringify(canvasId)},before.id,initializeJevStamp(before).jevOwnership);
      process.stdout.write('BOUNDARY\\n');await new Promise(()=>{setInterval(()=>{},1000)});
    },{actor:'Browser'});`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise<void>((resolve, reject) => {
    let error = ''; child.stderr.on('data', value => { error += value; });
    child.stdout.on('data', value => { if (String(value).includes('BOUNDARY')) resolve(); });
    child.once('exit', code => reject(new Error(`Edited boundary child exited ${code}: ${error}`)));
  });
  child.kill('SIGKILL'); await new Promise<void>(resolve => child.once('exit', () => resolve()));
  await recoverParentUndos(new CanvasStore(root), workspaceId);
  const recovered = await store.getCanvasBlock(canvasId, block.id);
  expect(recovered).toMatchObject({ content: before.content, tags: before.tags, archived: false, stale: false });
  expect(recovered.sourceGeneration).toBeGreaterThan(after.sourceGeneration!);
  expect(await readdir(path.join(root, 'jev', 'parent-undo'))).toEqual([]);
});
