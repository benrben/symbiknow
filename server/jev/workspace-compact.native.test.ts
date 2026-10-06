import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { emptyJevWorkspace, JevWorkspaceFiles } from './workspace.js';

it('writes compact durable processing state and reads every result back with its original privacy and revision', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jev-workspace-compact-'));
  try {
    const files = new JevWorkspaceFiles(root); const state = emptyJevWorkspace();
    state.profiles = Object.fromEntries(Array.from({ length: 158 }, (_, index) => [`canvas:source-${index}`, {
      keyPassages: [`Exact source ${index}\nwith a second line.`], role: 'reference',
      scopedSources: Array.from({ length: 158 }, (_, source) => ({ workspaceId: 'workspace', canvasId: 'canvas', blockId: `source-${source}`,
        incarnation: `source-${source}`, sourceGeneration: 1, contentHash: 'source-hash', metadataRevision: 0 })),
    }]));
    await files.write('workspace', state);
    const raw = await readFile(files.file('workspace'), 'utf8');
    expect(JSON.parse(raw)).toMatchObject({ codec: 'jev-source-vectors', version: 1 });
    expect(raw.length).toBeLessThan(JSON.stringify(state).length / 20);
    expect(await files.read('workspace')).toEqual(state);
    expect((await stat(files.file('workspace'))).mode & 0o777).toBe(0o600);
    state.profiles['canvas:source-0'].role = 'report'; await files.write('workspace', state);
    expect(state.revision).toBe(2); expect(await files.read('workspace')).toEqual(state);
  } finally { await rm(root, { recursive: true, force: true }); }
});
