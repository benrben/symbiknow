import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CanvasStore, validId } from './storage';

const directories: string[] = [];

async function makeStore(): Promise<CanvasStore> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'symbiknow-storage-'));
  directories.push(root);
  const store = new CanvasStore(root);
  await store.init();
  return store;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('canvas storage', () => {
  it('accepts current and legacy fixed MCP and access-token environment variables', async () => {
    const store = await makeStore();
    vi.stubEnv('SYMBIKNOW_MCP_TOKEN', 'new-mcp');
    vi.stubEnv('ALLTEAM_MCP_TOKEN', 'legacy-mcp');
    vi.stubEnv('SYMBIKNOW_ACCESS_TOKEN', 'new-access');
    vi.stubEnv('ALLTEAM_ACCESS_TOKEN', 'legacy-access');
    expect(await store.verifyMcpToken('new-mcp')).toBe('env token');
    expect(await store.verifyMcpToken('legacy-mcp')).toBe('env token');
    expect(await store.verifyMcpToken('new-access')).toBe('access token');
    expect(await store.verifyMcpToken('legacy-access')).toBe('access token');
    expect(await store.verifyMcpToken('unknown')).toBeNull();
  });

  it('keeps Git branches and revisions separate for each document file', async () => {
    const store = await makeStore();
    const canvasId = 'product-roadmap';
    const docId = 'roadmap-overview';
    const initial = (await store.documentHistory(canvasId, docId)).commits[0].id;
    expect((await store.documentHistory(canvasId, docId)).current).toBe('main');
    await store.createDocumentBranch(canvasId, docId, 'agents/draft');
    await store.switchDocumentBranch(canvasId, docId, 'agents/draft');
    await store.updateBlock('product-roadmap', 'roadmap-overview', { content: '# Agent draft' });
    await store.switchDocumentBranch(canvasId, docId, 'main');
    await store.updateBlock('product-roadmap', 'launch-flow', { content: '# Main update' });
    await store.mergeDocumentBranch(canvasId, docId, 'agents/draft');
    const merged = await store.getCanvas('product-roadmap');
    expect(merged.blocks.find(block => block.id === 'roadmap-overview')?.content).toBe('# Agent draft');
    expect(merged.blocks.find(block => block.id === 'launch-flow')?.content).toBe('# Main update');
    expect((await store.documentHistory(canvasId, 'launch-flow')).branches).toEqual(['main']);

    await store.createDocumentBranch(canvasId, docId, 'agents/conflict');
    await store.switchDocumentBranch(canvasId, docId, 'agents/conflict');
    await store.updateBlock('product-roadmap', 'roadmap-overview', { content: '# Conflicting agent edit' });
    await store.switchDocumentBranch(canvasId, docId, 'main');
    await store.updateBlock('product-roadmap', 'roadmap-overview', { content: '# Main edit' });
    await expect(store.mergeDocumentBranch(canvasId, docId, 'agents/conflict')).rejects.toMatchObject({ status: 409 });
    expect((await store.getCanvas('product-roadmap')).blocks.find(block => block.id === 'roadmap-overview')?.content).toBe('# Main edit');
    await store.restoreDocumentRevision(canvasId, docId, initial);
    expect((await store.getCanvas('product-roadmap')).blocks.find(block => block.id === 'roadmap-overview')?.content).toContain('# Product Roadmap');
    expect((await store.getCanvas('product-roadmap')).blocks.find(block => block.id === 'launch-flow')?.content).toBe('# Main update');
    expect((await store.documentHistory(canvasId, docId)).commits[0].message).toContain('Restore revision');
    await expect(store.createDocumentBranch(canvasId, docId, '../bad')).rejects.toMatchObject({ status: 400 });
    await expect(store.switchDocumentBranch(canvasId, docId, 'missing')).rejects.toMatchObject({ status: 404 });
  }, 20_000);

  it('seeds once, creates workspaces and canvases, and serializes concurrent Markdown files', async () => {
    const store = await makeStore();
    await store.init();
    expect(await store.listWorkspaces()).toHaveLength(1);
    expect(validId('product-roadmap')).toBe(true);
    expect(validId('../outside')).toBe(false);

    const workspace = await store.createWorkspace({ name: 'Research' });
    const canvas = await store.createCanvas(workspace.id, { name: 'Ideas' });
    expect(canvas).toMatchObject({ name: 'Ideas', workspaceId: workspace.id, blocks: [] });
    const [first, second] = await Promise.all([
      store.createBlock(canvas.id, { title: 'First' }),
      store.createBlock(canvas.id, { title: 'Second', kind: 'mdx', content: '<Calculator />', x: -20, y: 90 }),
    ]);
    expect(first).toMatchObject({ kind: 'markdown', content: '# First\n', x: 100, y: 100 });
    expect(second).toMatchObject({ kind: 'mdx', x: 844, y: 90 });
    expect((await store.getCanvas(canvas.id)).blocks.map(block => block.id)).toEqual([first.id, second.id]);
    expect(await readFile(path.join(store.root, first.file), 'utf8')).toBe('# First\n');
    const layout = JSON.parse(await readFile(path.join(store.root, 'canvases', `${canvas.id}.json`), 'utf8')) as { blocks: Array<{ content?: string }> };
    expect(layout.blocks.every(block => block.content === undefined)).toBe(true);
    expect((await store.search('calculator')).map(result => result.blockId)).toContain(second.id);
  });

  it('removes a canvas and its files without damaging neighboring canvases', async () => {
    const store = await makeStore();
    const workspace = (await store.listWorkspaces())[0];
    const doomed = await store.createCanvas(workspace.id, { name: 'Scratch' });
    const note = await store.createBlock(doomed.id, { title: 'Disposable', content: 'Unique disposable finding' });
    await store.documentHistory(doomed.id, note.id);
    await store.updateBlock('product-roadmap', 'roadmap-overview', {
      crossLinks: [{ canvasId: doomed.id, blockId: note.id }],
    });
    await store.createTask(doomed.id, { title: 'Review scratch' }, 'Browser');
    await mkdir(path.dirname(store.jevCacheFile(doomed.id)), { recursive: true });
    await writeFile(store.jevCacheFile(doomed.id), '{}');
    const mergeJournal = path.join(store.root, 'jev-merges', 'sample.json');
    const runJournal = path.join(store.root, 'jev-runs', 'sample.json');
    await mkdir(path.dirname(mergeJournal), { recursive: true });
    await mkdir(path.dirname(runJournal), { recursive: true });
    await writeFile(mergeJournal, JSON.stringify({ canvasId: doomed.id, beforeContent: note.content }));
    await writeFile(runJournal, JSON.stringify({ changes: [{ canvasId: doomed.id }], snapshot: note.content }));
    expect((await store.search('Unique disposable finding')).map(hit => hit.blockId)).toContain(note.id);
    await store.deleteCanvas(doomed.id);
    expect((await store.listWorkspaces())[0].canvases.map(item => item.id)).toEqual(['product-roadmap']);
    await expect(store.getCanvas(doomed.id)).rejects.toMatchObject({ status: 404 });
    await expect(readFile(path.join(store.root, note.file), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(path.join(store.root, '.versions', note.id))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(store.jevCacheFile(doomed.id))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(path.join(store.root, 'tasks', `${doomed.id}.json`))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(mergeJournal)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(runJournal)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await store.getCanvas('product-roadmap')).blocks[0].crossLinks).toBeUndefined();
    expect(await store.search('Unique disposable finding')).toEqual([]);
    await expect(store.deleteCanvas(doomed.id)).rejects.toMatchObject({ status: 404 });
    await expect(store.deleteCanvas('../bad')).rejects.toMatchObject({ status: 400 });
  });

  it('removes a workspace with every canvas and document while preserving other workspaces', async () => {
    const store = await makeStore();
    const workspace = await store.createWorkspace({ name: 'Disposable' });
    const first = await store.createCanvas(workspace.id, { name: 'First' });
    const second = await store.createCanvas(workspace.id, { name: 'Second' });
    const note = await store.createBlock(first.id, { title: 'Finding', content: 'Private temporary finding' });
    await store.documentHistory(first.id, note.id);
    await store.createTask(second.id, { title: 'Review' }, 'Browser');
    await mkdir(path.dirname(store.jevCacheFile(first.id)), { recursive: true });
    await writeFile(store.jevCacheFile(first.id), '{}');
    expect((await store.search('Private temporary finding')).map(hit => hit.blockId)).toContain(note.id);

    await store.deleteWorkspace(workspace.id);
    expect((await store.listWorkspaces()).map(item => item.id)).toEqual(['acme-team']);
    await expect(store.getCanvas(first.id)).rejects.toMatchObject({ status: 404 });
    await expect(store.getCanvas(second.id)).rejects.toMatchObject({ status: 404 });
    await expect(stat(path.join(store.root, note.file))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(path.join(store.root, '.versions', note.id))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(path.join(store.root, 'tasks', `${second.id}.json`))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(store.jevCacheFile(first.id))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await store.search('Private temporary finding')).toEqual([]);
    expect((await store.getCanvas('product-roadmap')).name).toBe('Product Roadmap');
    await expect(store.deleteWorkspace(workspace.id)).rejects.toMatchObject({ status: 404 });
    await expect(store.deleteWorkspace('../bad')).rejects.toMatchObject({ status: 400 });
  });

  it('places new documents in free slots, including assistant supplied coordinates', async () => {
    const store = await makeStore();
    const workspace = await store.createWorkspace({ name: 'Placement' });
    const canvas = await store.createCanvas(workspace.id, { name: 'Cards' });
    const first = await store.createBlock(canvas.id, { title: 'First' });
    const second = await store.createBlock(canvas.id, { title: 'Second' });
    const assistant = await store.createBlock(canvas.id, { title: 'Assistant', x: 100, y: 100 });
    const rectangles = [first, second, assistant];
    for (const [index, block] of rectangles.entries()) {
      for (const other of rectangles.slice(index + 1)) {
        expect(block.x + block.width <= other.x || other.x + other.width <= block.x ||
          block.y + block.height <= other.y || other.y + other.height <= block.y).toBe(true);
      }
    }
    expect(first).toMatchObject({ x: 100, y: 100 });
    expect((await store.getCanvas(canvas.id)).blocks.map(block => [block.x, block.y])).toEqual(rectangles.map(block => [block.x, block.y]));
  });

  it('updates block metadata and content, then removes its file and inbound links', async () => {
    const store = await makeStore();
    const linked = await store.createBlock('product-roadmap', { title: 'Linked notes', content: '---\ntitle: metadata\n---\n# Public finding' });
    const updated = await store.updateBlock('product-roadmap', linked.id, {
      title: 'Revised notes', kind: 'slides', content: '# Revised finding', x: -250, y: 800,
      width: 650, height: 250, links: ['roadmap-overview'], purpose: 'guide', reviewer: 'Engineering', workArea: 'developers',
    });
    expect(updated).toMatchObject({ title: 'Revised notes', kind: 'slides', x: -250, y: 800,
      width: 650, height: 250, links: ['roadmap-overview'], purpose: 'guide', reviewer: 'Engineering', workArea: 'developers' });
    expect((await store.getCanvas('product-roadmap')).blocks.find(block => block.id === linked.id)).toMatchObject({ purpose: 'guide', reviewer: 'Engineering', workArea: 'developers' });
    expect((await store.updateBlock('product-roadmap', linked.id, { purpose: '  ', reviewer: '  ', workArea: '  ' }))).toMatchObject({ purpose: undefined, reviewer: undefined, workArea: undefined });
    expect(await readFile(path.join(store.root, linked.file), 'utf8')).toBe('# Revised finding');
    expect((await store.search('revised')).map(result => result.blockId)).toContain(linked.id);
    expect((await store.search('unmatched'))).toEqual([]);
    expect((await store.search('  '))).toEqual([]);

    await store.updateBlock('product-roadmap', 'roadmap-overview', { links: [linked.id] });
    await store.deleteBlock('product-roadmap', linked.id);
    expect((await store.getCanvas('product-roadmap')).blocks.find(block => block.id === 'roadmap-overview')?.links).toEqual([]);
    await expect(readFile(path.join(store.root, linked.file), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await store.search('Revised notes'))).toEqual([]);
  });

  it('persists tags and nested groups through create, update, layout, and reload', async () => {
    const store = await makeStore();
    const created = await store.createBlock('product-roadmap', {
      title: 'Benchmark notes', content: 'API benchmark results', group: 'custom:research/benchmarks',
      tags: [' API ', 'Model', 'api'],
    });
    expect(created).toMatchObject({ group: 'custom:research/benchmarks', tags: ['API', 'Model'] });
    expect((await store.getCanvas('product-roadmap')).blocks.find(block => block.id === created.id))
      .toMatchObject({ group: 'custom:research/benchmarks', tags: ['API', 'Model'] });
    const stored = JSON.parse(await readFile(path.join(store.root, 'canvases', 'product-roadmap.json'), 'utf8')) as { blocks: Array<{ id: string; tags?: string[] }> };
    expect(stored.blocks.find(block => block.id === created.id)?.tags).toEqual(['API', 'Model']);
    await store.updateBlock('product-roadmap', created.id, { tags: ['Research'], group: 'area:platform/api' });
    await store.updateLayout('product-roadmap', [{ blockId: created.id, x: 200, y: 400, group: 'custom:research/models/qwen' }]);
    expect((await store.getCanvas('product-roadmap')).blocks.find(block => block.id === created.id))
      .toMatchObject({ group: 'custom:research/models/qwen', tags: ['Research'], x: 200, y: 400 });
    await store.updateBlock('product-roadmap', created.id, { tags: [] });
    expect((await store.getCanvas('product-roadmap')).blocks.find(block => block.id === created.id)?.tags).toEqual([]);
  });

  it('searches across canvases with ranked matches and excerpts around body matches', async () => {
    const store = await makeStore();
    const workspace = await store.createWorkspace({ name: 'Research' });
    const canvas = await store.createCanvas(workspace.id, { name: 'Jev research' });
    const body = await store.createBlock(canvas.id, {
      title: 'Notes', content: `${'Earlier context. '.repeat(25)}A unique API detail appears here. ${'Later context. '.repeat(25)}`,
      group: 'custom:research/benchmarks', tags: ['API'],
    });
    const title = await store.createBlock(canvas.id, { title: 'API guide', content: '# A guide', kind: 'slides' });
    const hits = await store.search(' api ');
    expect(hits.map(hit => hit.blockId).slice(0, 2)).toEqual([title.id, body.id]);
    expect(hits[0]).toMatchObject({ canvasId: canvas.id, canvasName: 'Jev research', kind: 'slides', tags: [], matchIn: 'title', excerpt: 'API guide' });
    expect(hits[1]).toMatchObject({ canvasName: 'Jev research', group: 'custom:research/benchmarks', tags: ['API'], matchIn: 'body' });
    expect(hits[1].excerpt).toContain('API detail');
    expect(hits[1].excerpt.startsWith('…')).toBe(true);
    expect(hits[1].excerpt.endsWith('…')).toBe(true);
    expect(hits).toHaveLength(2);
  });

  it('refreshes cached document bodies and canvas revisions after external edits', async () => {
    const store = await makeStore();
    const first = await store.getCanvas('product-roadmap');
    const revision = await store.getCanvasRevision('product-roadmap');
    const block = first.blocks.find(item => item.id === 'roadmap-overview')!;
    const original = await stat(path.join(store.root, block.file));
    const edited = block.content.replace('Product Roadmap', 'Project Roadmap');
    expect(edited).toHaveLength(block.content.length);
    await writeFile(path.join(store.root, block.file), edited);
    await import('node:fs/promises').then(fs => fs.utimes(path.join(store.root, block.file), original.atime, original.mtime));
    expect((await store.getCanvas('product-roadmap')).blocks.find(item => item.id === block.id)?.content).toBe(edited);
    expect(await store.getCanvasRevision('product-roadmap')).not.toBe(revision);
    expect((await store.search('Project Roadmap')).map(hit => hit.blockId)).toContain(block.id);
  });

  it('changes canvas revisions when cross-link targets or document locks change', async () => {
    const store = await makeStore();
    const workspace = (await store.listWorkspaces())[0];
    const other = await store.createCanvas(workspace.id, { name: 'Linked canvas' });
    const target = await store.createBlock(other.id, { title: 'Linked document' });
    await store.updateBlock('product-roadmap', 'roadmap-overview', {
      crossLinks: [{ canvasId: other.id, blockId: target.id }],
    });
    const linkedRevision = await store.getCanvasRevision('product-roadmap');
    expect((await store.getCanvas('product-roadmap')).blocks[0].crossLinks).toHaveLength(1);
    await store.updateBlock(other.id, target.id, { archived: true });
    expect(await store.getCanvasRevision('product-roadmap')).not.toBe(linkedRevision);
    expect((await store.getCanvas('product-roadmap')).blocks[0].crossLinks).toBeUndefined();
    const unlockedRevision = await store.getCanvasRevision('product-roadmap');
    await store.lockBlock('product-roadmap', 'roadmap-overview', 'reviewer', {});
    expect(await store.getCanvasRevision('product-roadmap')).not.toBe(unlockedRevision);
  });

  it('rejects invalid IDs, fields, dimensions, links, and missing records without corrupting data', async () => {
    const store = await makeStore();
    await expect(store.getCanvas('../outside')).rejects.toMatchObject({ status: 400 });
    await expect(store.getCanvas('missing')).rejects.toMatchObject({ status: 404 });
    await expect(store.createWorkspace({ name: ' ' })).rejects.toMatchObject({ status: 400 });
    await expect(store.createCanvas('bad/id', { name: 'Ideas' })).rejects.toMatchObject({ status: 400 });
    await expect(store.createCanvas('missing', { name: 'Ideas' })).rejects.toMatchObject({ status: 404 });
    for (const input of [
      { title: '' }, { title: 'Bad', content: 42 }, { title: 'Bad', kind: 'unknown' },
      { title: 'Bad', x: Number.POSITIVE_INFINITY }, { title: 'Bad', y: 1_000_001 },
    ]) {
      await expect(store.createBlock('product-roadmap', input)).rejects.toMatchObject({ status: 400 });
    }
    const created = await store.createBlock('product-roadmap', { title: 'Safe' });
    await expect(store.updateBlock('product-roadmap', '../outside', {})).rejects.toMatchObject({ status: 400 });
    await expect(store.updateBlock('product-roadmap', 'missing', {})).rejects.toMatchObject({ status: 404 });
    for (const patch of [
      { links: 'roadmap-overview' }, { links: [created.id] }, { links: ['missing'] },
      { links: ['bad/id'] }, { links: [42] }, { width: 99 }, { height: 5001 },
      { x: Number.NaN }, { title: '' }, { content: 20 }, { kind: 'invalid' },
      { purpose: 42 }, { reviewer: 42 }, { workArea: 42 }, { purpose: 'x'.repeat(81) }, { reviewer: 'x'.repeat(81) }, { workArea: 'x'.repeat(81) },
      { tags: null }, { tags: 'one' }, { tags: [''] }, { tags: [42] }, { tags: ['x'.repeat(41)] }, { tags: Array(21).fill('tag') },
      { group: 'custom:research//bad' }, { group: 'unknown:research' },
    ]) {
      await expect(store.updateBlock('product-roadmap', created.id, patch)).rejects.toMatchObject({ status: 400 });
    }
    await expect(store.createBlock('product-roadmap', { title: 'Bad tag', tags: ['bad\nline'] })).rejects.toMatchObject({ status: 400 });
    expect((await store.getCanvas('product-roadmap')).blocks.find(block => block.id === created.id)).toMatchObject({ title: 'Safe', links: [] });
    await expect(store.deleteBlock('product-roadmap', '../outside')).rejects.toMatchObject({ status: 400 });
    await expect(store.deleteBlock('product-roadmap', 'missing')).rejects.toMatchObject({ status: 404 });
    await expect(store.search('q'.repeat(201))).rejects.toMatchObject({ status: 400 });
    expect(await store.listWorkspaces()).toHaveLength(1);
  });

  it('keeps separate OpenRouter and TypeSafe credentials private with environment fallbacks', async () => {
    const store = await makeStore();
    expect(await store.getSettings()).toMatchObject({ provider: 'openrouter', model: '', hasApiKey: false, hasJevApiKey: false });
    expect(await store.getApiKey()).toBe('');
    expect(await store.getJevApiKey()).toBe('');
    vi.stubEnv('OPENROUTER_API_KEY', 'environment-key');
    vi.stubEnv('TYPESAFE_API_KEY', 'jev-environment-key');
    expect(await store.getSettings()).toMatchObject({ hasApiKey: true, hasJevApiKey: true });
    expect(await store.getApiKey()).toBe('environment-key');
    expect(await store.getJevApiKey()).toBe('jev-environment-key');

    const saved = await store.updateSettings({ model: 'openai/gpt-4.1-mini', systemPrompt: 'Help the team.', apiKey: 'private-key', jevApiKey: 'jev-private-key' });
    expect(saved).toMatchObject({ provider: 'openrouter', model: 'openai/gpt-4.1-mini', systemPrompt: 'Help the team.', reviewers: '', workAreas: '', hasApiKey: true, hasJevApiKey: true });
    expect(await store.getApiKey()).toBe('private-key');
    expect(await store.getJevApiKey()).toBe('jev-private-key');
    expect(JSON.stringify(await store.getSettings())).not.toContain('private-key');
    expect((await stat(path.join(store.root, 'settings.json'))).mode & 0o777).toBe(0o600);
    expect((await store.updateSettings({ systemPrompt: 'Updated instructions' })).systemPrompt).toBe('Updated instructions');
    expect((await store.updateSettings({ reviewers: ' Product, Engineering ' })).reviewers).toBe('Product, Engineering');
    expect((await store.updateSettings({ workAreas: ' Field sales, DevRel ' })).workAreas).toBe('Field sales, DevRel');
    await expect(store.updateSettings({ workAreas: 42 })).rejects.toMatchObject({ status: 400 });
    await expect(store.updateSettings({ workAreas: 'x'.repeat(2501) })).rejects.toMatchObject({ status: 400 });
    await expect(store.updateSettings({ reviewers: 42 })).rejects.toMatchObject({ status: 400 });
    expect((await store.updateSettings({ reviewers: 'x'.repeat(2000) })).reviewers).toHaveLength(2000);
    await expect(store.updateSettings({ reviewers: 'x'.repeat(2001) })).rejects.toMatchObject({ status: 400 });
    await expect(store.updateSettings({ model: '' })).rejects.toMatchObject({ status: 400 });
    await expect(store.updateSettings({ apiKey: 42 })).rejects.toMatchObject({ status: 400 });
    await expect(store.updateSettings({ apiKey: 'x'.repeat(4097) })).rejects.toMatchObject({ status: 400 });
    await expect(store.updateSettings({ jevApiKey: 42 })).rejects.toMatchObject({ status: 400 });
    await expect(store.updateSettings({ jevApiKey: 'x'.repeat(4097) })).rejects.toMatchObject({ status: 400 });
    expect(await store.getApiKey()).toBe('private-key');
    expect((await store.updateSettings({ apiKey: '' })).hasApiKey).toBe(true);
    expect(await store.getApiKey()).toBe('environment-key');
    expect((await store.updateSettings({ jevApiKey: '' })).hasJevApiKey).toBe(true);
    expect(await store.getJevApiKey()).toBe('jev-environment-key');
  });

  it('validates Jev policy thresholds before saving settings', async () => {
    const store = await makeStore();
    expect((await store.updateSettings({ jevPolicy: { link: { show: 0.6, apply: 0.9 } } })).jevPolicy?.link)
      .toEqual({ show: 0.6, apply: 0.9 });
    for (const jevPolicy of [
      null, [], { unknown: { show: 0.5, apply: 0.8 } }, { link: { show: -0.1, apply: 0.8 } },
      { link: { show: 0.9, apply: 0.8 } }, { link: { show: 0.5, apply: 1.1 } },
      { link: { show: Number.NaN, apply: 0.8 } }, { link: { show: 0.5, apply: 0.8, extra: 1 } },
    ]) {
      await expect(store.updateSettings({ jevPolicy })).rejects.toMatchObject({ status: 400 });
    }
    expect((await store.getSettings()).jevPolicy?.link).toEqual({ show: 0.6, apply: 0.9 });
  });

  it('saves agent profiles and plugin choices while rejecting unknown options', async () => {
    const store = await makeStore();
    const saved = await store.updateSettings({ agentProfile: 'planner', agentPlugins: ['document_read', 'jev_insights'] });
    expect(saved).toMatchObject({ agentProfile: 'planner', agentPlugins: ['document_read', 'jev_insights'] });
    await expect(store.updateSettings({ agentProfile: 'unknown' })).rejects.toMatchObject({ status: 400 });
    await expect(store.updateSettings({ agentPlugins: ['document_read', 'unknown'] })).rejects.toMatchObject({ status: 400 });
  });

  it('updates older settings files that predate reviewer lists', async () => {
    const store = await makeStore();
    await writeFile(path.join(store.root, 'settings.json'), JSON.stringify({
      provider: 'openrouter', model: 'openai/gpt-4o-mini', systemPrompt: 'Old instructions', apiKey: 'saved-key',
    }));
    expect(await store.updateSettings({ systemPrompt: 'Updated instructions' })).toMatchObject({
      systemPrompt: 'Updated instructions', reviewers: '', hasApiKey: true,
    });
  });

  it('updates a suggested layout atomically and validates every position', async () => {
    const store = await makeStore();
    const layout = await store.updateLayout('product-roadmap', [
      { blockId: 'roadmap-overview', x: -200, y: 300 },
      { blockId: 'launch-flow', x: 260, y: 300 },
    ]);
    expect(layout.blocks.find(block => block.id === 'roadmap-overview')).toMatchObject({ x: -200, y: 300 });
    expect((await store.getCanvas('product-roadmap')).blocks.find(block => block.id === 'launch-flow')).toMatchObject({ x: 260, y: 300 });
    for (const bad of [null, [],
      [null], [42], [{}], [{ blockId: '../bad', x: 0, y: 0 }], [{ blockId: 1, x: 0, y: 0 }],
      [{ blockId: 'roadmap-overview', y: 0 }], [{ blockId: 'roadmap-overview', x: 0 }],
      [{ blockId: 'roadmap-overview', x: Infinity, y: 0 }],
      [{ blockId: 'roadmap-overview', x: 0, y: 0 }, { blockId: 'roadmap-overview', x: 1, y: 1 }]]) {
      await expect(store.updateLayout('product-roadmap', bad)).rejects.toMatchObject({ status: 400 });
    }
    await expect(store.updateLayout('product-roadmap', [{ blockId: 'missing', x: 0, y: 0 }])).rejects.toMatchObject({ status: 404 });
    expect((await store.getCanvas('product-roadmap')).blocks.find(block => block.id === 'roadmap-overview')).toMatchObject({ x: -200, y: 300 });
  });

  it('surfaces corrupt persisted JSON instead of treating it as missing data', async () => {
    const store = await makeStore();
    await writeFile(path.join(store.root, 'canvases', 'product-roadmap.json'), '{broken');
    await expect(store.getCanvas('product-roadmap')).rejects.toBeInstanceOf(SyntaxError);
    await writeFile(path.join(store.root, 'settings.json'), '{broken');
    await expect(store.getSettings()).rejects.toBeInstanceOf(SyntaxError);
  });

  it('does not reseed when the workspace file cannot be read', async () => {
    const store = await makeStore();
    const workspaceFile = path.join(store.root, 'workspaces.json');
    await rm(workspaceFile);
    await mkdir(workspaceFile);
    await expect(store.init()).rejects.toMatchObject({ code: 'EISDIR' });
  });
});
