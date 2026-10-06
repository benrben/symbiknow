import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { CanvasStore } from './storage.js';
import { ChatProposalDraft, applyChatProposal, getChatProposal, undoChatProposal } from './chat-proposals.js';
import { acceptanceReflexProvider } from '../features/acceptance-reflex-provider.js';
import { JevRuntime } from './jev/runtime.js';
import { JevWorkspaceFiles } from './jev/workspace.js';

async function providerFixture(): Promise<{ server: Server; origin: string }> {
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += String(chunk);
    const result = await acceptanceReflexProvider('https://api.typesafe.ai/v1/systemone', { method: 'POST', body });
    response.writeHead(result.status, { 'content-type': 'application/json' }); response.end(await result.text());
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing native provider address');
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'symbi-chat-boundary-'));
  const store = new CanvasStore(root); await store.init();
  await store.deleteWorkspace('acme-team');
  const workspace = await store.createWorkspace({ name: 'Checked Chat undo' });
  const canvas = await store.createCanvas(workspace.id, { name: 'Source' });
  const block = await store.createBlock(canvas.id, { title: 'Reviewed source', content: '# Before' });
  return { root, store, workspace, canvas, block };
}

it('refuses later manual metadata changes and undoes native automatic label enrichment after the exact reviewed position is restored', async () => {
  const { root, store, workspace, canvas, block } = await fixture();
  let provider: Awaited<ReturnType<typeof providerFixture>> | undefined;
  let runtime: JevRuntime | undefined;
  try {
    const draft = new ChatProposalDraft(store, canvas.id, await store.getCanvas(canvas.id));
    draft.patch(block.id, { content: '# After', x: undefined }, 'edit');
    const proposal = draft.publish()!;
    const receipt = await applyChatProposal(store, proposal.id);
    const after = receipt.documents[0].after!;
    await store.updateBlock(canvas.id, block.id, { x: after.x + 50 }, 'Human');
    const beforeUndo = await readFile(path.join(root, 'canvases', canvas.id + '.json'), 'utf8');
    await expect(undoChatProposal(store, proposal.id)).rejects.toMatchObject({ status: 409,
      conflicts: [{ id: block.id, reason: 'Document changed since apply' }] });
    expect(await readFile(path.join(root, 'canvases', canvas.id + '.json'), 'utf8')).toBe(beforeUndo);
    expect(getChatProposal(store, proposal.id)).toEqual(receipt);
    await store.updateBlock(canvas.id, block.id, { x: after.x }, 'Human');
    const files = new JevWorkspaceFiles(root); const saved = await files.read(workspace.id);
    saved.vocabulary.push({ id: 'after-label', kind: 'label', name: 'After', definition: 'The current revised source', aliases: [], state: 'active', version: 1, members: [] });
    await files.write(workspace.id, saved);
    provider = await providerFixture();
    const origin = provider.origin;
    runtime = new JevRuntime(store, { startTimer: false, apiKey: 'native-causal-label-key', fetcher: (_url, options) => fetch(origin, options) });
    const owner = { id: 'owner', kind: 'user', access: 'write', canApprove: true, canConfigure: true } as const;
    await runtime.idle();
    const labelReceipt = (await runtime.read(workspace.id, owner)).receipts.find(item => item.automatic && item.action === 'label' && item.after.kind === 'document');
    expect(labelReceipt?.state).toBe('applied');
    expect((await store.getCanvasBlock(canvas.id, block.id)).tags).toContain('After');
    runtime.close(); await runtime.idle();
    expect(await undoChatProposal(store, proposal.id)).toMatchObject({ status: 'reverted', reverted: [block.id] });
    expect(await new CanvasStore(root).getCanvasBlock(canvas.id, block.id)).toMatchObject({ content: '# Before' });
    expect((await store.getCanvasBlock(canvas.id, block.id)).tags).toBeUndefined();
    expect((await runtime.read(workspace.id, owner)).receipts.find(item => item.id === labelReceipt?.id)?.state).toBe('undone');
  } finally {
    if (runtime) { runtime.close(); await runtime.idle(); }
    if (provider) { provider.server.closeAllConnections(); await new Promise<void>(resolve => provider!.server.close(() => resolve())); }
    await rm(root, { recursive: true, force: true });
  }
});

it('keeps a native Undo receipt partial when an outside deletion removes its document during the Git save boundary', async () => {
  const { root, store, canvas, block } = await fixture();
  try {
    const draft = new ChatProposalDraft(store, canvas.id, await store.getCanvas(canvas.id));
    draft.patch(block.id, { content: '# After' }, 'edit');
    const proposal = draft.publish()!; await applyChatProposal(store, proposal.id);
    const file = path.join(root, 'canvases', canvas.id + '.json');
    const source = path.join(root, block.file);
    const hook = path.join(root, '.versions', block.id, '.git', 'hooks', 'post-commit');
    await writeFile(hook, '#!/usr/bin/env node\nconst fs=require("node:fs");\n' +
      `const file=${JSON.stringify(file)};const data=JSON.parse(fs.readFileSync(file,"utf8"));` +
      `data.blocks=data.blocks.filter(block=>block.id!==${JSON.stringify(block.id)});fs.writeFileSync(file,JSON.stringify(data));\n` +
      `fs.unlinkSync(${JSON.stringify(source)});fs.mkdirSync(${JSON.stringify(source)});\n`, { mode: 0o755 });
    const result = await undoChatProposal(store, proposal.id);
    expect(result).toMatchObject({ status: 'partial', reverted: [], skipped: [{ id: block.id, reason: expect.any(String) }] });
    expect((await new CanvasStore(root).getCanvas(canvas.id)).blocks).toEqual([]);
    expect(getChatProposal(store, proposal.id)).toMatchObject({ documents: [{ id: block.id }], applied: [block.id] });
  } finally { await rm(root, { recursive: true, force: true }); }
});
