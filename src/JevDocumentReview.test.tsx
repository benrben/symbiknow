// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { JevDocumentReview } from './JevDocumentReview';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function review(status: 'pending' | 'applied' = 'pending') {
  return { canvasId: 'canvas', blockId: 'doc', contentHash: 'current-hash', currentGroup: status === 'applied' ? 'custom:release' : undefined,
    durable: true, actions: [
      { action: 'profile', state: 'changed', role: 'instructions', scores: [{ name: 'role', value: .92 }] },
      { action: 'file', state: status === 'applied' ? 'changed' : 'no_change', reason: 'Group review requested',
        scores: [{ name: 'group fit', value: .87 }] },
    ], grouping: { groupKey: 'custom:release', proposalId: 'proposal-1', status, canApprove: status === 'pending',
      confidence: .87, scores: [.94, .87], evidence: [{ quote: 'Release readiness checklist.' }] } };
}

it('shows recorded Jev scores and approves only the current pending group proposal', async () => {
  let status: 'pending' | 'applied' = 'pending';
  const requests: Array<{ url: string; method: string; body?: unknown }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    requests.push({ url: String(input), method, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (method === 'POST') { status = 'applied'; return Response.json({ ok: true }); }
    return Response.json(review(status));
  }));
  const changed = vi.fn(async () => {});
  render(<JevDocumentReview workspaceId="workspace" canvasId="canvas" blockId="doc" contentHash="current-hash"
    groupLabels={{ 'custom:release': 'Release' }} onGroupChanged={changed}/>);
  expect(await screen.findByText(/role 92%/)).toBeTruthy();
  expect(screen.getByText(/group fit 87%/)).toBeTruthy();
  expect(screen.getByText('Release readiness checklist.')).toBeTruthy();
  expect(requests.every(request => request.method === 'GET')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Approve grouping' }));
  await waitFor(() => expect(changed).toHaveBeenCalledOnce());
  expect(requests.find(request => request.method === 'POST')).toMatchObject({
    url: '/api/workspaces/workspace/jev/documents/doc/approve-group',
    body: { canvasId: 'canvas', contentHash: 'current-hash', proposalId: 'proposal-1' },
  });
  expect(await screen.findByText('Grouping saved')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Approve grouping' })).toBeNull();
});

it('requires an explicit click to rerun this document and blocks stale source hashes', async () => {
  const requests: Array<{ method: string; url: string }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    requests.push({ method: init.method ?? 'GET', url: String(input) });
    return Response.json(init.method === 'POST' ? { jobId: 'recheck-job' } : review('applied'));
  }));
  const view = render(<JevDocumentReview workspaceId="workspace" canvasId="canvas" blockId="doc" contentHash="old-hash"
    onGroupChanged={async () => {}}/>);
  const button = await screen.findByRole('button', { name: 'Run Jev again for this document' }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  expect(requests.every(request => request.method === 'GET')).toBe(true);
  view.rerender(<JevDocumentReview workspaceId="workspace" canvasId="canvas" blockId="doc" contentHash="current-hash"
    onGroupChanged={async () => {}}/>);
  await waitFor(() => expect((screen.getByRole('button', { name: 'Run Jev again for this document' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Run Jev again for this document' }));
  await waitFor(() => expect(requests.some(request => request.method === 'POST'
    && request.url.endsWith('/recheck'))).toBe(true));
  expect(await screen.findByText('Jev is checking this document again.')).toBeTruthy();
});

it('shows a paused-processing failure in the document and keeps its saved decisions readable', async () => {
  const posts: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    if (init.method === 'POST') {
      posts.push(String(input));
      return Response.json({ error: 'Jev checks are paused for this app session; saved decisions remain available' }, { status: 503 });
    }
    return Response.json(review('pending'));
  }));
  render(<JevDocumentReview workspaceId="workspace" canvasId="canvas" blockId="doc" contentHash="current-hash"
    onGroupChanged={async () => {}}/>);
  expect(await screen.findByText(/role 92%/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Run Jev again for this document' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent',
    'Jev checks are paused for this app session; saved decisions remain available Retry');
  expect(screen.getByText(/group fit 87%/)).toBeTruthy();
  expect(posts).toEqual(['/api/workspaces/workspace/jev/documents/doc/recheck']);
});

it('rejects a mismatched review response and recovers with an explicit retry', async () => {
  let wrongScope = true;
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(wrongScope ? { ...review(), blockId: 'another-doc' } : review())));
  render(<JevDocumentReview workspaceId="workspace" canvasId="canvas" blockId="doc" contentHash="current-hash"
    onGroupChanged={async () => {}}/>);
  expect(await screen.findByText(/Jev document decisions are unavailable/)).toBeTruthy();
  wrongScope = false;
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText(/role 92%/)).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});

