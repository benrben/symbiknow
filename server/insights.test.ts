import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CanvasStore } from './storage.js';
import { analyzeCanvas } from './insights.js';
import { runCanvasAutomation } from './automation.js';
import { estimateJevTokens, JEV_STATE_TOKEN_LIMIT, type JevAnswer, type JevDecider, type JevQuestion } from './jev.js';

let directory: string;
let store: CanvasStore;

function answerFor(id: string, question: JevQuestion, state: unknown): JevAnswer {
  if (question.type === 'noul') return { type: 'noul', noul: id.endsWith('_keep') ? 1 : 0.1 };
  if (question.type === 'score') {
    const index = id === 'd0_order' || id === 'd0_relevance' || id.endsWith('_link_strength') ? 4 : 0;
    return { type: 'score', score: index, confidence: 0.95,
      probabilities: Object.fromEntries(question.criteria.map((_, position) => [String(position), Number(position === index)])) };
  }
  const data = state as { document?: { kind: string } };
  let selected = id.endsWith('_loader') ? data.document!.kind
    : id.endsWith('_purpose') || id.endsWith('_work_area') ? 'other'
      : id.endsWith('_reviewer') || id.endsWith('_link') ? 'none' : Object.keys(question.criteria)[0];
  if (id === 'd0_loader') selected = 'mdx';
  if (id === 'd0_purpose') selected = 'plan';
  if (id === 'd0_reviewer') selected = 'r0';
  if (id === 'p0_link') selected = 'a_to_b';
  return { type: 'choice', choice: selected, confidence: 0.94,
    probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, Number(key === selected)])) };
}

function fakeDecider(overrides: Record<string, JevAnswer> = {}): JevDecider {
  return async (_key, state, questions) => Object.fromEntries(Object.entries(questions)
    .map(([id, question]) => [id, overrides[id] ?? answerFor(id, question, state)]));
}

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'symbiknow-insights-'));
  store = new CanvasStore(directory);
  await store.init();
  await store.updateSettings({ jevApiKey: 'private-key', reviewers: 'Ari, Bea' });
});

afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe('canvas insights', () => {
  it('saves Jev cross-canvas connections when related documents use different words', async () => {
    const workspace = await store.createWorkspace({ name: 'Service links' });
    const first = await store.createCanvas(workspace.id, { name: 'Reliability' });
    const second = await store.createCanvas(workspace.id, { name: 'Operations' });
    const source = await store.createBlock(first.id, { title: 'Throttle recovery',
      content: 'Delay retries after overload responses.' });
    const target = await store.createBlock(second.id, { title: 'Rate limit policy',
      content: 'Pause requests when throttling occurs.' });
    const decider: JevDecider = async (_key, _state, questions) => Object.fromEntries(Object.entries(questions).map(([id, question]) => {
      if (question.type === 'score') return [id, { type: 'score', score: 4, confidence: 0.95,
        probabilities: { '0': 0, '1': 0, '2': 0, '3': 0, '4': 1 } }];
      if (question.type !== 'choice') throw new Error('Expected a Jev choice');
      const choice = id.endsWith('_relation') ? 'same_topic' : 'a_to_b';
      return [id, { type: 'choice', choice, confidence: 0.95,
        probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, Number(key === choice)])) }];
    }));
    expect(await runCanvasAutomation(store, first.id, 'cross_connect', decider)).toMatchObject({ applied: 1 });
    expect((await store.getCanvas(first.id)).blocks.find(block => block.id === source.id)?.crossLinks).toEqual([
      expect.objectContaining({ canvasId: second.id, blockId: target.id, relation: 'same_topic' }),
    ]);
  });

  it('uses a custom work area alongside the built-in choices', async () => {
    await store.updateSettings({ workAreas: 'Field Engineering, Sales Strategy' });
    const decider: JevDecider = async (key, state, questions) => {
      if (questions.d0_domain?.type === 'choice') return fakeDecider({ d0_domain: {
        type: 'choice', choice: 'workspace', confidence: 0.94,
        probabilities: Object.fromEntries(Object.keys(questions.d0_domain.criteria).map(value => [value, Number(value === 'workspace')])),
      } })(key, state, questions);
      const workArea = questions.d0_work_area;
      if (!workArea) return fakeDecider()(key, state, questions);
      expect(workArea.type).toBe('choice');
      if (workArea.type !== 'choice') throw new Error('Expected a work-area choice');
      expect(workArea.criteria).toHaveProperty('field_engineering');
      expect(workArea.criteria).toHaveProperty('sales_strategy');
      expect(Object.keys(workArea.criteria).length).toBeLessThan(100);
      return fakeDecider({ d0_work_area: {
        type: 'choice', choice: 'field_engineering', confidence: 0.94,
        probabilities: Object.fromEntries(Object.keys(workArea.criteria).map(value => [value, Number(value === 'field_engineering')])),
      } })(key, state, questions);
    };
    const report = await analyzeCanvas(store, 'product-roadmap', '', decider);
    expect(report.items.find(item => item.category === 'work_area')).toMatchObject({
      title: 'Label Roadmap overview for field engineering',
      action: { type: 'update', blockId: 'roadmap-overview', patch: { workArea: 'workspace/field_engineering' } },
    });
  });

  it('reuses cached decisions and reasks only an edited document', async () => {
    const decider = vi.fn(fakeDecider());
    await analyzeCanvas(store, 'product-roadmap', '', decider, { families: ['purpose'] });
    expect(decider).toHaveBeenCalled();
    decider.mockClear();
    await analyzeCanvas(store, 'product-roadmap', '', decider, { families: ['purpose'] });
    expect(decider).not.toHaveBeenCalled();

    await store.updateBlock('product-roadmap', 'roadmap-overview', { content: '# Updated roadmap\nThe schedule changed.' });
    await analyzeCanvas(store, 'product-roadmap', '', decider, { families: ['purpose'] });
    expect(decider).toHaveBeenCalledTimes(1);
    expect(Object.keys(decider.mock.calls[0][2])).toEqual(['d0_purpose']);
  });

  it('selects the Marp loader deterministically without a Jev question', async () => {
    const workspace = await store.createWorkspace({ name: 'Slides' });
    const canvas = await store.createCanvas(workspace.id, { name: 'Deck' });
    const block = await store.createBlock(canvas.id, {
      title: 'Quarterly deck', kind: 'markdown', content: '---\nmarp: true\n---\n# First slide\n---\n# Second slide',
    });
    const decider = vi.fn(fakeDecider());
    const report = await analyzeCanvas(store, canvas.id, '', decider, { families: ['loader'] });
    expect(decider).not.toHaveBeenCalled();
    expect(report.items.find(item => item.category === 'loader')).toMatchObject({
      confidence: 1, action: { type: 'update', blockId: block.id, patch: { kind: 'slides' } },
    });
  });

  it('keeps a lower-confidence connection review-only during automation', async () => {
    const workspace = await store.createWorkspace({ name: 'Links' });
    const canvas = await store.createCanvas(workspace.id, { name: 'Related' });
    const content = '# Launch checklist\nReview the milestones, owners, and release criteria before launch.';
    const first = await store.createBlock(canvas.id, { title: 'Launch checklist', content });
    const second = await store.createBlock(canvas.id, { title: 'Launch review', content });
    const decider = fakeDecider({
      p0_link: { type: 'choice', choice: 'a_to_b', confidence: 0.7,
        probabilities: { a_to_b: 0.7, b_to_a: 0, none: 0.3 } },
    });
    const report = await analyzeCanvas(store, canvas.id, '', decider, { families: ['links'] });
    expect(report.items.find(item => item.category === 'connection')).toMatchObject({
      confidence: 0.7, blockIds: [first.id, second.id],
    });
    expect(report.items.find(item => item.category === 'connection')?.references?.map(source => source.documentId))
      .toEqual([first.id, second.id]);
    expect(report.items.find(item => item.category === 'connection')).not.toHaveProperty('action');
    expect(await runCanvasAutomation(store, canvas.id, 'connection', decider)).toMatchObject({ applied: 0 });
    expect((await store.getCanvas(canvas.id)).blocks.every(block => block.links.length === 0)).toBe(true);
  });

  it('ranks documents and emits reviewable Jev suggestions without writing data', async () => {
    const before = await store.getCanvas('product-roadmap');
    const calls: unknown[] = [];
    const decider: JevDecider = async (key, state, questions) => {
      expect(key).toBe('private-key');
      calls.push({ state, questions });
      return fakeDecider({
        d0_stale_marked: { type: 'noul', noul: 0.91 },
        d0_steps: { type: 'noul', noul: 0.75 },
        p0_duplicate: { type: 'noul', noul: 0.88 },
        p0_conflict: { type: 'noul', noul: 0.72 },
      })(key, state, questions);
    };
    const startedAt = Date.now();
    const report = await analyzeCanvas(store, 'product-roadmap', 'roadmap', decider);
    expect(report).toMatchObject({ canvasId: 'product-roadmap', query: 'roadmap', analyzed: 5, total: 5 });
    expect(report.readingOrder.at(-1)?.blockId).toBe('roadmap-overview');
    expect(report.relevance[0].blockId).toBe('roadmap-overview');
    expect(report.readingOrder[0].lane).toBe('overview');
    expect(report.items.map(item => item.category)).toEqual(expect.arrayContaining([
      'purpose', 'stale', 'reviewer', 'conflict', 'layout',
    ]));
    expect(report.items.find(item => item.category === 'loader')).toBeUndefined();
    const reference = report.items.find(item => item.category === 'purpose')?.references?.[0];
    expect(reference).toMatchObject({ canvasId: 'product-roadmap', documentId: 'roadmap-overview',
      contentHash: expect.any(String), navigation: { kind: 'document', canvasId: 'product-roadmap', blockId: 'roadmap-overview' } });
    expect(Date.parse(reference!.checkedAt)).toBeGreaterThanOrEqual(startedAt);
    const source = before.blocks.find(block => block.id === reference!.documentId)!;
    if (reference!.passageKind === 'exact') expect(source.content).toContain(reference!.passage);
    else expect(reference!.passageLabel).toContain('verify the claim');
    expect(report.items.find(item => item.category === 'reviewer')?.action).toEqual({
      type: 'update', blockId: 'roadmap-overview', patch: { reviewer: 'Ari' },
    });
    const layout = report.items.find(item => item.category === 'layout');
    expect(layout?.action?.type).toBe('layout');
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const after = await store.getCanvas('product-roadmap');
    const userFields = (canvas: typeof before) => canvas.blocks.map(block => ({
      id: block.id, title: block.title, kind: block.kind, content: block.content,
      purpose: block.purpose, reviewer: block.reviewer, workArea: block.workArea, links: block.links,
    }));
    expect(userFields(after)).toEqual(userFields(before));
  });

  it('suggests a new directed edge only when it is absent', async () => {
    const report = await analyzeCanvas(store, 'product-roadmap', '', fakeDecider());
    expect(report.relevance).toHaveLength(5);
    const connections = report.items.filter(item => item.category === 'connection');
    expect(connections.every(item => item.action?.type === 'link')).toBe(true);
    expect(connections.length).toBeLessThanOrEqual(1);
  });

  it('asks Jev whether every saved edge should remain and proposes removing rejected links', async () => {
    const decider: JevDecider = async (key, state, questions) => {
      const answers = await fakeDecider()(key, state, questions);
      for (const id of Object.keys(questions)) {
        if (id.endsWith('_keep')) answers[id] = { type: 'noul', noul: 0.05 };
      }
      return answers;
    };
    const report = await analyzeCanvas(store, 'product-roadmap', '', decider);
    const removals = report.items.filter(item => item.action?.type === 'unlink');
    expect(removals).toHaveLength(3);
    expect(removals.every(item => item.category === 'connection' && item.confidence === 0.95)).toBe(true);
    expect(await store.getCanvas('product-roadmap')).toMatchObject({ blocks: expect.arrayContaining([
      expect.objectContaining({ id: 'roadmap-overview', links: ['launch-flow'] }),
    ]) });
  });

  it('shows uncertain candidates for review without applying an action', async () => {
    await store.updateBlock('product-roadmap', 'roadmap-overview', { content: '# Slide one\n---\n# Slide two' });
    const low = await analyzeCanvas(store, 'product-roadmap', '', fakeDecider({
      d0_loader: { type: 'choice', choice: 'mdx', confidence: 0.7, probabilities: { markdown: 0.3, slides: 0, website: 0, mdx: 0.7 } },
      d0_purpose: { type: 'choice', choice: 'plan', confidence: 0.5, probabilities: { guide: 0, decision: 0, plan: 0.5, reference: 0, meeting: 0, other: 0.5 } },
      d0_reviewer: { type: 'choice', choice: 'r0', confidence: 0.6, probabilities: { r0: 0.6, r1: 0, none: 0.4 } },
    }));
    expect(low.items.find(item => item.id === 'loader-roadmap-overview')).not.toHaveProperty('action');
    expect(low.items.find(item => item.id === 'purpose-roadmap-overview')).toBeUndefined();
    expect(low.items.find(item => item.id === 'reviewer-roadmap-overview')).toBeUndefined();
  });

  it('batches decisions and lays out every document on a larger canvas', async () => {
    for (let index = 0; index < 9; index++) await store.createBlock('product-roadmap', { title: `Extra ${index}` });
    const batches: number[] = [];
    const pairedTitles = new Set<string>();
    const decider: JevDecider = async (key, state, questions) => {
      batches.push(Object.keys(questions).length);
      const pair = (state as { pair?: { first: { title: string }; second: { title: string } } }).pair;
      if (pair) {
        pairedTitles.add(pair.first.title);
        pairedTitles.add(pair.second.title);
      }
      const answers = await fakeDecider()(key, state, questions);
      for (const id of Object.keys(questions)) {
        if (id.endsWith('_link')) answers[id] = { type: 'choice', choice: 'a_to_b', confidence: 0.9,
          probabilities: { a_to_b: 0.9, b_to_a: 0.1, none: 0 } };
      }
      return answers;
    };
    const report = await analyzeCanvas(store, 'product-roadmap', '', decider);
    expect(report).toMatchObject({ analyzed: 14, total: 14 });
    expect(report.items.find(item => item.category === 'layout')?.action).toMatchObject({
      type: 'layout', positions: expect.arrayContaining(report.readingOrder.map(block => expect.objectContaining({ blockId: block.blockId }))),
    });
    expect(batches.length).toBeGreaterThan(2);
    expect(batches.every(size => size <= 18 * 9)).toBe(true);
    expect([...pairedTitles]).toEqual(expect.arrayContaining(Array.from({ length: 9 }, (_, index) => `Extra ${index}`)));
    const groups = report.readingOrder.reduce((counts, block) => {
      const lane = block.lane ?? 'overview';
      counts.set(lane, (counts.get(lane) ?? 0) + 1);
      return counts;
    }, new Map<string, number>());
    expect(groups.size).toBe(1);
    expect([...groups.values()]).toEqual([14]);
    expect(report.items.filter(item => item.category === 'connection')).toHaveLength(3);
  }, 20_000);

  it('uses Jev lane choices and reading scores to place documents', async () => {
    const decider: JevDecider = async (key, state, questions) => ({
      ...await fakeDecider()(key, state, questions),
      ...(questions.d1_lane ? { d1_lane: { type: 'choice', choice: 'work', confidence: 0.95,
        probabilities: { overview: 0, work: 0.95, reference: 0.05, followup: 0 } } } : {}),
    });
    const report = await analyzeCanvas(store, 'product-roadmap', '', decider, { groupBy: 'lane' });
    const positions = report.items.find(item => item.category === 'layout')?.action;
    expect(positions?.type).toBe('layout');
    if (positions?.type !== 'layout') throw new Error('Expected a layout action');
    const blocks = (await store.getCanvas('product-roadmap')).blocks;
    const first = positions.positions.find(position => position.blockId === blocks[0].id)!;
    const second = positions.positions.find(position => position.blockId === blocks[1].id)!;
    expect(first.group).toBe('lane:overview');
    expect(second.group).toBe('lane:work');
    // The work lane has the lowest reading scores, so its group comes first; groups keep a visible gap.
    expect(second.x).toBe(80);
    expect(first.x).toBeGreaterThanOrEqual(80 + blocks[1].width + 160);
    expect(positions.positions).toHaveLength(blocks.length);
    expect(report.readingOrder.find(block => block.blockId === blocks[1].id)?.lane).toBe('work');
    expect(report.classification?.find(entry => entry.blockId === blocks[1].id)).toMatchObject({ lane: 'work', laneConfidence: 0.95 });
  });

  it('asks only the questions an automation needs and reuses saved labels for grouping', async () => {
    await store.updateBlock('product-roadmap', 'launch-flow', { workArea: 'devops' });
    const asked: string[] = [];
    const decider: JevDecider = async (key, state, questions) => {
      asked.push(...Object.keys(questions));
      return fakeDecider()(key, state, questions);
    };
    const { automationFamilies } = await import('./insights.js');
    const report = await analyzeCanvas(store, 'product-roadmap', '', decider, { families: automationFamilies('layout', 'work_area'), reuseLabels: true, groupBy: 'work_area' });
    expect(new Set(asked.map(id => id.replace(/^d\d+_/, '')))).toEqual(new Set(['order', 'domain', 'work_area']));
    expect(asked).not.toContain('d1_work_area');
    expect(report.classification?.find(entry => entry.blockId === 'launch-flow')).toMatchObject({ workArea: 'devops', workAreaConfidence: 1 });
    asked.length = 0;
    await analyzeCanvas(store, 'product-roadmap', '', decider, { families: automationFamilies('reviewer', 'work_area') });
    expect(asked.every(id => id.endsWith('_reviewer'))).toBe(true);
    asked.length = 0;
    await analyzeCanvas(store, 'product-roadmap', '', decider, { families: automationFamilies('connection', 'work_area') });
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every(id => /^(?:p\d+_(?:link|link_strength|keep|supersedes|rel_ab|rel_ba)|r\d+_reflected)$/.test(id))).toBe(true);
  });

  it('handles empty canvases and rejects invalid queries or absent settings', async () => {
    const workspace = await store.createWorkspace({ name: 'Empty' });
    const canvas = await store.createCanvas(workspace.id, { name: 'Blank' });
    const decider = vi.fn(fakeDecider());
    expect(await analyzeCanvas(store, canvas.id, '', decider)).toMatchObject({ analyzed: 0, total: 0, items: [] });
    expect(decider).not.toHaveBeenCalled();
    await expect(analyzeCanvas(store, canvas.id, 'x'.repeat(201), decider)).rejects.toMatchObject({ status: 400 });
    await store.updateSettings({ jevApiKey: '' });
    await expect(analyzeCanvas(store, 'product-roadmap', '', decider)).rejects.toMatchObject({ status: 400 });
    expect(decider).not.toHaveBeenCalled();
  });

  it('handles one document, missing reviewer settings, and no pair batch', async () => {
    const workspace = await store.createWorkspace({ name: 'Solo' });
    const canvas = await store.createCanvas(workspace.id, { name: 'One' });
    await store.createBlock(canvas.id, { title: '###', content: '!' });
    await writeFile(path.join(directory, 'settings.json'), JSON.stringify({
      provider: 'openrouter', model: '', systemPrompt: '', jevApiKey: 'private-key',
    }));
    const calls: unknown[] = [];
    const decider: JevDecider = async (key, state, questions) => {
      calls.push(questions);
      return fakeDecider()(key, state, questions);
    };
    const report = await analyzeCanvas(store, canvas.id, '', decider);
    expect(report).toMatchObject({ analyzed: 1, total: 1 });
    expect(report.relevance).toHaveLength(1);
    expect(report.items.find(item => item.category === 'layout')).toBeUndefined();
    expect(report.items.find(item => item.category === 'reviewer')).toBeUndefined();
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.every(questions => Object.keys(questions as object).every(id => id.startsWith('d0_')))).toBe(true);
  });

  it('keeps lower-confidence purpose, reviewer, link, and layout ideas review-only', async () => {
    const decider: JevDecider = async (key, state, questions) => {
      const base = await fakeDecider()(key, state, questions);
      for (const [id, answer] of Object.entries(base)) {
        if (id.endsWith('_order') && answer.type === 'score') base[id] = { ...answer, confidence: 0.7 };
        if (id.endsWith('_link') && answer.type === 'choice') base[id] = { ...answer, choice: 'a_to_b', confidence: 0.7 };
      }
      if (questions.d0_purpose) base.d0_purpose = { type: 'choice', choice: 'plan', confidence: 0.7,
        probabilities: { guide: 0, decision: 0, plan: 0.7, reference: 0, meeting: 0, other: 0.3 } };
      if (questions.d0_reviewer) base.d0_reviewer = { type: 'choice', choice: 'r0', confidence: 0.7,
        probabilities: { r0: 0.7, r1: 0, none: 0.3 } };
      return base;
    };
    const report = await analyzeCanvas(store, 'product-roadmap', '', decider);
    for (const category of ['purpose', 'reviewer', 'layout', 'connection'] as const) {
      expect(report.items.find(item => item.category === category)).not.toHaveProperty('action');
    }
  });

  it('omits layout suggestions when reading order confidence is low', async () => {
    const decider: JevDecider = async (key, state, questions) => {
      const base = await fakeDecider()(key, state, questions);
      for (const [id, answer] of Object.entries(base)) {
        if (id.endsWith('_order') && answer.type === 'score') base[id] = { ...answer, confidence: 0.4 };
      }
      return base;
    };
    const report = await analyzeCanvas(store, 'product-roadmap', '', decider);
    expect(report.items.find(item => item.category === 'layout')).toBeUndefined();
  });

  it('uses a reverse edge and suppresses a link that already exists', async () => {
    const workspace = await store.createWorkspace({ name: 'Pairs' });
    const canvas = await store.createCanvas(workspace.id, { name: 'Two' });
    const a = await store.createBlock(canvas.id, { title: 'First', content: '# Shared launch plan\nPrepare release checklist and review the launch criteria.' });
    const b = await store.createBlock(canvas.id, { title: 'Second', content: '# Shared launch plan\nPrepare release checklist and review the launch criteria.' });
    const reverse = await analyzeCanvas(store, canvas.id, '', fakeDecider({
      p0_link: { type: 'choice', choice: 'b_to_a', confidence: 0.95,
        probabilities: { a_to_b: 0, b_to_a: 0.95, none: 0.05 } },
    }));
    expect(reverse.items.find(item => item.category === 'connection')?.action).toMatchObject({
      type: 'link', fromBlockId: b.id, toBlockId: a.id,
    });
    await store.updateBlock(canvas.id, a.id, { links: [b.id] });
    const existing = await analyzeCanvas(store, canvas.id, '', fakeDecider({
      p0_link: { type: 'choice', choice: 'a_to_b', confidence: 0.95,
        probabilities: { a_to_b: 0.95, b_to_a: 0, none: 0.05 } },
    }));
    expect(existing.items.find(item => item.category === 'connection')).toBeUndefined();
  });

  it('requires a useful Jev link score before suggesting a connection', async () => {
    const report = await analyzeCanvas(store, 'product-roadmap', '', fakeDecider({
      p0_link_strength: { type: 'score', score: 1, confidence: 1,
        probabilities: { '0': 0, '1': 1, '2': 0, '3': 0, '4': 0 } },
    }));
    expect(report.items.find(item => item.category === 'connection')).toBeUndefined();
  });

  it('keeps pair requests bounded when many long documents overlap', async () => {
    const workspace = await store.createWorkspace({ name: 'Large pairs' });
    const canvas = await store.createCanvas(workspace.id, { name: 'Long related documents' });
    for (let index = 0; index < 8; index++) await store.createBlock(canvas.id, {
      title: `Shared process ${index}`,
      content: `# Shared process ${index}\n\n${'Review the same setup, approval, and release steps. '.repeat(100)}`,
    });
    const sizes: number[] = [];
    const decider: JevDecider = async (key, state, questions) => {
      sizes.push(JSON.stringify(state).length);
      return fakeDecider()(key, state, questions);
    };
    await analyzeCanvas(store, canvas.id, '', decider, { families: ['links', 'similarity'] });
    expect(sizes.length).toBeGreaterThan(1);
    expect(Math.max(...sizes)).toBeLessThan(50_000);
  });

  it('rejects malformed decision responses at each interpretation point', async () => {
    for (const id of ['d0_order', 'd0_loader', 'd0_stale_marked']) {
      const decider: JevDecider = async (key, state, questions) => ({
        ...await fakeDecider()(key, state, questions),
        [id]: id === 'd0_stale_marked' ? { type: 'choice', choice: 'none', confidence: 1, probabilities: { none: 1 } }
          : { type: 'noul', noul: 0.5 },
      });
      await expect(analyzeCanvas(store, 'product-roadmap', '', decider)).rejects.toMatchObject({ status: 502 });
    }
  });

  it('excludes the latest author from the reviewer options offered to Jev', async () => {
    const workspace = await store.createWorkspace({ name: 'Reviewers' });
    const canvas = await store.createCanvas(workspace.id, { name: 'Docs' });
    const block = await store.createBlock(canvas.id, { title: 'Runbook', content: '# Runbook\n1. Install\n2. Configure\n3. Verify' }, 'Ari');
    await store.updateBlock(canvas.id, block.id, { content: '# Runbook\n1. Install\n2. Configure\n3. Verify the setup' }, 'Ari');
    let criteria: Record<string, string> | undefined;
    const decider: JevDecider = async (key, state, questions) => {
      if (questions.d0_reviewer?.type === 'choice') criteria = questions.d0_reviewer.criteria;
      return fakeDecider()(key, state, questions);
    };
    await analyzeCanvas(store, canvas.id, '', decider, { families: ['reviewer'] });
    expect(criteria).toBeDefined();
    expect(Object.values(criteria!).some(value => value.startsWith('Ari'))).toBe(false);
    expect(Object.values(criteria!).some(value => value.startsWith('Bea'))).toBe(true);
  });

  it('changes the relevance instruction text based on whether a query is set', async () => {
    let withQuery: string | undefined;
    let withoutQuery: string | undefined;
    const decider: JevDecider = async (key, state, questions) => {
      if (questions.d0_relevance) {
        if ((state as { query?: string }).query) withQuery = questions.d0_relevance.instructions;
        else withoutQuery = questions.d0_relevance.instructions;
      }
      return fakeDecider()(key, state, questions);
    };
    await analyzeCanvas(store, 'product-roadmap', 'roadmap timeline', decider, { families: ['relevance'] });
    await analyzeCanvas(store, 'product-roadmap', '', decider, { families: ['relevance'] });
    expect(withQuery).toBeDefined();
    expect(withoutQuery).toBeDefined();
    expect(withQuery).not.toBe(withoutQuery);
    expect(withQuery).toContain('state.query');
    expect(withoutQuery).toContain('state.canvasName');
  });

  it('extracts and compares dates in code, asking Jev only a literal criterion about them', async () => {
    const workspace = await store.createWorkspace({ name: 'Dates' });
    const canvas = await store.createCanvas(workspace.id, { name: 'Docs' });
    await store.createBlock(canvas.id, { title: 'Past doc', content: '# Notice\nThe migration deadline was 2020-01-15.' });
    await store.createBlock(canvas.id, { title: 'Future doc', content: '# Notice\nThe migration deadline is 2099-01-15.' });
    const seen = new Map<string, unknown>();
    const decider: JevDecider = async (key, state, questions) => {
      for (const id of Object.keys(questions)) if (id.endsWith('_stale_past')) seen.set(id, state);
      return fakeDecider()(key, state, questions);
    };
    await analyzeCanvas(store, canvas.id, '', decider, { families: ['stale'] });
    expect(seen.has('d0_stale_past')).toBe(true);
    expect(seen.has('d1_stale_past')).toBe(false);
    const pastState = seen.get('d0_stale_past') as { document: { pastDates: string[] } };
    expect(pastState.document.pastDates.some(text => text.includes('2020-01-15'))).toBe(true);
  });

  it('keeps every request state under the Jev token limit even for many long documents', async () => {
    const workspace = await store.createWorkspace({ name: 'Big' });
    const canvas = await store.createCanvas(workspace.id, { name: 'Sixty docs' });
    for (let index = 0; index < 60; index++) {
      await store.createBlock(canvas.id, { title: `Document number ${index} with a fairly long descriptive title`,
        content: `# Document ${index}\n\n${'This section repeats the same detailed explanation of the process. '.repeat(80)}` });
    }
    const sizes: number[] = [];
    const decider: JevDecider = async (key, state, questions) => {
      for (const question of Object.values(questions)) sizes.push(estimateJevTokens(state) + estimateJevTokens(question));
      return fakeDecider()(key, state, questions);
    };
    await analyzeCanvas(store, canvas.id, '', decider, { families: ['order', 'relevance', 'stale'] });
    expect(sizes.length).toBeGreaterThan(0);
    expect(Math.max(...sizes)).toBeLessThan(JEV_STATE_TOKEN_LIMIT);
  }, 20_000);

  it('never puts a block title inside a Jev instruction', async () => {
    const workspace = await store.createWorkspace({ name: 'Titles' });
    const canvas = await store.createCanvas(workspace.id, { name: 'Docs' });
    await store.createBlock(canvas.id, { title: 'Zephyr Onboarding Runbook', content: '# Setup\n1. Install\n2. Configure\n3. Verify' });
    await store.createBlock(canvas.id, { title: 'Second Distinct Title', content: '# Notes\nSome notes here.' });
    const instructions: string[] = [];
    const decider: JevDecider = async (key, state, questions) => {
      for (const question of Object.values(questions)) instructions.push(question.instructions);
      return fakeDecider()(key, state, questions);
    };
    await analyzeCanvas(store, canvas.id, '', decider);
    expect(instructions.length).toBeGreaterThan(0);
    expect(instructions.every(text => !text.includes('Zephyr Onboarding Runbook') && !text.includes('Second Distinct Title'))).toBe(true);
  });

  it("editing one document does not invalidate another document's cached answers", async () => {
    const workspace = await store.createWorkspace({ name: 'Isolation' });
    const canvas = await store.createCanvas(workspace.id, { name: 'Two docs' });
    await store.createBlock(canvas.id, { title: 'Doc A', content: '# Doc A\nOriginal content A.' });
    const b = await store.createBlock(canvas.id, { title: 'Doc B', content: '# Doc B\nOriginal content B.' });
    const decider = vi.fn(fakeDecider());
    await analyzeCanvas(store, canvas.id, '', decider, { families: ['stale', 'purpose'] });
    decider.mockClear();
    await store.updateBlock(canvas.id, b.id, { content: '# Doc B\nUpdated content B.' });
    await analyzeCanvas(store, canvas.id, '', decider, { families: ['stale', 'purpose'] });
    const askedIds = decider.mock.calls.flatMap(call => Object.keys(call[2] as object));
    expect(askedIds.some(id => id.startsWith('d1_'))).toBe(true);
    expect(askedIds.some(id => id.startsWith('d0_'))).toBe(false);
  });
});
