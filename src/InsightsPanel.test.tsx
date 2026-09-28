// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { CanvasDocument } from '../shared/types';
import type { InsightReport, InsightItem } from '../shared/insights';
import { InsightsPanel } from './InsightsPanel';

const canvas: CanvasDocument = {
  id: 'team canvas', name: 'Team', workspaceId: 'team', blocks: [
    { id: 'plan', title: 'Plan', file: 'plan.md', kind: 'markdown', content: '# Plan', contentHash: 'one', x: 0, y: 0, width: 320, height: 240, links: [] },
    { id: 'guide', title: 'Guide', file: 'guide.md', kind: 'markdown', content: '# Guide', contentHash: 'two', x: 400, y: 0, width: 320, height: 240, links: [] },
  ],
};
const link: InsightItem = { id: 'edge', category: 'connection', title: 'Link the guide to the plan', detail: 'The plan is a useful next step.', blockIds: ['guide', 'plan'], confidence: 0.86,
  action: { type: 'link', fromBlockId: 'guide', toBlockId: 'plan' }, evidence: [{ questionId: 'related', answer: 'yes', excerpt: 'The plan follows the guide.', sourceIds: ['guide'], sourceHashes: { guide: 'two' } }] };
const report: InsightReport = {
  canvasId: canvas.id, query: 'onboarding', analyzed: 2, total: 2,
  readingOrder: [{ blockId: 'guide', title: 'Guide', score: 0.9, confidence: 0.8 }],
  relevance: [{ blockId: 'plan', title: 'Plan', score: 0.9, confidence: 0.8 }],
  items: [link, { id: 'conflict', category: 'conflict', title: 'Review conflicting dates', detail: 'Two dates are mentioned.', blockIds: ['plan'], confidence: 0.72 }],
  health: { orphanRatio: 0.5, duplicateRatio: 0, staleRatio: 0, meanQuality: 0.72, labelCoverage: 1 },
};
const emptyInbox = { canvasId: canvas.id, items: [], checkedBlockIds: ['plan'], pendingBlockIds: [], errors: [] };
const preview = { runId: 'canvas-run-1', workspaceId: 'team', kind: 'connection', dryRun: true, groups: [{ canvasId: canvas.id, canvasName: 'Team', count: 3 }], changes: [
  { id: 'link', canvasId: canvas.id, confidence: 0.91, action: link.action, expectedContentHashes: { guide: 'two' } },
  { id: 'label', canvasId: canvas.id, confidence: 0.8, action: { type: 'update', blockId: 'plan', patch: { purpose: 'plan' } }, expectedContentHashes: { plan: 'one' } },
  { id: 'merge', canvasId: canvas.id, confidence: 0.81, action: { type: 'merge', keepBlockId: 'guide', mergeBlockIds: ['plan'], plan: { keep: 'guide', fold: [], conflicts: [], drop: [] } }, expectedContentHashes: {}, requiresClick: true },
] };

type Call = { path: string; method: string; body?: Record<string, unknown> };
function server(handler: (call: Call) => Response | Promise<Response> = () => Response.json(report)) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = { path: String(input), method: init?.method ?? 'GET', ...(init?.body ? { body: JSON.parse(String(init.body)) as Record<string, unknown> } : {}) };
    calls.push(call);
    if (call.path.endsWith('/jev-inbox') && call.method === 'GET') return Response.json(emptyInbox);
    return handler(call);
  }));
  return calls;
}
function props(overrides: Partial<Parameters<typeof InsightsPanel>[0]> = {}) {
  return { canvas, hasApiKey: true, onOpenSettings: vi.fn(), onApply: vi.fn(async () => {}), onOpenBlock: vi.fn(), ...overrides };
}
function openAdvanced() { fireEvent.click(screen.getByRole('tab', { name: 'More' })); }
function openExplore() { fireEvent.click(screen.getByText('Explore the analysis')); }

beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Jev insights panel', () => {
  it('offers one primary analysis action and a compact review inbox', async () => {
    const calls = server();
    render(<InsightsPanel {...props()}/>);
    expect(screen.getByRole('button', { name: 'Analyze canvas' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'More' })).toBeTruthy();
    await screen.findByText('No new findings. Analyze the canvas for more ideas.');
    expect(calls[0].path).toBe('/api/canvases/team%20canvas/jev-inbox');
    expect(screen.getByRole('region', { name: 'Suggestions' })).toBeTruthy();
  });

  it('switches icon views in place while keeping review available', async () => {
    server();
    render(<InsightsPanel {...props()}/>);
    fireEvent.click(screen.getByRole('tab', { name: 'Groups' }));
    expect(screen.getByRole('tabpanel', { name: 'Groups view' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Suggestions' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Connections' }));
    expect(screen.getByRole('tabpanel', { name: 'Connections view' })).toBeTruthy();
    expect(screen.queryByRole('tabpanel', { name: 'Groups view' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Review' }));
    expect(await screen.findByRole('region', { name: 'Suggestions' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Review' }).getAttribute('aria-selected')).toBe('true');
  });

  it('moves a single keyboard tab stop with arrows, Home, and End', () => {
    server();
    render(<InsightsPanel {...props()}/>);
    const review = screen.getByRole('tab', { name: 'Review' });
    const groups = screen.getByRole('tab', { name: 'Groups' });
    review.focus();
    fireEvent.keyDown(review, { key: 'ArrowRight' });
    expect(groups.getAttribute('aria-selected')).toBe('true');
    expect(groups.tabIndex).toBe(0);
    expect(review.tabIndex).toBe(-1);
    expect(document.activeElement).toBe(groups);
    fireEvent.keyDown(groups, { key: 'End' });
    const more = screen.getByRole('tab', { name: 'More' });
    expect(document.activeElement).toBe(more);
    fireEvent.keyDown(more, { key: 'Home' });
    expect(document.activeElement).toBe(review);
  });

  it('routes a finding into task creation with its identity intact', async () => {
    server();
    const onCreateTask = vi.fn();
    render(<InsightsPanel {...props({ onCreateTask })}/>);
    fireEvent.click(screen.getByRole('button', { name: 'Analyze canvas' }));
    await screen.findByText(link.title);
    fireEvent.click(screen.getAllByRole('button', { name: 'Create task' })[0]);
    expect(onCreateTask).toHaveBeenCalledWith(link);
  });

  it('analyzes a query, groups suggestions, shows evidence and keeps document paths accessible', async () => {
    const calls = server();
    const viewProps = props();
    render(<InsightsPanel {...viewProps}/>);
    fireEvent.change(screen.getByRole('textbox', { name: /Focus your analysis/ }), { target: { value: 'onboarding' } });
    fireEvent.click(screen.getByRole('button', { name: 'Analyze canvas' }));
    await screen.findByText('2 of 2 docs analyzed');
    expect(calls.find(call => call.path.endsWith('/insights'))?.body).toEqual({ query: 'onboarding' });
    expect(screen.getByText('Ready to act')).toBeTruthy();
    expect(screen.getByText('Needs your review')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Canvas health' })).getByText('72%')).toBeTruthy();
    expect(screen.getAllByText('The plan follows the guide.').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText('Why? Evidence and technical details'));
    expect(screen.getByText('Technical reference')).toBeTruthy();
    openExplore();
    fireEvent.click(within(screen.getByRole('region', { name: 'Suggested reading order' })).getByRole('button', { name: 'Open Guide' }));
    expect(viewProps.onOpenBlock).toHaveBeenCalledWith('guide');
  });

  it('applies a suggestion, records feedback and refreshes analysis', async () => {
    const calls = server();
    const viewProps = props();
    render(<InsightsPanel {...viewProps}/>);
    fireEvent.click(screen.getByRole('button', { name: 'Analyze canvas' }));
    await screen.findByText(link.title);
    fireEvent.click(screen.getByRole('button', { name: 'Apply suggestion' }));
    await waitFor(() => expect(viewProps.onApply).toHaveBeenCalledWith(link.action));
    await waitFor(() => expect(calls.some(call => call.path.endsWith('/insights/feedback') && call.body?.decision === 'applied')).toBe(true));
    expect(calls.filter(call => call.path.endsWith('/insights'))).toHaveLength(2);
  });

  it('does not present an uncertain direct suggestion Apply as safe to repeat', async () => {
    server();
    render(<InsightsPanel {...props({ onApply: vi.fn(async () => { throw new Error('Save response lost'); }) })}/>);
    fireEvent.click(screen.getByRole('button', { name: 'Analyze canvas' }));
    await screen.findByText(link.title);
    fireEvent.click(screen.getByRole('button', { name: 'Apply suggestion' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Saved state may have changed');
    expect(screen.getByRole('button', { name: 'Apply suggestion' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'Analyze again' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply suggestion' })).toHaveProperty('disabled', false));
  });

  it('dismisses a suggestion only after feedback saves and keeps it on failure', async () => {
    const calls = server(call => call.path.endsWith('/feedback') ? Response.json({ error: 'Offline' }, { status: 503 }) : Response.json(report));
    render(<InsightsPanel {...props()}/>);
    fireEvent.click(screen.getByRole('button', { name: 'Analyze canvas' }));
    await screen.findByText('Review conflicting dates');
    fireEvent.click(within(screen.getByRole('region', { name: 'Suggestions' })).getAllByRole('button', { name: 'Dismiss' })[1]);
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Could not dismiss suggestion. Offline');
    expect(screen.getByText('Review conflicting dates')).toBeTruthy();
    expect(calls.some(call => call.body?.decision === 'dismissed')).toBe(true);
  });

  it('opens a targeted document analysis when requested from the canvas', async () => {
    const calls = server();
    render(<InsightsPanel {...props({ targetedRequest: { canvasId: canvas.id, blockIds: ['guide'], families: ['relation'], sequence: 1 } })}/>);
    await screen.findByText('2 of 2 docs analyzed');
    expect(calls.find(call => call.path.endsWith('/insights'))?.body).toEqual({ query: '', blockIds: ['guide'], families: ['relation'] });
  });

  it('opens duplicate tools when a document card requests a duplicate check', async () => {
    const calls = server(call => call.path.endsWith('/duplicates') ? Response.json([]) : Response.json(report));
    render(<InsightsPanel {...props({ duplicateRequest: { canvasId: canvas.id, blockId: 'guide', sequence: 1 } })}/>);
    await waitFor(() => expect(calls.some(call => call.path.endsWith('/duplicates') && call.body?.blockId === 'guide')).toBe(true));
    expect(screen.getByRole('tab', { name: 'Duplicates' }).getAttribute('aria-selected')).toBe('true');
  });

  it('loads inbox findings and sends item decisions to the inbox API', async () => {
    const inbox = { ...emptyInbox, items: [link], pendingBlockIds: ['plan'] };
    const calls = server(call => call.path.endsWith('/dismiss') ? Response.json(emptyInbox) : Response.json(inbox));
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ path, method });
      return Response.json(path.endsWith('/dismiss') ? emptyInbox : inbox);
    });
    render(<InsightsPanel {...props()}/>);
    await screen.findByText('Checking 1 changed document.');
    const region = screen.getByRole('region', { name: 'Suggestions' });
    expect(within(region).getByText(link.title)).toBeTruthy();
    fireEvent.click(within(region).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(within(region).queryByText(link.title)).toBeNull());
    expect(calls.some(call => call.path.endsWith('/jev-inbox/edge/dismiss') && call.method === 'POST')).toBe(true);
  });

  it('continues checking changed documents in small inbox batches', async () => {
    const paths: string[] = [];
    vi.mocked(fetch).mockImplementation(async input => {
      const path = String(input);
      paths.push(path);
      return Response.json(paths.filter(item => item.endsWith('/jev-inbox')).length === 1
        ? { ...emptyInbox, pendingBlockIds: ['guide'] } : emptyInbox);
    });
    render(<InsightsPanel {...props()}/>);
    await screen.findByText('Checking 1 changed document.');
    await waitFor(() => expect(paths.filter(path => path.endsWith('/jev-inbox'))).toHaveLength(2));
    await waitFor(() => expect(screen.queryByText('Checking 1 changed document.')).toBeNull());
  });

  it('applies an inbox item through the server and refreshes the canvas', async () => {
    const calls: Call[] = [];
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = String(input); const method = init?.method ?? 'GET'; calls.push({ path, method });
      return Response.json(path.endsWith('/apply') ? emptyInbox : { ...emptyInbox, items: [link] });
    });
    const viewProps = props({ onChanged: vi.fn() });
    render(<InsightsPanel {...viewProps}/>);
    const region = screen.getByRole('region', { name: 'Suggestions' });
    await within(region).findByText(link.title);
    fireEvent.click(within(region).getByRole('button', { name: 'Apply suggestion' }));
    await waitFor(() => expect(viewProps.onChanged).toHaveBeenCalledOnce());
    expect(calls.some(call => call.path.endsWith('/jev-inbox/edge/apply') && call.method === 'POST')).toBe(true);
  });

  it('routes inbox moves to review because inbox apply requires a direct, safe action', async () => {
    const move: InsightItem = { id: 'move', category: 'move', title: 'Move Plan', detail: 'Another canvas fits.', blockIds: ['plan'], confidence: 0.88,
      action: { type: 'move', blockId: 'plan', toCanvasId: 'other' } };
    const calls: Call[] = [];
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const call = { path: String(input), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined };
      calls.push(call);
      return Response.json(call.path.endsWith('/jev-inbox') ? { ...emptyInbox, items: [move] } : report);
    });
    render(<InsightsPanel {...props()}/>);
    await screen.findByText('Move Plan');
    expect(screen.queryByRole('button', { name: 'Move document' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Review in analysis' }));
    await screen.findByText('2 of 2 docs analyzed');
    expect(calls.find(call => call.path.endsWith('/insights'))?.body).toEqual({ query: '', blockIds: ['plan'] });
    expect(calls.some(call => call.path.endsWith('/jev-inbox/move/apply'))).toBe(false);
  });

  it('shows inbox errors and retries without hiding the main analysis action', async () => {
    let attempts = 0;
    vi.mocked(fetch).mockImplementation(async input => {
      if (String(input).endsWith('/jev-inbox')) {
        attempts++;
        return attempts === 1 ? Response.json({ error: 'Unavailable' }, { status: 503 }) : Response.json(emptyInbox);
      }
      return Response.json(report);
    });
    render(<InsightsPanel {...props()}/>);
    expect((await screen.findByRole('alert')).textContent).toContain('Inbox unavailable: Unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('No new findings. Analyze the canvas for more ideas.');
    expect(screen.getByRole('button', { name: 'Analyze canvas' })).toBeTruthy();
  });

  it('previews canvas changes before applying selected actions and offers undo', async () => {
    const calls = server(call => {
      if (call.path.endsWith('/automations')) return Response.json(call.body?.dryRun === false ? { ...preview, dryRun: false, applied: call.body?.actionIds, skipped: [] } : preview);
      if (call.path.endsWith('/undo')) return Response.json({ runId: preview.runId, reverted: ['link'], skipped: [] });
      return Response.json(report);
    });
    const viewProps = props({ onChanged: vi.fn() });
    render(<InsightsPanel {...viewProps}/>);
    fireEvent.click(screen.getByRole('tab', { name: 'Connections' }));
    fireEvent.click(screen.getByRole('button', { name: 'Preview connections' }));
    const region = await screen.findByLabelText('Canvas change preview');
    expect(within(region).getByText(/2 selected of 3 proposed changes/)).toBeTruthy();
    expect(viewProps.onChanged).not.toHaveBeenCalled();
    expect(within(region).getByRole('checkbox', { name: 'Select Merge plan into guide' })).toHaveProperty('disabled', true);
    fireEvent.click(within(region).getByRole('checkbox', { name: 'Select Update plan: purpose' }));
    fireEvent.click(within(region).getByRole('button', { name: 'Apply selected (1)' }));
    await screen.findByText('Applied 1 change.');
    expect(calls.find(call => call.body?.dryRun === false)?.body).toEqual({ kind: 'connection', dryRun: false, runId: 'canvas-run-1', actionIds: ['link'] });
    expect(viewProps.onChanged).toHaveBeenCalledOnce();
    fireEvent.click(within(region).getByRole('button', { name: 'Undo this run' }));
    await screen.findByText('Reverted 1 change.');
    expect(within(region).getByText(/This run was reverted/)).toBeTruthy();
    expect(calls.some(call => call.path === '/api/jev-runs/canvas-run-1/undo')).toBe(true);
    expect(viewProps.onChanged).toHaveBeenCalledTimes(2);
  });

  it('shows a partial Apply receipt with applied and skipped actions and their reasons', async () => {
    server(call => call.path.endsWith('/automations') ? Response.json(call.body?.dryRun === false
      ? { ...preview, dryRun: false, applied: ['link'], skipped: [{ id: 'label', reason: 'Document changed since preview' }] }
      : preview) : Response.json(report));
    render(<InsightsPanel {...props()}/>);
    fireEvent.click(screen.getByRole('tab', { name: 'Connections' }));
    fireEvent.click(screen.getByRole('button', { name: 'Preview connections' }));
    const region = await screen.findByLabelText('Canvas change preview');
    expect(within(region).getByText(/Ready for review/)).toBeTruthy();
    fireEvent.click(within(region).getByRole('button', { name: 'Apply selected (2)' }));
    expect(await screen.findByText('Applied 1 change; skipped 1.')).toBeTruthy();
    expect(within(region).getByText('Partially applied')).toBeTruthy();
    const receipt = within(region).getByRole('region', { name: 'Canvas run receipt' });
    expect(within(receipt).getByText(/Applied: Link guide → plan/)).toBeTruthy();
    expect(within(receipt).getByText(/Skipped: Update plan: purpose/)).toHaveProperty('textContent', expect.stringContaining('Document changed since preview'));
    expect(within(region).getByRole('button', { name: 'Undo this run' })).toBeTruthy();
  });

  it('blocks retry of an uncertain Apply until a fresh preview is prepared', async () => {
    const calls = server(call => call.path.endsWith('/automations') && call.body?.dryRun === false
      ? Response.json({ error: 'Connection dropped after save' }, { status: 503 })
      : Response.json(call.path.endsWith('/automations') ? preview : report));
    render(<InsightsPanel {...props()}/>);
    fireEvent.click(screen.getByRole('tab', { name: 'Connections' }));
    fireEvent.click(screen.getByRole('button', { name: 'Preview connections' }));
    const region = await screen.findByLabelText('Canvas change preview');
    fireEvent.click(within(region).getByRole('button', { name: 'Apply selected (2)' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Saved state may have changed. Refresh and review the affected documents before retrying.');
    expect(within(region).getByRole('button', { name: 'Apply selected (2)' })).toHaveProperty('disabled', true);
    expect(calls.filter(call => call.body?.dryRun === false)).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Preview connections' }));
    const freshRegion = await screen.findByLabelText('Canvas change preview');
    await waitFor(() => expect(within(freshRegion).getByRole('button', { name: 'Apply selected (2)' })).toHaveProperty('disabled', false));
  });

  it('shows a partial Undo receipt and identifies changes that remain saved', async () => {
    server(call => {
      if (call.path.endsWith('/automations')) return Response.json(call.body?.dryRun === false
        ? { ...preview, dryRun: false, applied: ['link', 'label'], skipped: [] } : preview);
      if (call.path.endsWith('/undo')) return Response.json({ reverted: ['link'],
        skipped: [{ id: 'label', reason: 'Current state differs from the applied change' }] });
      return Response.json(report);
    });
    render(<InsightsPanel {...props()}/>);
    fireEvent.click(screen.getByRole('tab', { name: 'Connections' }));
    fireEvent.click(screen.getByRole('button', { name: 'Preview connections' }));
    const region = await screen.findByLabelText('Canvas change preview');
    fireEvent.click(within(region).getByRole('button', { name: 'Apply selected (2)' }));
    await screen.findByText('Applied 2 changes.');
    fireEvent.click(within(region).getByRole('button', { name: 'Undo this run' }));
    expect(await screen.findByText('Reverted 1 change; skipped 1.')).toBeTruthy();
    expect(within(region).getByText('Partially reverted')).toBeTruthy();
    const receipt = within(region).getByRole('region', { name: 'Canvas run receipt' });
    expect(within(receipt).getByText(/Skipped: Update plan: purpose/)).toHaveProperty('textContent', expect.stringContaining('Current state differs'));
    expect(within(receipt).getByText(/Skipped changes remain saved/)).toBeTruthy();
    expect(within(region).queryByRole('button', { name: 'Undo this run' })).toBeNull();
  });

  it('explains an empty connection run without an apply action', async () => {
    server(call => call.path.endsWith('/automations') ? Response.json({ ...preview, changes: [], groups: [] }) : Response.json(report));
    render(<InsightsPanel {...props()}/>);
    fireEvent.click(screen.getByRole('tab', { name: 'Connections' }));
    expect(screen.getByText(/saved outgoing links/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Preview connections' }));
    const region = await screen.findByLabelText('Canvas change preview');
    expect(within(region).getByText(/found no proposed changes/)).toBeTruthy();
    expect(within(region).queryByRole('button', { name: /Apply selected/ })).toBeNull();
  });

  it('recovers from a failed preview without claiming changes were saved', async () => {
    server(call => call.path.endsWith('/automations') ? Response.json({ error: 'Jev unavailable' }, { status: 503 }) : Response.json(report));
    render(<InsightsPanel {...props()}/>);
    fireEvent.click(screen.getByRole('tab', { name: 'Groups' }));
    fireEvent.click(screen.getByRole('button', { name: 'Place these groups on the canvas' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Preview failed. Nothing was saved. Safe to retry. Jev unavailable');
    expect(screen.queryByLabelText('Canvas change preview')).toBeNull();
    expect(screen.getByRole('button', { name: 'Place these groups on the canvas' })).toHaveProperty('disabled', false);
  });

  it('keeps workspace preview available among advanced actions', async () => {
    const workspacePreview = { ...preview, runId: 'workspace-run', kind: 'tidy', changes: [preview.changes[0]], groups: [{ canvasId: canvas.id, canvasName: 'Team', count: 1 }] };
    const calls = server(call => call.path.includes('/workspaces/') ? Response.json(workspacePreview) : Response.json(report));
    render(<InsightsPanel {...props()}/>);
    openAdvanced();
    fireEvent.click(screen.getByRole('button', { name: 'Preview workspace changes' }));
    await screen.findByLabelText('Workspace change preview');
    expect(calls.some(call => call.path === '/api/workspaces/team/automations' && call.body?.dryRun === true)).toBe(true);
  });

  it('shows workspace partial Apply and Undo receipts with named skipped changes', async () => {
    const workspacePreview = { ...preview, runId: 'workspace-run', kind: 'tidy', changes: preview.changes.slice(0, 2),
      groups: [{ canvasId: canvas.id, canvasName: 'Team', count: 2 }] };
    server(call => {
      if (call.path.includes('/workspaces/') && call.path.endsWith('/automations')) return Response.json(call.body?.dryRun === false
        ? { ...workspacePreview, dryRun: false, applied: ['link'], skipped: [{ id: 'label', reason: 'Document changed since preview' }] }
        : workspacePreview);
      if (call.path.endsWith('/undo')) return Response.json({ reverted: [], skipped: [{ id: 'link', reason: 'Current state differs from the applied change' }] });
      return Response.json(report);
    });
    render(<InsightsPanel {...props()}/>);
    openAdvanced();
    fireEvent.click(screen.getByRole('button', { name: 'Preview workspace changes' }));
    const region = await screen.findByLabelText('Workspace change preview');
    expect(screen.getByText(/Ready for review: 2 changes across 1 canvas. Nothing saved yet/)).toBeTruthy();
    fireEvent.click(within(region).getByRole('button', { name: 'Apply selected (2)' }));
    expect(await screen.findByText('Applied 1 change; skipped 1.')).toBeTruthy();
    const appliedReceipt = within(region).getByRole('region', { name: 'Workspace run receipt' });
    expect(within(appliedReceipt).getByText(/Skipped: Update plan: purpose/)).toHaveProperty('textContent', expect.stringContaining('Document changed'));
    fireEvent.click(within(region).getByRole('button', { name: 'Undo this run' }));
    expect(await screen.findByText('Reverted 0 changes; skipped 1.')).toBeTruthy();
    const undoneReceipt = within(region).getByRole('region', { name: 'Workspace run receipt' });
    expect(within(undoneReceipt).getByText(/Skipped: Link guide → plan/)).toHaveProperty('textContent', expect.stringContaining('Current state differs'));
    expect(within(undoneReceipt).getByText(/Skipped changes remain saved/)).toBeTruthy();
  });

  it('keeps the applied receipt when the canvas refresh fails after save', async () => {
    server(call => call.path.endsWith('/automations') ? Response.json(call.body?.dryRun === false
      ? { ...preview, dryRun: false, applied: ['link', 'label'], skipped: [] } : preview) : Response.json(report));
    render(<InsightsPanel {...props({ onChanged: vi.fn(async () => { throw new Error('Refresh unavailable'); }) })}/>);
    fireEvent.click(screen.getByRole('tab', { name: 'Connections' }));
    fireEvent.click(screen.getByRole('button', { name: 'Preview connections' }));
    const region = await screen.findByLabelText('Canvas change preview');
    fireEvent.click(within(region).getByRole('button', { name: 'Apply selected (2)' }));
    expect(await screen.findByText('Applied 2 changes.')).toBeTruthy();
    expect((await screen.findByRole('alert')).textContent).toContain('Changes were saved, but the canvas did not refresh.');
    expect(within(region).getByRole('region', { name: 'Canvas run receipt' })).toBeTruthy();
    expect(within(region).getByRole('button', { name: 'Undo this run' })).toHaveProperty('disabled', false);
  });

  it('opens grouping only on request and keeps the selected document reachable', () => {
    server();
    const viewProps = props();
    render(<InsightsPanel {...viewProps}/>);
    fireEvent.click(screen.getByRole('tab', { name: 'Groups' }));
    const groups = screen.getByRole('region', { name: 'Document groups' });
    fireEvent.click(within(groups).getByRole('button', { name: 'Plan' }));
    expect(viewProps.onOpenBlock).toHaveBeenCalledWith('plan');
    fireEvent.click(within(groups).getByRole('tab', { name: 'Purpose' }));
    expect(within(groups).getByText('Other')).toBeTruthy();
  });

  it('explains setup when no canvas or Jev key is available', () => {
    server();
    const viewProps = props({ canvas: null, hasApiKey: false });
    render(<InsightsPanel {...viewProps}/>);
    expect(screen.getByText('Open a canvas to see its insights.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Analyze canvas' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'Open Settings' }));
    expect(viewProps.onOpenSettings).toHaveBeenCalledOnce();
  });
});
