import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { decideWithJev, JEV_MODEL } from '../server/jev.js';
import { auditedReflexProvider } from './acceptance-provider-audit.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'symbi-native-provider-audit-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it('records the exact SDK question sets without credentials and preserves the original synthetic provider answers', async () => {
  const state = { questionSets: [{ document: { id: 'first', title: 'Release', passages: ['Release has a rollback checkpoint.'] } },
    { document: { id: 'second', title: 'Hosting', passages: ['Hosting requires a configured port.'] } }] };
  const questions = { '0__supported': { type: 'noul' as const, instructions: 'Use only questionSets[0].' },
    '1__role': { type: 'choice' as const, instructions: 'Use only questionSets[1].', criteria: { instructions: 'A hosting procedure', unknown: 'Unknown' } } };
  const answers = await decideWithJev('isolated-audit-credential', state, questions, auditedReflexProvider(root));
  expect(answers).toMatchObject({ '0__supported': { type: 'noul', noul: 0.99 }, '1__role': { type: 'choice', choice: 'instructions' } });
  const text = await readFile(path.join(root, 'reflex-provider-requests.jsonl'), 'utf8');
  expect(text.trim().split('\n')).toHaveLength(1);
  expect(JSON.parse(text)).toEqual({ model: JEV_MODEL, state, questions });
  expect(text).not.toContain('isolated-audit-credential'); expect(text).not.toContain('Authorization');
});

it('rejects an unwritable native audit before returning any provider result and keeps the previous record intact', async () => {
  const file = path.join(root, 'reflex-provider-requests.jsonl');
  const previous = JSON.stringify({ state: { document: 'Earlier synthetic source' } }) + '\n';
  await writeFile(file, previous); await rename(file, file + '.saved'); await mkdir(file);
  await expect(auditedReflexProvider(root)('https://api.typesafe.ai/v1/systemone', { method: 'POST',
    body: JSON.stringify({ model: JEV_MODEL, state: { document: 'Current synthetic source' }, questions: {} }) }))
    .rejects.toMatchObject({ message: 'Native acceptance provider request audit could not be saved', cause: { code: 'EISDIR' } });
  expect(await readFile(file + '.saved', 'utf8')).toBe(previous);
});
