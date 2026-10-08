// @vitest-environment jsdom
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { CanvasStore } from './storage.js';
import { exportWebsite, replaceWebsite, type WebsitePackage } from './website-working-copy.js';

it('replaces website assets with the default operation ID through the browser transform', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'symbi-browser-website-copy-'));
  try {
    await writeFile(path.join(root, 'workspaces.json'), '[]');
    const store = new CanvasStore(root);
    await store.init();
    const folder = path.join(root, 'sites/browser-replace');
    await mkdir(path.join(folder, 'docs'), { recursive: true });
    await writeFile(path.join(folder, 'docs/index.md'), '# Original source');
    await writeFile(path.join(folder, 'docs/removed.md'), '# Obsolete source');
    const document = '---\ngenerator: mkdocs\nsource: sites/browser-replace\n---\n# Website';
    const expected = (await exportWebsite(store, document)).packageHash;
    const asset = Buffer.from([0, 255, 1, 128]);
    const replacement: WebsitePackage = {
      format: 'symbi-website', version: 1, documentContent: document,
      files: [
        { path: 'docs/index.md', encoding: 'utf8', content: '# Browser replacement' },
        { path: 'assets/image.bin', encoding: 'base64', content: asset.toString('base64') },
      ],
    };
    const saved = { id: 'saved-browser-website' };
    let saveCalls = 0;
    const result = await replaceWebsite(store, document, replacement, expected, async () => {
      saveCalls += 1;
      return saved;
    });

    expect(result).toBe(saved);
    expect(saveCalls).toBe(1);
    expect(await readFile(path.join(folder, 'docs/index.md'), 'utf8')).toBe('# Browser replacement');
    expect(await readFile(path.join(folder, 'assets/image.bin'))).toEqual(asset);
    expect(await readdir(path.join(folder, 'docs'))).toEqual(['index.md']);
    expect((await readdir(path.join(root, 'sites'))).filter(name => /\.(upload|backup)-/.test(name))).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