it('reports a failed explicit retry and can recover on the next retry', async () => {
  let reads = 0;
  vi.stubGlobal('fetch', vi.fn(async () => {
    reads += 1;
    if (reads === 1) return Response.json({ ...review(), blockId: 'another-doc' });
    if (reads === 2) return Response.json({ error: 'Review temporarily unavailable' }, { status: 503 });
    return Response.json(review());
  }));
  render(<JevDocumentReview workspaceId="workspace" canvasId="canvas" blockId="doc" contentHash="current-hash"
    onGroupChanged={async () => {}}/>);
  expect(await screen.findByRole('alert')).toHaveProperty('textContent',
    'Jev document decisions are unavailable for this source. Retry');
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Review temporarily unavailable'));
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText(/role 92%/)).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});

it.each([
  ['held', 'Needs a human review', false],
  ['held', 'Review the current evidence before grouping.', false],
  ['dismissed', 'This suggestion is no longer current.', false],
  ['suppressed', 'This suggestion is no longer current.', false],
  ['stale', 'This suggestion is no longer current.', false],
  ['pending', 'Approval requires workspace review permission.', false],
] as const)('keeps a %s grouping outcome readable in the document', async (status, expected, canApprove) => {
  const saved = review();
  Object.assign(saved.grouping, { status, canApprove });
  if (status === 'held' && expected === 'Needs a human review')
    Object.assign(saved.grouping, { reason: expected });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(saved)));
  render(<JevDocumentReview workspaceId="workspace" canvasId="canvas" blockId="doc" contentHash="current-hash"
    onGroupChanged={async () => {}}/>);
  expect(await screen.findByText(expected)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Approve grouping' })).toBeNull();
});

it('shows waiting checks and an ungrouped document without inventing scores or a proposal', async () => {
  const saved = { ...review(), durable: false, actions: [
    { action: 'profile', state: 'waiting' }, { action: 'file', state: 'waiting' },
  ], grouping: undefined, currentGroup: undefined };
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(saved)));
  render(<JevDocumentReview workspaceId="workspace" canvasId="canvas" blockId="doc" contentHash="current-hash"
    onGroupChanged={async () => {}}/>);
  expect(await screen.findByText('No checks recorded yet')).toBeTruthy();
  expect(screen.getByText('Ungrouped').parentElement?.textContent).toBe('Current group: Ungrouped');
  expect(screen.queryByText(/Jev scores:/)).toBeNull();
  expect(screen.queryByRole('button', { name: 'Approve grouping' })).toBeNull();
});

it('keeps group scores and actions compact while revealing the full breakdown on demand', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(review())));
  render(<JevDocumentReview workspaceId="workspace" canvasId="canvas" blockId="doc" contentHash="current-hash"
    groupLabels={{ 'custom:release': 'Release' }} onGroupChanged={async () => {}}/>);
  expect(await screen.findByText('Group checks: 94%, 87%')).toBeTruthy();
  expect(screen.getByText('Release').parentElement?.textContent).toBe('Suggested group: Release');
  expect(screen.getByRole('button', { name: 'Approve grouping' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Run Jev again for this document' }).textContent).toBe('Run again');
  const summary = screen.getByText('Scores and evidence');
  const details = summary.parentElement as HTMLDetailsElement;
  expect(details.open).toBe(false);
  expect(screen.getByText(/role 92%/).closest('details')).toBe(details);
  fireEvent.click(summary);
  expect(details.open).toBe(true);
  expect(screen.getByText('Release readiness checklist.').closest('details')).toBe(details);
});
