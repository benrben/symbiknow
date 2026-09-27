// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { CanvasDocument } from '../shared/types';
import type { InsightReport } from '../shared/insights';
import { InsightsPanel } from './InsightsPanel';

const canvas: CanvasDocument = {
  id: 'team canvas', name: 'Team', workspaceId: 'team', blocks: [
    { id: 'plan', title: 'Plan', file: 'plan.md', kind: 'markdown', content: '# Plan', x: 0, y: 0, width: 320, height: 240, links: [] },
    { id: 'guide', title: 'Guide', file: 'guide.md', kind: 'markdown', content: '# Guide', x: 400, y: 0, width: 320, height: 240, links: [] },
  ],
};

const report: InsightReport = {
  canvasId: canvas.id, query: 'onboarding', analyzed: 2, total: 2,
  readingOrder: [{ blockId: 'guide', title: 'Guide', score: 0.9, confidence: 0.8 }, { blockId: 'plan', title: 'Plan', score: 0.2, confidence: 0.7 }],
  relevance: [{ blockId: 'plan', title: 'Plan', score: 1.2, confidence: 1.2 }],
  items: [
    { id: 'edge', category: 'connection', title: 'Link the guide to the plan', detail: 'The plan is a useful next step.', blockIds: ['guide', 'plan'], confidence: 0.86, action: { type: 'link', fromBlockId: 'guide', toBlockId: 'plan' } },
    { id: 'review', category: 'conflict', title: 'Review conflicting dates', detail: 'Two launch dates are mentioned.', blockIds: ['missing'], confidence: -0.2 },
  ],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function props(overrides: Partial<Parameters<typeof InsightsPanel>[0]> = {}) {
  return {
    canvas,
    hasApiKey: true,
    onOpenSettings: vi.fn(),
    onApply: vi.fn(async () => {}),
    onOpenBlock: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Canvas insights panel', () => {
  it('shows document groups by work area, purpose, or lane, with every document reachable', async () => {
    const many: CanvasDocument = { ...canvas, blocks: [
      ...canvas.blocks.map(block => ({ ...block, workArea: 'sales' })),
      ...['one', 'two', 'three'].map(id => ({ ...canvas.blocks[0], id, title: id.toUpperCase(), workArea: 'sales' })),
      { ...canvas.blocks[0], id: 'api', title: 'API', workArea: 'backend', purpose: 'reference' },
    ] };
    const grouped: InsightReport = { ...report, readingOrder: [], classification: [
      { blockId: 'guide', title: 'Guide', lane: 'overview', laneConfidence: 0.9 }, { blockId: 'api', title: 'API', lane: 'reference', laneConfidence: 0.9 },
    ] };
    vi.mocked(fetch).mockResolvedValue(Response.json(grouped));
    const viewProps = props({ canvas: many });
    render(<InsightsPanel {...viewProps}/>);
    const dashboard = screen.getByRole('region', { name: 'Document groups' });
    expect(within(dashboard).getByText('Sales')).toBeTruthy();
    expect(within(dashboard).getByText('Backend')).toBeTruthy();
    fireEvent.click(within(dashboard).getByRole('button', { name: 'Show 1 more' }));
    expect(within(dashboard).getByRole('button', { name: 'THREE' })).toBeTruthy();
    fireEvent.click(within(dashboard).getByRole('button', { name: 'Guide' }));
    expect(viewProps.onOpenBlock).toHaveBeenCalledWith('guide');
    fireEvent.click(within(dashboard).getByRole('tab', { name: 'Purpose' }));
    expect(within(dashboard).getByText('Reference')).toBeTruthy();
    expect(within(dashboard).getByText(/5 not classified yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Analyze canvas' }));
    fireEvent.click(within(dashboard).getByRole('tab', { name: 'Reading lane' }));
    await waitFor(() => expect(within(dashboard).getByText('Reference')).toBeTruthy());
    expect(within(dashboard).getByText('Overview')).toBeTruthy();
  });

  it('explains setup and keeps analysis unavailable without a canvas or key', () => {
    const viewProps = props({ canvas: null, hasApiKey: false });
    render(<InsightsPanel {...viewProps}/>);
    expect(screen.getByText('Open a canvas to see its insights.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Analyze canvas' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Organize positions' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'Open Settings' }));
    expect(viewProps.onOpenSettings).toHaveBeenCalledOnce();
    fireEvent.submit(screen.getByRole('textbox', { name: /Focus your analysis/ }).closest('form')!);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('analyzes a focused query and lets people inspect and apply suggestions', async () => {
    vi.mocked(fetch).mockImplementation(async () => Response.json(report));
    const viewProps = props();
    render(<InsightsPanel {...viewProps}/>);
    fireEvent.change(screen.getByLabelText('Focus your analysis Optional'), { target: { value: 'onboarding' } });
    fireEvent.click(screen.getByRole('button', { name: 'Analyze canvas' }));

    await screen.findByText('2 of 2 docs analyzed');
    expect(fetch).toHaveBeenCalledWith('/api/canvases/team%20canvas/insights', expect.objectContaining({ method: 'POST', body: JSON.stringify({ query: 'onboarding' }) }));
    expect(screen.getByText('Focus: onboarding')).toBeTruthy();
    expect(screen.getByText('100%')).toBeTruthy();
    expect(screen.getByText('0% confident')).toBeTruthy();
    fireEvent.click(within(screen.getByRole('region', { name: 'Suggested reading order' })).getByRole('button', { name: 'Open Guide' }));
    expect(viewProps.onOpenBlock).toHaveBeenCalledWith('guide');
    fireEvent.click(screen.getByRole('button', { name: 'missing' }));
    expect(viewProps.onOpenBlock).toHaveBeenCalledWith('missing');

    fireEvent.click(screen.getByRole('button', { name: 'Apply suggestion' }));
    await waitFor(() => expect(viewProps.onApply).toHaveBeenCalledWith(report.items[0].action));
    await screen.findByRole('button', { name: 'Applied' });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    expect(fetch).toHaveBeenCalledWith('/api/canvases/team%20canvas/insights/feedback', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ itemId: 'edge', category: 'connection', confidence: 0.86, decision: 'applied' }),
    }));
    expect(screen.getByRole('button', { name: 'Applied' })).toHaveProperty('disabled', true);
  });

  it('shows report notices and Jev evidence, then dismisses a suggestion with feedback', async () => {
    const withEvidence: InsightReport = { ...report, notice: 'All documents fit one lane.',
      health: { orphanRatio: 0.5, duplicateRatio: 0.25, staleRatio: 0, meanQuality: 0.72, labelCoverage: 1 }, items: [
      { ...report.items[1], confidence: 0.72, evidence: [{ questionId: 'p0_conflict', answer: 'yes', excerpt: 'Launch is planned for 2026-10-01.' }] },
    ] };
    vi.mocked(fetch).mockImplementation(async () => Response.json(withEvidence));
    render(<InsightsPanel {...props()}/>);
    fireEvent.click(screen.getByRole('button', { name: 'Analyze canvas' }));
    await screen.findByText('All documents fit one lane.');
    const health = screen.getByRole('region', { name: 'Canvas health' });
    expect(within(health).getByText('72%')).toBeTruthy();
    expect(within(health).getByText('Mean quality')).toBeTruthy();

    fireEvent.click(screen.getByText('Why?'));
    expect(screen.getByText('p0_conflict')).toBeTruthy();
    expect(screen.getByText('Answer: yes')).toBeTruthy();
    expect(screen.getByText('Launch is planned for 2026-10-01.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    await waitFor(() => expect(screen.queryByText('Review conflicting dates')).toBeNull());
    expect(screen.getByText('No suggestions for this analysis.')).toBeTruthy();
    expect(fetch).toHaveBeenCalledWith('/api/canvases/team%20canvas/insights/feedback', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ itemId: 'review', category: 'conflict', confidence: 0.72, decision: 'dismissed' }),
    }));
  });

  it('keeps a suggestion visible when dismissal feedback fails', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(report))
      .mockResolvedValueOnce(Response.json({ error: 'Feedback unavailable' }, { status: 503 }));
    render(<InsightsPanel {...props()}/>);
    fireEvent.click(screen.getByRole('button', { name: 'Analyze canvas' }));
    await screen.findByText('Review conflicting dates');
    fireEvent.click(screen.getAllByRole('button', { name: 'Dismiss' })[1]);
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Could not dismiss suggestion. Feedback unavailable');
    expect(screen.getByText('Review conflicting dates')).toBeTruthy();
  });

  it('does not offer generic Apply for a merge plan', async () => {
    const mergeReport: InsightReport = { ...report, items: [{ id: 'merge', category: 'merge', title: 'Merge setup notes', detail: 'They overlap.',
      blockIds: ['guide', 'plan'], confidence: 0.9, action: { type: 'merge', keepBlockId: 'guide', mergeBlockIds: ['plan'], plan: { keep: 'guide', fold: [], conflicts: [], drop: [] } } }] };
    vi.mocked(fetch).mockImplementation(async () => Response.json(mergeReport));
    render(<InsightsPanel {...props()}/>);
    fireEvent.click(screen.getByRole('button', { name: 'Analyze canvas' }));
    await screen.findByText('Merge setup notes');
    expect(screen.queryByRole('button', { name: 'Apply suggestion' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy();
  });

  it('routes merge, missing document, move, and reading path actions to their review flows', async () => {
    const workflowReport: InsightReport = { ...report, readingPaths: [{ id: 'start', name: 'Getting started', blockIds: ['guide', 'plan'] }], items: [
      { id: 'merge', category: 'merge', title: 'Merge setup notes', detail: 'They overlap.', blockIds: ['guide', 'plan'], confidence: 0.9,
        action: { type: 'merge', keepBlockId: 'guide', mergeBlockIds: ['plan'], plan: { keep: 'guide', fold: [], conflicts: [], drop: [] } } },
      { id: 'move', category: 'move', title: 'Move Plan', detail: 'Belongs on another canvas.', blockIds: ['plan'], confidence: 0.85,
        action: { type: 'move', blockId: 'plan', toCanvasId: 'other' } },
      { id: 'gap', category: 'gap', title: 'Document an API', detail: 'Missing API guide.', blockIds: ['guide'], confidence: 0.8 },
    ] };
    vi.mocked(fetch).mockResolvedValue(Response.json(workflowReport));
    const viewProps = props({ onMergeDraft: vi.fn(), onDraftGap: vi.fn(), onStartPath: vi.fn() });
    render(<InsightsPanel {...viewProps}/>);
    fireEvent.click(screen.getByRole('button', { name: 'Analyze canvas' }));
    await screen.findByText('Merge setup notes');
    fireEvent.click(screen.getByRole('button', { name: 'Merge in chat' }));
    expect(viewProps.onMergeDraft).toHaveBeenCalledWith(workflowReport.items[0], workflowReport.items[0].action);
    fireEvent.click(screen.getByRole('button', { name: 'Draft it in chat' }));
    expect(viewProps.onDraftGap).toHaveBeenCalledWith(workflowReport.items[2]);
    fireEvent.click(screen.getByRole('button', { name: 'Start path' }));
    expect(viewProps.onStartPath).toHaveBeenCalledWith(workflowReport.readingPaths?.[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Move document' }));
    await waitFor(() => expect(viewProps.onApply).toHaveBeenCalledWith(workflowReport.items[1].action));
  });

  it('previews workspace changes by canvas, applies checked actions, and undoes the run', async () => {
    const preview = { runId: 'run-1', workspaceId: 'team', kind: 'tidy', dryRun: true,
      groups: [{ canvasId: 'team canvas', canvasName: 'Team', count: 2 }, { canvasId: 'other', canvasName: 'Other', count: 1 }],
      changes: [
        { id: 'one', canvasId: 'team canvas', confidence: 0.9, action: { type: 'update', blockId: 'guide', patch: { purpose: 'guide' } }, expectedContentHashes: {} },
        { id: 'merge', canvasId: 'team canvas', confidence: 0.8, action: { type: 'merge', keepBlockId: 'guide', mergeBlockIds: ['plan'], plan: { keep: 'guide', fold: [], conflicts: [], drop: [] } }, expectedContentHashes: {}, requiresClick: true },
        { id: 'two', canvasId: 'other', confidence: 0.85, action: { type: 'layout', positions: [{ blockId: 'other', x: 10, y: 20 }] }, expectedContentHashes: {} },
      ],
    };
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = String(input);
      if (path === '/api/workspaces/team/automations') {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json(body.dryRun === false ? { ...preview, dryRun: false, applied: body.actionIds, skipped: [] } : preview);
      }
      if (path === '/api/jev-runs/run-1/undo') return Response.json({ runId: 'run-1', reverted: ['one'], skipped: [] });
      return Response.json(report);
    });
    const viewProps = props({ onChanged: vi.fn() });
    render(<InsightsPanel {...viewProps}/>);
    fireEvent.click(screen.getByRole('button', { name: 'Preview workspace changes' }));
    const changeList = await screen.findByLabelText('Workspace change preview');
    expect(within(changeList).getByText('2 selected of 3 proposed changes')).toBeTruthy();
    expect(within(changeList).getByRole('region', { name: 'Team changes' })).toBeTruthy();
    expect(within(changeList).getByRole('region', { name: 'Other changes' })).toBeTruthy();
    expect(within(changeList).getByRole('checkbox', { name: 'Select Merge plan into guide' })).toHaveProperty('disabled', true);
    fireEvent.click(within(changeList).getByRole('checkbox', { name: 'Select all changes on Other' }));
    expect(within(changeList).getByText('1 selected of 3 proposed changes')).toBeTruthy();
    fireEvent.click(within(changeList).getByRole('button', { name: 'Apply selected (1)' }));
    await screen.findByText('Applied 1 change.');
    expect(fetch).toHaveBeenCalledWith('/api/workspaces/team/automations', expect.objectContaining({
      body: JSON.stringify({ kind: 'tidy', dryRun: false, runId: 'run-1', actionIds: ['one'] }),
    }));
    fireEvent.click(within(changeList).getByRole('button', { name: 'Undo this run' }));
    await screen.findByText('Reverted 1 change.');
    expect(fetch).toHaveBeenCalledWith('/api/jev-runs/run-1/undo', expect.objectContaining({ method: 'POST' }));
    expect(viewProps.onChanged).toHaveBeenCalledTimes(2);
  });

  it('shows server errors and can retry the analysis', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json({ error: 'Jev is unavailable' }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ ...report, readingOrder: [], relevance: [], items: [], query: '' }));
    render(<InsightsPanel {...props()}/>);
    fireEvent.click(screen.getByRole('button', { name: 'Analyze canvas' }));
    await screen.findByRole('alert');
    expect(screen.getByText('Jev is unavailable')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('No suggestions for this analysis.');
    expect(screen.getAllByText('No documents to show.')).toHaveLength(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps the apply action available after a failed write', async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json(report));
    const viewProps = props({ onApply: vi.fn().mockRejectedValue(new Error('Could not add the link')) });
    render(<InsightsPanel {...viewProps}/>);
    fireEvent.click(screen.getByRole('button', { name: 'Analyze canvas' }));
    await screen.findByRole('button', { name: 'Apply suggestion' });
    fireEvent.click(screen.getByRole('button', { name: 'Apply suggestion' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Could not add the link');
    expect(screen.getByRole('button', { name: 'Apply suggestion' })).toHaveProperty('disabled', false);
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('gives a useful message for an unexpected apply failure', async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json(report));
    render(<InsightsPanel {...props({ onApply: vi.fn().mockRejectedValue('offline') })}/>);
    fireEvent.click(screen.getByRole('button', { name: 'Analyze canvas' }));
    await screen.findByRole('button', { name: 'Apply suggestion' });
    fireEvent.click(screen.getByRole('button', { name: 'Apply suggestion' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Something went wrong. Please try again.');
  });

  it('shows progress while analysis and an action are pending', async () => {
    const analysis = deferred<Response>();
    const applying = deferred<void>();
    vi.mocked(fetch).mockImplementationOnce(() => analysis.promise).mockResolvedValue(Response.json(report));
    const viewProps = props({ onApply: vi.fn(() => applying.promise) });
    render(<InsightsPanel {...viewProps}/>);
    fireEvent.click(screen.getByRole('button', { name: 'Analyze canvas' }));
    expect(screen.getByRole('button', { name: 'Analyzing…' })).toHaveProperty('disabled', true);
    analysis.resolve(Response.json(report));
    await screen.findByRole('button', { name: 'Apply suggestion' });
    fireEvent.click(screen.getByRole('button', { name: 'Apply suggestion' }));
    expect(screen.getByRole('button', { name: 'Applying…' })).toHaveProperty('disabled', true);
    applying.resolve();
    await screen.findByRole('button', { name: 'Applied' });
  });

  it('ignores an old response when the open canvas changes', async () => {
    const oldRequest = deferred<Response>();
    vi.mocked(fetch).mockImplementationOnce(() => oldRequest.promise).mockResolvedValue(Response.json({ ...report, canvasId: 'next', query: '', items: [] }));
    const viewProps = props();
    const { rerender } = render(<InsightsPanel {...viewProps}/>);
    fireEvent.click(screen.getByRole('button', { name: 'Analyze canvas' }));
    const nextCanvas = { ...canvas, id: 'next', name: 'Next' };
    rerender(<InsightsPanel {...viewProps} canvas={nextCanvas}/>);
    oldRequest.resolve(Response.json(report));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Analyze canvas' })).toHaveProperty('disabled', false));
    expect(screen.queryByText('2 of 2 docs analyzed')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Analyze canvas' }));
    await screen.findByText('2 of 2 docs analyzed');
    expect(screen.queryByText('Link the guide to the plan')).toBeNull();
  });

  it('ignores a failed request from a canvas that is no longer open', async () => {
    const oldRequest = deferred<Response>();
    vi.mocked(fetch).mockImplementationOnce(() => oldRequest.promise);
    const viewProps = props();
    const { rerender } = render(<InsightsPanel {...viewProps}/>);
    fireEvent.click(screen.getByRole('button', { name: 'Analyze canvas' }));
    rerender(<InsightsPanel {...viewProps} canvas={{ ...canvas, id: 'next' }}/>);
    oldRequest.reject(new Error('Old request failed'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Analyze canvas' })).toHaveProperty('disabled', false));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not apply another suggestion while one action is pending', async () => {
    const secondItem = { ...report.items[0], id: 'other-edge', title: 'Another connection' };
    vi.mocked(fetch).mockResolvedValue(Response.json({ ...report, items: [report.items[0], secondItem] }));
    const pending = deferred<void>();
    const viewProps = props({ onApply: vi.fn(() => pending.promise) });
    render(<InsightsPanel {...viewProps}/>);
    fireEvent.click(screen.getByRole('button', { name: 'Analyze canvas' }));
    await screen.findByText('Another connection');
    const buttons = screen.getAllByRole('button', { name: 'Apply suggestion' });
    fireEvent.click(buttons[0]);
    fireEvent.click(buttons[1]);
    expect(viewProps.onApply).toHaveBeenCalledTimes(1);
    pending.resolve();
    await screen.findByRole('button', { name: 'Applied' });
  });

  it('does not reanalyze after an action completes on a different canvas', async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json(report));
    const pending = deferred<void>();
    const viewProps = props({ onApply: vi.fn(() => pending.promise) });
    const { rerender } = render(<InsightsPanel {...viewProps}/>);
    fireEvent.click(screen.getByRole('button', { name: 'Analyze canvas' }));
    await screen.findByRole('button', { name: 'Apply suggestion' });
    fireEvent.click(screen.getByRole('button', { name: 'Apply suggestion' }));
    rerender(<InsightsPanel {...viewProps} canvas={{ ...canvas, id: 'next' }}/>);
    pending.resolve();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Analyze canvas' })).toHaveProperty('disabled', false));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not show an action failure on a different canvas', async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json(report));
    const pending = deferred<void>();
    const viewProps = props({ onApply: vi.fn(() => pending.promise) });
    const { rerender } = render(<InsightsPanel {...viewProps}/>);
    fireEvent.click(screen.getByRole('button', { name: 'Analyze canvas' }));
    await screen.findByRole('button', { name: 'Apply suggestion' });
    fireEvent.click(screen.getByRole('button', { name: 'Apply suggestion' }));
    rerender(<InsightsPanel {...viewProps} canvas={{ ...canvas, id: 'next' }}/>);
    pending.reject(new Error('Old action failed'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Analyze canvas' })).toHaveProperty('disabled', false));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  function automationServer(results: Record<string, unknown> = {}) {
    const calls: Array<{ path: string; body: unknown }> = [];
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) as { kind: string } : null;
      calls.push({ path: String(input), body });
      const result = results[body?.kind ?? ''];
      if (result instanceof Error) return Response.json({ error: result.message }, { status: 502 });
      return Response.json(result ?? { kind: body?.kind, applied: 1 });
    });
    return calls;
  }

  it('organizes every document into groups with one server request', async () => {
    const calls = automationServer({ layout: { kind: 'layout', applied: 1, groupBy: 'work_area', groups: [{ key: 'area:sales', count: 1 }, { key: 'area:other', count: 1 }] } });
    const viewProps = props({ onChanged: vi.fn() });
    render(<InsightsPanel {...viewProps}/>);
    fireEvent.click(screen.getByRole('button', { name: 'Organize positions' }));
    expect(await screen.findByRole('status')).toHaveProperty('textContent', 'Placed 2 documents in 2 groups.');
    expect(calls).toEqual([{ path: '/api/canvases/team%20canvas/automations', body: { kind: 'layout', groupBy: 'work_area' } }]);
    expect(viewProps.onChanged).toHaveBeenCalledTimes(1);
    expect(viewProps.onApply).not.toHaveBeenCalled();
  });

  it('places groups by the selected grouping and regroups with links', async () => {
    const calls = automationServer({ regroup: { kind: 'regroup', applied: 3, groups: [{ key: 'purpose:plan', count: 2 }] } });
    render(<InsightsPanel {...props({ groupBy: 'purpose' })}/>);
    fireEvent.click(screen.getByRole('button', { name: 'Regroup & connect' }));
    expect(await screen.findByRole('status')).toHaveProperty('textContent', 'Placed 2 documents in 1 group and updated links.');
    fireEvent.click(screen.getByRole('tab', { name: 'Reading lane' }));
    fireEvent.click(screen.getByRole('button', { name: /Place these groups on the canvas/ }));
    await waitFor(() => expect(calls.at(-1)?.body).toEqual({ kind: 'layout', groupBy: 'lane' }));
    expect(calls[0].body).toEqual({ kind: 'regroup', groupBy: 'purpose' });
  });

  it('runs label, connection, and reviewer buttons without grouping options', async () => {
    const calls = automationServer({ purpose: { kind: 'purpose', applied: 2 }, work_area: { kind: 'work_area', applied: 1 }, connection: { kind: 'connection', applied: 0 } });
    render(<InsightsPanel {...props()}/>);
    fireEvent.click(screen.getByRole('button', { name: 'Label purposes' }));
    expect(await screen.findByRole('status')).toHaveProperty('textContent', 'Applied 2 purpose labels across this canvas.');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Classify work areas' })).toHaveProperty('disabled', false));
    fireEvent.click(screen.getByRole('button', { name: 'Classify work areas' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Applied 1 work-area label across this canvas.'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Connect documents' })).toHaveProperty('disabled', false));
    fireEvent.click(screen.getByRole('button', { name: 'Connect documents' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('No eligible connection changes found for this canvas.'));
    expect(calls.map(call => call.body)).toEqual([{ kind: 'purpose' }, { kind: 'work_area' }, { kind: 'connection' }]);
  });

  it('runs the cross-canvas connection automation and refreshes the canvas', async () => {
    const calls = automationServer({ cross_connect: { kind: 'cross_connect', applied: 2 } });
    const viewProps = props({ onChanged: vi.fn() });
    render(<InsightsPanel {...viewProps}/>);
    fireEvent.click(screen.getByRole('button', { name: 'Connect across canvases' }));
    expect(await screen.findByRole('status')).toHaveProperty('textContent', 'Applied 2 cross-canvas connections across this canvas.');
    expect(calls).toEqual([{ path: '/api/canvases/team%20canvas/automations', body: { kind: 'cross_connect' } }]);
    expect(viewProps.onChanged).toHaveBeenCalledTimes(1);
  });

  it('surfaces a failed canvas-wide automation without claiming completion', async () => {
    automationServer({ layout: new Error('Layout could not be saved') });
    render(<InsightsPanel {...props()}/>);
    fireEvent.click(screen.getByRole('button', { name: 'Organize positions' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Layout could not be saved');
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('button', { name: 'Organize positions' })).toHaveProperty('disabled', false);
  });

  it('ignores an automation result after the active canvas changes', async () => {
    const pending = deferred<Response>();
    vi.mocked(fetch).mockImplementation(() => pending.promise);
    const viewProps = props({ onChanged: vi.fn() });
    const { rerender } = render(<InsightsPanel {...viewProps}/>);
    fireEvent.click(screen.getByRole('button', { name: 'Label purposes' }));
    rerender(<InsightsPanel {...viewProps} canvas={{ ...canvas, id: 'next' }}/>);
    pending.resolve(Response.json({ kind: 'purpose', applied: 2 }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Label purposes' })).toHaveProperty('disabled', false));
    expect(viewProps.onChanged).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).toBeNull();
  });
});
