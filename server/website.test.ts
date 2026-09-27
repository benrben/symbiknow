import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, symlink, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CanvasStore } from './storage.js';
import { siteResponse } from './website.js';

const directories: string[] = [];
const canvasId = 'product-roadmap';
const blockId = 'team-docs';

async function fixture(): Promise<CanvasStore> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'symbiknow-website-'));
  directories.push(root);
  const store = new CanvasStore(root);
  await store.init();
  return store;
}

async function configure(store: CanvasStore, generator: string, source = 'sites/docs'): Promise<void> {
  await store.updateBlock(canvasId, blockId, { content: `---\ngenerator: ${generator}\nsource: ${source}\n---\n` });
}

async function fakeDocusaurus(store: CanvasStore, script: string): Promise<void> {
  const bin = path.join(store.root, 'sites', 'docs', 'node_modules', '.bin');
  await mkdir(bin, { recursive: true });
  const executable = path.join(bin, 'docusaurus');
  await writeFile(executable, script);
  await chmod(executable, 0o755);
  await configure(store, 'docusaurus');
}

const generatedSite = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const output = process.argv[process.argv.indexOf('--out-dir') + 1];
fs.mkdirSync(path.join(output, 'guide'), { recursive: true });
fs.writeFileSync(path.join(output, 'index.html'), '<h1>Built docs</h1><script>window.siteRuns = true</script>');
fs.writeFileSync(path.join(output, 'guide', 'index.html'), '<h1>Guide</h1>');
fs.writeFileSync(path.join(output, 'style.css'), 'body { color: blue }');
fs.writeFileSync(path.join(output, 'artifact.dat'), 'binary-ish');
`;

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('website preview and assets', () => {
  it('builds a site, serves nested assets, and removes scripts only from the canvas preview', async () => {
    const store = await fixture();
    await fakeDocusaurus(store, generatedSite);

    const full = await siteResponse(store, canvasId, blockId, '', false);
    expect(full.contentType).toContain('text/html');
    expect(full.body.toString()).toContain('<script>window.siteRuns = true</script>');

    const preview = await siteResponse(store, canvasId, blockId, '/', true);
    expect(preview.body.toString()).toContain('Built docs');
    expect(preview.body.toString()).not.toContain('<script>');

    const css = await siteResponse(store, canvasId, blockId, 'style.css');
    expect(css).toMatchObject({ status: 200, contentType: 'text/css; charset=utf-8' });
    expect(css.body.toString()).toContain('color: blue');
    expect((await siteResponse(store, canvasId, blockId, 'guide/')).body.toString()).toContain('Guide');
    expect((await siteResponse(store, canvasId, blockId, 'artifact.dat')).contentType).toBe('application/octet-stream');
  });

  it('distinguishes missing blocks, ordinary blocks, and incomplete website frontmatter', async () => {
    const store = await fixture();
    await expect(siteResponse(store, canvasId, 'missing-block', '')).rejects.toMatchObject({ status: 404, message: 'Block not found' });
    await expect(siteResponse(store, canvasId, 'roadmap-overview', '')).rejects.toMatchObject({ status: 400, message: 'This block is not a website' });
    await store.updateBlock(canvasId, blockId, { content: '# Add configuration' });
    expect((await siteResponse(store, canvasId, blockId, '')).body.toString()).toContain('Website setup needed');
    await store.updateBlock(canvasId, blockId, { content: '---\ngenerator: hugo\n---\n' });
    expect((await siteResponse(store, canvasId, blockId, '')).body.toString()).toContain('Website setup needed');
  });

  it('reports unsupported generators and escaped build failures without serving stale files', async () => {
    const store = await fixture();
    await mkdir(path.join(store.root, 'sites', 'docs'), { recursive: true });
    await configure(store, 'unknown');
    const unsupported = await siteResponse(store, canvasId, blockId, '');
    expect(unsupported.body.toString()).toContain('Use generator: mkdocs, hugo, or docusaurus');

    await fakeDocusaurus(store, '#!/usr/bin/env node\nprocess.stderr.write("<broken theme>"); process.exit(7);\n');
    const broken = await siteResponse(store, canvasId, blockId, '');
    expect(broken.body.toString()).toContain('docusaurus build failed: &lt;broken theme&gt;');
    expect(broken.body.toString()).not.toContain('<broken theme>');

    await fakeDocusaurus(store, '#!/usr/bin/env node\nprocess.exit(7);\n');
    expect((await siteResponse(store, canvasId, blockId, '')).body.toString()).toContain('docusaurus build failed: Command failed');
  });

  it('passes the output directory to MkDocs and Hugo generators', async () => {
    const store = await fixture();
    const bin = path.join(store.root, 'bin');
    await mkdir(bin, { recursive: true });
    await mkdir(path.join(store.root, 'sites', 'docs'), { recursive: true });
    const script = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const flag = process.argv.includes('--site-dir') ? '--site-dir' : '--destination';
const output = process.argv[process.argv.indexOf(flag) + 1];
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, 'index.html'), '<h1>' + path.basename(process.argv[1]) + '</h1>');
`;
    for (const name of ['mkdocs', 'hugo']) {
      await writeFile(path.join(bin, name), script);
      await chmod(path.join(bin, name), 0o755);
    }
    const originalPath = process.env.PATH;
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(store.root);
    process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
    try {
      for (const generator of ['mkdocs', 'hugo']) {
        await configure(store, generator);
        const result = await siteResponse(store, canvasId, blockId, '');
        expect(result.body.toString()).toContain(`<h1>${generator}</h1>`);
      }
    } finally {
      cwd.mockRestore();
      process.env.PATH = originalPath;
    }
  });

  it('rejects source escapes and missing source folders', async () => {
    const store = await fixture();
    await configure(store, 'docusaurus', '/tmp');
    expect((await siteResponse(store, canvasId, blockId, '')).body.toString()).toContain('relative folder');
    await configure(store, 'docusaurus', 'sites/missing');
    expect((await siteResponse(store, canvasId, blockId, '')).body.toString()).toContain('source folder was not found');

    await mkdir(path.join(store.root, 'sites'), { recursive: true });
    await writeFile(path.join(store.root, 'sites', 'not-a-folder'), 'file');
    await configure(store, 'docusaurus', 'sites/not-a-folder');
    expect((await siteResponse(store, canvasId, blockId, '')).body.toString()).toContain('source must be a folder');

    const outside = await mkdtemp(path.join(os.tmpdir(), 'symbiknow-outside-'));
    directories.push(outside);
    await mkdir(path.join(store.root, 'sites'), { recursive: true });
    await symlink(outside, path.join(store.root, 'sites', 'outside'), 'dir');
    await configure(store, 'docusaurus', 'sites/outside');
    expect((await siteResponse(store, canvasId, blockId, '')).body.toString()).toContain('inside the data directory');
  });

  it('rejects missing assets, traversal, and generated symlinks leaving the cache', async () => {
    const store = await fixture();
    await fakeDocusaurus(store, generatedSite);
    await siteResponse(store, canvasId, blockId, '');
    await expect(siteResponse(store, canvasId, blockId, 'missing.css')).rejects.toMatchObject({ status: 404, message: 'Website asset not found' });
    await expect(siteResponse(store, canvasId, blockId, '../secret.txt')).rejects.toMatchObject({ status: 400, message: 'Invalid website asset path' });

    const outside = path.join(store.root, 'secret.txt');
    await writeFile(outside, 'private');
    await symlink(outside, path.join(store.root, 'site-cache', canvasId, blockId, 'private.txt'));
    await expect(siteResponse(store, canvasId, blockId, 'private.txt')).rejects.toMatchObject({ status: 400, message: 'Invalid website asset path' });
  });

  it('reports an unavailable local generator executable', async () => {
    const store = await fixture();
    await fakeDocusaurus(store, '#!/missing/interpreter\n');
    const response = await siteResponse(store, canvasId, blockId, '');
    expect(response.body.toString()).toContain('docusaurus is not installed on this server');
    expect(response.status).toBe(200);
  });
});
