import { access, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';

/** Launch a real browser, using an existing offline cache when the expected revision is absent. */
export async function launchAcceptanceBrowser() {
  const configured = process.env.SYMBI_ACCEPTANCE_CHROMIUM;
  if (configured) return chromium.launch({ headless: true, executablePath: configured });
  try {
    await access(chromium.executablePath());
    return chromium.launch({ headless: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.PLAYWRIGHT_BROWSERS_PATH !== '0'
    ? process.env.PLAYWRIGHT_BROWSERS_PATH : '/private/tmp/symbi-playwright';
  const revisions = await readdir(root).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return [];
  });
  const platform = process.platform === 'darwin'
    ? `mac-${process.arch === 'arm64' ? 'arm64' : 'x64'}` : 'linux64';
  for (const revision of revisions.filter(name => /^chromium_headless_shell-\d+$/.test(name)).sort().reverse()) {
    const executablePath = join(root, revision, `chrome-headless-shell-${platform}`, 'chrome-headless-shell');
    try { await access(executablePath); return chromium.launch({ headless: true, executablePath }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return chromium.launch({ headless: true });
}
