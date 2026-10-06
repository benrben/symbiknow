import { expect, it } from 'vitest';
import type { JevAction } from '../../shared/jev-types.js';
import { automationPrincipal, principalFingerprint } from './authorization.js';
import { JevJobScheduler, type JevQueuedCandidate } from './runtime-scheduler.js';
import type { StoredJevJob } from './runtime-queue.js';

function candidate(id: string, action: JevAction, time: number, manual = false): JevQueuedCandidate {
  return { workspaceId: 'workspace', job: { id, request: { action, canvasId: 'canvas' }, state: 'queued',
    createdAt: new Date(time).toISOString(), updatedAt: new Date(time).toISOString(), sources: [], proposalIds: [], attempts: 0,
    principal: manual ? { id: 'owner', kind: 'user', access: 'write' } : automationPrincipal,
    settingsKey: 'settings', authorizationFingerprint: 'fingerprint' } };
}
function chained(candidate: JevQueuedCandidate): JevQueuedCandidate {
  const { job } = candidate; const key = `checked:${job.id}`;
  return { ...candidate, job: { ...job, request: { ...job.request, idempotencyKey: `${key}:${job.request.action}` },
    authorizationFingerprint: principalFingerprint(automationPrincipal), followupKey: key, followupActions: [], followupSources: [] } };
}
it('consumes each admitted automatic followup before a 146-source fresh profile backlog', () => {
  const scheduler = new JevJobScheduler();
  const profiles = Array.from({ length: 146 }, (_, index) => candidate(`profile-${index}`, 'profile', index + 1));
  const chain = ['link', 'flag_duplicate', 'suggest_home_canvas'] as JevAction[];
  for (const [index, action] of chain.entries()) {
    const followup = chained(candidate(`followup-${index}`, action, 1000 + index));
    expect(scheduler.select([...profiles, followup])).toBe(followup);
  }
  expect(scheduler.select(profiles)).toBe(profiles[0]);
});
it('retains file, labels and oldest manual requests ahead of an admitted followup', () => {
  const scheduler = new JevJobScheduler(); const followup = chained(candidate('chain', 'flag_duplicate', 1));
  followup.job.followupActions = ['link', 'suggest_home_canvas'];
  delete followup.job.followupSources; // Queued packets retain chain admission but omit original canonical vectors.
  const manualOld = candidate('manual-old', 'suggest_home_canvas', 2, true); const manualNew = candidate('manual-new', 'file', 3, true);
  const pending = [followup, candidate('profile', 'profile', 0), candidate('label', 'label', 4),
    candidate('file', 'file', 5), manualNew, manualOld]; const order: string[] = [];
  while (pending.length) {
    const next = scheduler.select(pending)!; order.push(next.job.id); pending.splice(pending.indexOf(next), 1);
  }
  expect(order).toEqual(['manual-old', 'manual-new', 'file', 'label', 'chain', 'profile']);
});
it('reserves every seventh slot for ordinary background work during continuously ready chains', () => {
  const scheduler = new JevJobScheduler(); const background = candidate('ordinary-background', 'suggest_home_canvas', 0);
  const profiles = Array.from({ length: 146 }, (_, index) => candidate(`profile-${index}`, 'profile', index));
  for (let index = 0; index < 15; index++) {
    const chain = chained(candidate(`chain-${index}`, 'flag_duplicate', 1000 + index));
    const pending = [...profiles, chain, background];
    for (let peek = 0; peek < 3; peek++) expect(scheduler.peek(pending)).toBe(index % 7 === 6 ? background : chain);
    expect(scheduler.select(pending)).toBe(index % 7 === 6 ? background : chain);
  }
});
it.each([
  ['missing key', { followupKey: undefined }],
  ['empty key', { followupKey: '' }],
  ['missing remaining actions', { followupActions: undefined }],
  ['nonarray remaining actions', { followupActions: 'link' }],
  ['unknown remaining action', { followupActions: ['obsolete'] }],
  ['unbound operation key', { request: { action: 'flag_duplicate', canvasId: 'canvas', idempotencyKey: 'different' } }],
  ['changed authorization fingerprint', { authorizationFingerprint: 'revoked' }],
  ['user impersonation', { principal: { ...automationPrincipal, kind: 'user' } }],
  ['read-only automation', { principal: { ...automationPrincipal, access: 'read' } }],
  ['restricted automation', { principal: { ...automationPrincipal, allowedCanvasIds: ['canvas'] } }],
] as const)('does not prioritize a %s as a checked automatic chain', (_label, invalid) => {
  const scheduler = new JevJobScheduler(); const fresh = candidate('fresh', 'profile', 10);
  const followup = chained(candidate('untrusted', 'flag_duplicate', 0));
  followup.job = { ...followup.job, ...invalid } as StoredJevJob;
  expect(scheduler.select([followup, fresh])).toBe(fresh);
});
it('selects ready group placement and labels ahead of an older large connections/profile backlog', () => {
  const scheduler = new JevJobScheduler();
  const pending = [candidate('profile', 'profile', 1), candidate('connections', 'link', 2),
    candidate('label', 'label', 3), candidate('file', 'file', 4), candidate('older-file', 'file', 3)];
  const order = [];
  while (pending.length) {
    const next = scheduler.select(pending)!; order.push(next.job.id); pending.splice(pending.indexOf(next), 1);
  }
  expect(order).toEqual(['older-file', 'file', 'label', 'profile', 'connections']);
  expect(scheduler.select([])).toBeUndefined();
});
it('understands newer sources before an older connections backlog while preserving broader work and background fairness', () => {
  const scheduler = new JevJobScheduler(); const connections = candidate('older-connections', 'link', 1);
  const background = candidate('duplicates', 'flag_duplicate', 2);
  const profiles = Array.from({ length: 8 }, (_, index) => candidate(`new-profile-${index}`, 'profile', 10 + index));
  const pending = [connections, background, ...profiles]; const order: string[] = [];
  while (pending.length) {
    const next = scheduler.select(pending)!; order.push(next.job.id); pending.splice(pending.indexOf(next), 1);
  }
  expect(order).toEqual([...profiles.slice(0, 6).map(item => item.job.id), 'older-connections', ...profiles.slice(6).map(item => item.job.id), 'duplicates']);
});
it('retains oldest user requests ahead of automation while reserving a slot for every other automatic action', () => {
  const scheduler = new JevJobScheduler();
  const background = candidate('connections', 'link', 1);
  const pending = [candidate('file', 'file', 9), background, candidate('duplicates', 'flag_duplicate', 2),
    candidate('owner-new', 'suggest_home_canvas', 5, true), candidate('owner-old', 'suggest_home_canvas', 3, true)];
  expect(scheduler.select(pending)?.job.id).toBe('owner-old');
  expect(scheduler.select(pending.filter(item => item.job.id !== 'owner-old'))?.job.id).toBe('owner-new');
  const automatic = pending.filter(item => item.job.principal.id === automationPrincipal.id);
  for (let index = 0; index < 6; index++) {
    expect(scheduler.select(automatic)?.job.id).toBe('file');
    expect(scheduler.select([])).toBeUndefined();
  }
  expect(scheduler.select(automatic)).toBe(background);
  expect(scheduler.select(automatic)?.job.id).toBe('file');
});
it('processes background-only work by age and keeps grouping advancing when no background work exists', () => {
  const scheduler = new JevJobScheduler();
  const file = candidate('file', 'file', 9);
  for (let index = 0; index < 9; index++) expect(scheduler.select([file])).toBe(file);
  const old = candidate('old', 'suggest_home_canvas', 1); const newer = candidate('new', 'link', 2);
  expect(scheduler.select([newer, old])).toBe(old);
  expect(scheduler.select([file, old])).toBe(file);
});

it('peeks without consuming a burst slot or changing candidate order while a workspace drains', () => {
  const scheduler = new JevJobScheduler(); const file = candidate('file', 'file', 2); const background = candidate('duplicates', 'flag_duplicate', 1);
  const pending = [background, file]; const original = [...pending];
  for (let index = 0; index < 20; index++) expect(scheduler.peek(pending)).toBe(file);
  expect(pending).toEqual(original); expect(scheduler.peek([])).toBeUndefined();
  for (let index = 0; index < 6; index++) {
    expect(scheduler.peek(pending)).toBe(file); expect(scheduler.select([file])).toBe(file);
  }
  for (let index = 0; index < 20; index++) expect(scheduler.peek(pending)).toBe(background);
  const manual = candidate('manual', 'file', 3, true);
  expect(scheduler.peek([...pending, manual])).toBe(manual); expect(scheduler.select([manual])).toBe(manual);
  expect(scheduler.peek(pending)).toBe(background); expect(scheduler.select([background])).toBe(background);
  expect(scheduler.peek(pending)).toBe(file);
});
