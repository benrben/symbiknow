import { expect, it } from 'vitest';
import { initializeJevStamp, sourceSnapshot } from '../stamps.js';
import { emptyJevWorkspace } from '../workspace.js';
import type { JevEvaluationContext, JevInputDocument } from './context.js';
import { topicCategoryCandidates } from './topic-category-candidates.js';

function document(id: string, content: string, canvasId = 'canvas', workspaceId = 'workspace'): JevInputDocument {
  const block = initializeJevStamp({ id, title: `Private heading ${id}`, content, tags: [`private-${id}`], group: `custom:private-${id}`,
    file: `${id}.md`, kind: 'markdown', x: 0, y: 0, width: 400, height: 300, links: [] });
  return { block, canvasId, snapshot: sourceSnapshot(workspaceId, canvasId, block) };
}
function context(documents: JevInputDocument[]): JevEvaluationContext {
  return { workspaceId: 'workspace', documents, canvases: [{ id: 'canvas', name: 'Knowledge' }], tasks: [], vocabulary: [], settings: emptyJevWorkspace().settings };
}
function names(input: JevEvaluationContext, source: JevInputDocument) { return topicCategoryCandidates(input, source).map(candidate => candidate.name); }

it('nominates broad reusable topics from private headings without shared H2s, tags, or folder names', () => {
  const access = document('access', '# Access control policy\nOwners manage billing, SSO and members. Agents use access tokens with read, propose or write scope. Access reviews happen quarterly.');
  const sso = document('sso', '# SSO security review\nThe SAML login flow must pass review before launch. Removed users must lose access.');
  const pricing = document('tiers', '# Pricing tiers decision\nLaunch with three tiers: Free $0; Pro $24 per month; Enterprise custom.');
  const copy = document('copy', '# Pricing page copy\nThe final Pro price must come from the pricing decision.');
  const release = document('rollback', '# Rollback runbook\nFreeze deploys. Redeploy the previous tagged build. Run smoke tests against production.');
  const blockers = document('blockers', '# Launch blockers\nSSO security review, pricing page copy and a session token rotation fix must close before launch.');
  const input = context([access, sso, pricing, copy, release, blockers]); const before = structuredClone(input);
  expect(names(input, access)[0]).toBe('Security'); expect(names(input, sso)[0]).toBe('Security');
  expect(names(input, pricing)).toContain('Pricing'); expect(names(input, copy)[0]).toBe('Pricing'); expect(names(input, release)[0]).toBe('Release');
  expect(names(input, blockers)).toEqual(expect.arrayContaining(['Security', 'Pricing', 'Release']));
  expect(topicCategoryCandidates(input, blockers)).toEqual(topicCategoryCandidates({ ...input, documents: [...input.documents].reverse() }, blockers));
  expect(topicCategoryCandidates(input, blockers).every(candidate => candidate.definition.length > 60 && candidate.origin === 'semantic_category_catalog')).toBe(true);
  expect(names(input, access).some(name => name.startsWith('Private') || name === 'Launch')).toBe(false);
  expect(input).toEqual(before);
});

it('nominates all general domains but bounds each document to eight candidates with local evidence first', () => {
  const local = document('local', 'Pricing tiers and subscriptions define paid plans.');
  const broad = document('broad', 'Security engineering software databases. Design UX accessibility. Product features requirements. Operations incidents. Research experiments. Legal contracts. Hiring employees. Marketing campaigns. Sales prospects. Support troubleshooting. Finance budgets. Planning milestones. Release deployments.');
  const result = topicCategoryCandidates(context([local, broad]), local);
  expect(result).toHaveLength(8); expect(result[0].name).toBe('Pricing');
  const separate = ['Security', 'Pricing', 'Release', 'Engineering', 'Design', 'Product', 'Operations', 'Research', 'Legal', 'People', 'Marketing', 'Sales', 'Support', 'Finance', 'Planning'];
  const prose = ['Security threats', 'Pricing tiers', 'Release rollout', 'Engineering databases', 'Design accessibility', 'Product features', 'Operations incidents', 'Research experiments', 'Legal contracts', 'Hiring employees', 'Marketing campaigns', 'Sales deals', 'Support tickets', 'Finance budgets', 'Planning milestones'];
  for (const [index, text] of prose.entries()) {
    const source = document(String(index), text); expect(names(context([source]), source)).toContain(separate[index]);
  }
});

it('never uses inaccessible, excluded, archived, deferred, stale, or foreign-canvas evidence', () => {
  const member = document('member', 'A quiet note about the garden.');
  const remote = document('remote', 'Security SSO Pricing Release', 'remote');
  const foreign = document('foreign', 'Security SSO Pricing Release', 'canvas', 'private');
  const excluded = document('excluded', 'Security SSO Pricing Release'); excluded.block.processingExcluded = true;
  const archived = document('archived', 'Security SSO Pricing Release'); archived.block.archived = true;
  const deferred = document('deferred', 'Security SSO Pricing Release'); deferred.block.contentLoaded = false;
  const stale = document('stale', 'Security SSO Pricing Release'); stale.snapshot.sourceGeneration += 1;
  const noStamp = document('unstamped', 'Security SSO Pricing Release'); delete noStamp.block.incarnation;
  const input = context([member, remote, foreign, excluded, archived, deferred, stale, noStamp]);
  expect(topicCategoryCandidates(input, member)).toEqual([]);
  for (const source of [foreign, excluded, archived, deferred, stale, noStamp]) expect(topicCategoryCandidates(input, source)).toEqual([]);
  expect(topicCategoryCandidates(context([]), member)).toEqual([]);
  const detached = document('member', 'Security SSO'); expect(topicCategoryCandidates(input, detached)).toEqual([]);
});

it('reads visible prose only, ignores code and hidden metadata, and does not classify a prose-free source using peers', () => {
  const hidden = document('hidden', '---\ntitle: Security\ntags: [Pricing]\n---\n```md\nRelease rollout\n```\n<script>Security auth</script>\nA garden note.');
  hidden.block.title = 'Security'; hidden.block.tags = ['Pricing']; hidden.block.group = 'custom:release';
  const input = context([hidden]); expect(topicCategoryCandidates(input, hidden)).toEqual([]);
  const code = document('code', '```ts\nconst token = "Security auth";\n```');
  const peer = document('peer', 'Security SSO access control policy'); expect(topicCategoryCandidates(context([code, peer]), code)).toEqual([]);
  const html = document('html', '<html><head><title>Pricing</title></head><body><pre>Release rollout</pre><script>Security</script><p hidden>Finance budgets</p><p>Authentication and permissions secure identities.</p></body></html>');
  expect(names(context([html]), html)).toEqual(['Security']);
});

it('recognizes readable RTL topic evidence without requiring English headings or labels', () => {
  const hebrew = document('hebrew', '# מדיניות הרשאות\nאימות משתמשים ואבטחת מידע מגנים על גישה למערכת.');
  const arabic = document('arabic', '# تسعير\nأسعار واشتراكات للمنتج.');
  expect(names(context([hebrew]), hebrew)).toEqual(['Security']); expect(names(context([arabic]), arabic)).toEqual(['Pricing']);
});
