import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { atomicJson } from '../storage-files.js';
import { storedBlock, type StoredCanvas } from '../storage-shapes.js';
import { JEV_QUESTION_VERSION } from './actions.js';
import { queueBoundaryFixture, type QueueBoundaryFixture } from './queue-boundary.test.fixture.js';
import { initializeJevStamp, sourceSnapshot } from './stamps.js';

let native: QueueBoundaryFixture;
beforeEach(async () => {
  native = await queueBoundaryFixture();
  await native.store.updateBlock(native.otherCanvasId, native.secondary.id, { processingExcluded: true }, 'Browser');
  const primary = await native.store.getCanvasBlock(native.canvasId, native.primary.id);
  const blocks = [primary, ...Array.from({ length: 157 }, (_, index) => initializeJevStamp({
    ...primary, id: `completed-source-${index}`, file: `docs/completed-source-${index}.md`,
    incarnation: undefined, sourceGeneration: undefined, metadataRevision: undefined, jevOwnership: undefined,
    title: `Completed Atlas ${index}`, content: `# Atlas ${index}\nChecked rollout requirement ${index}.`,
  }))];
  await Promise.all(blocks.slice(1).map(block => writeFile(path.join(native.root, block.file), block.content)));
  const file = path.join(native.root, 'canvases', `${native.canvasId}.json`);
  const canvas = JSON.parse(await readFile(file, 'utf8')) as StoredCanvas;
  await atomicJson(file, { ...canvas, blocks: blocks.map(storedBlock) });
  const state = await native.files.read(native.workspaceId);
  state.profiles = Object.fromEntries(blocks.map(block => [`${native.canvasId}:${block.id}`, {
    source: { ...sourceSnapshot(native.workspaceId, native.canvasId, block) },
    questionVersion: JEV_QUESTION_VERSION, profileConfidenceThreshold: 0.7,
  }]));
  await native.files.write(native.workspaceId, state);
  await native.followups.resume(native.workspaceId, { action: 'profile', canvasId: native.canvasId }, [], 'completed-native-pass');
});
afterEach(async () => { await native.close(); });

it('checks a completed 158-document maintenance pass with one fresh organization snapshot', async () => {
  const before = await native.files.read(native.workspaceId);
  let contextReads = 0;
  let stateReads = 0;
  const readState = native.files.read.bind(native.files);
  native.files.read = async id => { stateReads += 1; return readState(id); };
  const getCanvas = native.store.getCanvas.bind(native.store);
  native.store.getCanvas = async (id, archived, labels) => {
    if (archived === true && labels === false) contextReads += 1;
    return getCanvas(id, archived, labels);
  };
  await native.maintenance.reconcile(await native.workspace());
  expect(contextReads).toBe(2);
  expect(stateReads).toBeLessThanOrEqual(10);
  expect(await native.files.read(native.workspaceId)).toEqual(before);
  const fresh = await getCanvas(native.canvasId, true, false);
  expect(fresh.blocks).toHaveLength(158);
  expect(fresh.blocks.every(block => block.content.includes('Atlas'))).toBe(true);
  stateReads = 0;
  await native.maintenance.reconcile(await native.workspace());
  expect(contextReads).toBe(4);
  expect(stateReads).toBeLessThanOrEqual(10);
  expect(await native.files.read(native.workspaceId)).toEqual(before);
});
