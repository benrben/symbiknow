import { describe, expect, it } from 'vitest';
import { noul } from '../../jev.js';
import type { JevQuestionSet } from './question-set-collector.js';
import { sourceScopedQuestionGroups } from './question-source-scope.js';

const pricing = { id: 'pricing', title: 'Pricing decision', passages: [{ id: 'p0', text: 'Price is $49 per seat.' }], coverage: 1 };
const security = { id: 'security', title: 'SSO review', passages: [{ id: 'p0', text: 'SSO review requires a passing pen test.' }], coverage: .8 };
function set(state: Record<string, unknown>): JevQuestionSet {
  return { state, questions: { supported: noul('Does this exact document concern SSO?') } };
}

describe('exact visible source scopes for question batching', () => {
  it('keeps unrelated Pricing and SSO text in separate requests while grouping repeated Pricing judgments', () => {
    const sets = [set({ document: pricing }), set({ document: security }),
      set({ nested: [{ source: pricing }, { repeated: pricing }], candidate: 'SSO' })];
    const before = structuredClone(sets);
    const groups = sourceScopedQuestionGroups(sets);
    expect(groups.map(group => group.indices)).toEqual([[0, 2], [1]]);
    expect(groups.map(group => group.sets)).toEqual([[sets[0], sets[2]], [sets[1]]]);
    expect(groups[0].sets[0]).toBe(sets[0]);
    expect(groups[0].sets[1]).toBe(sets[2]);
    expect(sets).toEqual(before);
  });

  it('groups exact source sets independently of nesting, order, repeated objects, and scalar values', () => {
    const sets = [
      set({ sources: [pricing, security], ignored: [null, false, 0, 'literal text'] }),
      set({ ordinary: { only: 'Non-document context' } }),
      set({ target: { document: security }, source: pricing, repeated: [security, pricing] }),
      set({ ordinary: [{ value: true }, null, 12], blank: {} }),
      set({ source: pricing }),
    ];
    expect(sourceScopedQuestionGroups(sets).map(group => group.indices)).toEqual([[0, 2], [1, 3], [4]]);
  });

  it('does not mix newer text, different titles, excerpt IDs, or coverage under the same document ID', () => {
    const sets = [set({ source: pricing }),
      set({ source: { ...pricing, passages: [{ id: 'p0', text: 'Price is now $59 per seat.' }] } }),
      set({ source: { ...pricing, title: 'Revised pricing decision' } }),
      set({ source: { ...pricing, passages: [{ id: 'p2', text: pricing.passages[0].text }] } }),
      set({ source: { ...pricing, coverage: .5 } }),
      set({ source: { ...pricing, id: 'pricing-copy' } })];
    expect(sourceScopedQuestionGroups(sets).map(group => group.indices)).toEqual([[0], [1], [2], [3], [4], [5]]);
  });

  it('uses the pool exact-source detector and separates ordinary state from valid source state', () => {
    const lookalikes: unknown[] = [null, true, 7, 'literal source text', [], {},
      { ...pricing, extra: true }, { ...pricing, id: 7 }, { ...pricing, title: false },
      { ...pricing, coverage: -1 }, { ...pricing, coverage: 2 }, { ...pricing, coverage: NaN },
      { ...pricing, passages: 'Unstructured text' }, { ...pricing, passages: [null] },
      { ...pricing, passages: [{ id: 'p0', text: false }] },
      { ...pricing, passages: [{ id: 'p0', text: pricing.passages[0].text, extra: true }] }];
    const sets = lookalikes.map(value => set({ ordinary: value }));
    sets.push(set({ document: pricing }));
    const groups = sourceScopedQuestionGroups(sets);
    expect(groups.map(group => group.indices)).toEqual([lookalikes.map((_, index) => index), [lookalikes.length]]);
    expect(groups[0].sets).toHaveLength(lookalikes.length);
  });

  it('retains JSON wire projection and accepts empty excerpt arrays as exact source objects', () => {
    const withUndefined = { ...pricing, omitted: undefined };
    const empty = { ...security, passages: [], coverage: 0 };
    const sets = [set({ document: pricing }), set({ document: withUndefined }),
      set({ source: empty }), set({ nested: [empty] })];
    expect(sourceScopedQuestionGroups(sets).map(group => group.indices)).toEqual([[0, 1], [2, 3]]);
    expect(withUndefined).toHaveProperty('omitted', undefined);
  });

  it('separates filing context from same-document label and profile question batches', () => {
    const source = { workspaceId: 'workspace', canvasId: 'canvas', blockId: 'security', incarnation: 'inc-security',
      sourceGeneration: 1, contentHash: 'security-hash' };
    const origin = { source, quote: security.passages[0].text, start: 0, end: security.passages[0].text.length };
    const sets = [set({ document: pricing }), set({ source: pricing, organizationSignals: {}, selectedGroup: { origins: [origin] } }),
      set({ document: pricing }), set({ source: pricing, organizationSignals: {}, groups: [{ origins: [origin, origin] }] }),
      set({ source: pricing, organizationSignals: {}, selectedGroup: { origins: [{ ...origin, quote: 'Revised SSO review.' }] } })];
    expect(sourceScopedQuestionGroups(sets).map(group => group.indices)).toEqual([[0, 2], [1, 3, 4]]);
  });

  it('batches different proposed and selected group contexts only for the same exact primary source', () => {
    const origin = { source: { canvasId: 'canvas', blockId: 'security' }, quote: 'SSO review requires a pen test.', start: 0, end: 35 };
    const sets = [set({ source: pricing, organizationSignals: {}, proposedGroups: [{ key: 'pricing', origins: [] }] }),
      set({ source: pricing, organizationSignals: {}, selectedGroup: { key: 'security', origins: [origin] } }),
      set({ source: pricing, organizationSignals: {}, selectedGroup: { key: 'pricing', definition: 'Price per seat.' } }),
      set({ source: security, organizationSignals: {}, selectedGroup: { key: 'security', origins: [origin] } })];
    expect(sourceScopedQuestionGroups(sets).map(group => group.indices)).toEqual([[0, 1, 2], [3]]);
  });

  it('classifies filing by an own organizationSignals field without changing caller state or group context', () => {
    const inherited = Object.assign(Object.create({ organizationSignals: {} }), { source: pricing }) as Record<string, unknown>;
    const sets = [set({ source: pricing }), set({ source: pricing, organizationSignals: undefined }),
      set({ source: pricing, organizationSignals: null, selectedGroup: { name: 'Pricing' } }), set(inherited),
      set({ source: pricing, organizationSignals: false })];
    const before = sets.map(item => JSON.stringify(item.state));
    const groups = sourceScopedQuestionGroups(sets);
    expect(groups.map(group => group.indices)).toEqual([[0, 3], [1, 2, 4]]);
    expect(sets.map(item => JSON.stringify(item.state))).toEqual(before);
    expect(groups[1].sets[0]).toBe(sets[1]);
    expect(sets[1].state).toHaveProperty('organizationSignals', undefined);
    expect(Object.hasOwn(inherited, 'organizationSignals')).toBe(false);
  });

  it('returns no groups for no questions and retains input indices for restoring answer order', () => {
    expect(sourceScopedQuestionGroups([])).toEqual([]);
    const sets = [set({ document: pricing }), set({ document: security }), set({ document: pricing }), set({}), set({ document: security })];
    const groups = sourceScopedQuestionGroups(sets);
    const restored: string[] = [];
    for (const group of groups) group.indices.forEach((index, position) => { restored[index] = JSON.stringify(group.sets[position].state); });
    expect(restored).toEqual(sets.map(item => JSON.stringify(item.state)));
  });

  it('rejects reserved source-reference markers rather than silently treating them as missing document scope', () => {
    expect(() => sourceScopedQuestionGroups([set({ source: { $jevSourceRef: 0 } })]))
      .toThrow('Jev source reference markers are reserved');
  });
});
