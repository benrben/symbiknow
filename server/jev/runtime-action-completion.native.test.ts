import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { JevPrincipal } from '../../shared/jev-types.js';
import { CanvasStore } from '../storage.js';
import { atomicJson } from '../storage-files.js';
import { automationPrincipal } from './authorization.js';
import { JevRuntime } from './runtime.js';
import { JevWorkspaceFiles } from './workspace.js';

const owner: JevPrincipal = { id: 'owner', kind: 'user', access: 'write', canApprove: true, canConfigure: true };
const opened: Array<{ root: string; runtime: JevRuntime }> = [];
afterEach(async () => {
  for (const { root, runtime } of opened.splice(0)) { await runtime.shutdown(); await rm(root, { recursive: true, force: true }); }
  vi.unstubAllEnvs();
});

it.each([owner, automationPrincipal])('persists checked analysis while holding a canonical mutation without a configured provider for $kind', async principal => {
  vi.stubEnv('TYPESAFE_API_KEY', '');
  const root = await mkdtemp(path.join(tmpdir(), 'jev-mixed-completion-'));
  await atomicJson(path.join(root, 'workspaces.json'), []);
  const store = new CanvasStore(root); await store.init();
  const workspace = await store.createWorkspace({ name: 'Checked completion' });
  const canvas = await store.createCanvas(workspace.id, { name: 'Sources' });
  const source = await store.createBlock(canvas.id, { title: 'Release process', content: '# Release process\nChecked deployment evidence.' });
  const before = await store.getCanvasBlock(canvas.id, source.id);
  const runtime = new JevRuntime(store, { apiKey: '', startTimer: false, documentExecution: false,
    evaluate: async (context, request) => {
      const document = context.documents.find(document => document.block.id === source.id)!;
      const evidence = [{ source: document.snapshot, start: 0, end: document.block.content.length, quote: document.block.content }];
      const common = { action: request.action, explanation: 'Retained source-backed analysis and suggested organization', sources: [document.snapshot], evidence, confidence: .99 };
      return { result: { status: 'reviewed' }, proposals: [
        { ...common, title: 'Checked analysis', mutation: { kind: 'derived', blockId: source.id, values: { checkedSubject: 'Release process' } } },
        { ...common, title: 'Suggested membership', mutation: { kind: 'document', canvasId: canvas.id, blockId: source.id, patch: { group: 'custom:release' } } },
      ] };
    } });
  opened.push({ root, runtime });
  const settings = (await runtime.read(workspace.id, owner)).settings;
  await runtime.configure(workspace.id, { modes: { ...settings.modes, file: 'auto' } }, owner);
  const job = await runtime.run(workspace.id, { action: 'file', canvasId: canvas.id, blockIds: [source.id] }, principal);
  await runtime.idle();
  const state = await new JevWorkspaceFiles(root).read(workspace.id);
  expect(state.jobs.find(item => item.id === job.id)).toMatchObject({ state: 'completed', result: { status: 'reviewed' } });
  expect(state.profiles[`${canvas.id}:${source.id}`]).toMatchObject({ checkedSubject: 'Release process' });
  const analysis = state.proposals.find(proposal => proposal.mutation.kind === 'derived')!;
  expect(analysis.state).toBe('applied');
  expect(state.receipts).toMatchObject([{ proposalId: analysis.id, actor: automationPrincipal.id, automatic: true, after: { kind: 'derived' } }]);
  expect(state.proposals.find(proposal => proposal.mutation.kind === 'document')).toMatchObject({
    state: principal.kind === 'automation' ? 'dismissed' : 'pending', automaticHoldReason: 'A configured processing provider is required',
  });
  expect(await new CanvasStore(root).getCanvasBlock(canvas.id, source.id)).toEqual(before);
});
