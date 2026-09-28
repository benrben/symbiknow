import { useMemo, useState } from 'react';
import type { CanvasBlock, CanvasDocument } from '../shared/types';
import type { InsightReport } from '../shared/insights';
import { groupKey, groupLabel } from '../shared/groups';
import { api } from './api';
import type { BlockPosition } from './Canvas';
import './group-suggestions.css';

type GroupMode = 'topic' | 'tags' | 'repo';
type Assignment = { blockId: string; group: string | null };

function slug(value: string): string {
  return value.toLocaleLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64) || 'other';
}

function sourceRepo(block: CanvasBlock): string | undefined {
  const tagged = block.tags?.find(tag => tag.startsWith('repo:'))?.slice(5);
  if (tagged) return tagged;
  return /^(?:repository|repo|sourceRepo):\s*["']?([^\n"']+)/im.exec(block.content)?.[1]?.trim();
}

function assignments(canvas: CanvasDocument, mode: GroupMode, report?: InsightReport): Assignment[] {
  const classes = new Map(report?.classification?.map(entry => [entry.blockId, entry]) ?? []);
  return canvas.blocks.map(block => {
    if (mode === 'topic') {
      const entry = classes.get(block.id);
      const value = entry?.workArea && (entry.workAreaConfidence ?? 0) >= .5 ? entry.workArea : block.workArea;
      return { blockId: block.id, group: value ? groupKey('work_area', value) : null };
    }
    if (mode === 'tags') return { blockId: block.id, group: block.tags?.[0] ? `custom:tags/${slug(block.tags[0])}` : null };
    const repo = sourceRepo(block);
    return { blockId: block.id, group: repo ? `custom:repo/${slug(repo)}` : null };
  });
}

function proposedLayout(canvas: CanvasDocument, assigned: Assignment[]): BlockPosition[] {
  const byId = new Map(canvas.blocks.map(block => [block.id, block]));
  const groups = new Map<string, CanvasBlock[]>();
  for (const item of assigned) {
    const block = byId.get(item.blockId);
    if (!block || !item.group) continue;
    groups.set(item.group, [...(groups.get(item.group) ?? []), block]);
  }
  const result: BlockPosition[] = [];
  let cursorX = 80;
  let cursorY = 80;
  let rowHeight = 0;
  let column = 0;
  for (const [group, blocks] of groups) {
    const cardWidth = Math.max(...blocks.map(block => block.width));
    const cardHeight = Math.max(...blocks.map(block => block.height));
    const width = Math.min(3, blocks.length) * (cardWidth + 44) + 40;
    const rows = Math.ceil(blocks.length / Math.min(3, blocks.length));
    const height = rows * (cardHeight + 44) + 80;
    if (column === 2) { cursorX = 80; cursorY += rowHeight + 120; rowHeight = 0; column = 0; }
    blocks.forEach((block, index) => result.push({ blockId: block.id,
      x: cursorX + 30 + (index % 3) * (cardWidth + 44),
      y: cursorY + 70 + Math.floor(index / 3) * (cardHeight + 44), group }));
    cursorX += width + 100;
    rowHeight = Math.max(rowHeight, height);
    column += 1;
  }
  return result;
}

type Props = {
  canvas: CanvasDocument;
  hasApiKey: boolean;
  onOpenSettings: () => void;
  onApply: (positions: BlockPosition[]) => Promise<void>;
  onClose: () => void;
  onPreview: (groups: Record<string, string> | null) => void;
};

export function GroupSuggestions({ canvas, hasApiKey, onOpenSettings, onApply, onClose, onPreview }: Props) {
  const [mode, setMode] = useState<GroupMode>('topic');
  const [report, setReport] = useState<InsightReport>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [undo, setUndo] = useState<{ before: BlockPosition[]; after: BlockPosition[] }>();
  const [previewing, setPreviewing] = useState(false);
  const [receipt, setReceipt] = useState('');
  const draft = useMemo(() => assignments(canvas, mode, report).map(item => ({ ...item, group: overrides[item.blockId] ?? item.group })), [canvas, mode, report, overrides]);
  const grouped = useMemo(() => {
    const map = new Map<string, CanvasBlock[]>();
    for (const item of draft) {
      if (!item.group) continue;
      const block = canvas.blocks.find(block => block.id === item.blockId);
      if (block) map.set(item.group, [...(map.get(item.group) ?? []), block]);
    }
    return map;
  }, [draft, canvas.blocks]);
  const ungrouped = canvas.blocks.filter(block => !draft.find(item => item.blockId === block.id)?.group);
  const preview = proposedLayout(canvas, draft);

  async function generate() {
    setError('');
    if (mode !== 'topic') {
      if (!grouped.size) setError(mode === 'tags' ? 'Add tags to documents before grouping by tag.' : 'Add a repo: tag or repository frontmatter before grouping by source repo.');
      return;
    }
    if (!hasApiKey) { setError('Connect TypeSafe Jev in Settings to suggest topic groups.'); onOpenSettings(); return; }
    setLoading(true);
    try {
      setReport(await api<InsightReport>(`/canvases/${encodeURIComponent(canvas.id)}/insights`, { method: 'POST', body: JSON.stringify({ query: '' }) }));
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not suggest groups.'); }
    finally { setLoading(false); }
  }

  async function apply() {
    if (!preview.length) return;
    setLoading(true);
    setError('');
    const before = canvas.blocks.map(block => ({ blockId: block.id, x: block.x, y: block.y, group: block.group ?? null }));
    try { await onApply(preview); setUndo({ before, after: preview }); setPreviewing(false); onPreview(null); setReceipt(`Saved grouping for ${preview.length} documents. You can undo this placement.`); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not place groups.'); }
    finally { setLoading(false); }
  }

  async function undoLast() {
    if (!undo) return;
    const current = new Map(canvas.blocks.map(block => [block.id, block]));
    const changed = undo.after.some(position => {
      const block = current.get(position.blockId);
      return !block || block.x !== position.x || block.y !== position.y || block.group !== position.group;
    });
    if (changed) { setError('The canvas changed since grouping. Review the current positions before undoing.'); return; }
    setLoading(true);
    try { await onApply(undo.before); setUndo(undefined); setReceipt(`Reverted grouping for ${undo.after.length} documents. Their previous positions and saved groups were restored.`); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not undo grouping.'); }
    finally { setLoading(false); }
  }

  return <aside className="group-suggestions" aria-label="Suggested groups">
    <header><div><strong>Suggested groups</strong><small>Inferred placement · {new Set(canvas.blocks.map(block => block.group).filter(Boolean)).size} saved canvas groups</small></div><button type="button" onClick={() => { onPreview(null); onClose(); }} aria-label="Close suggested groups">×</button></header>
    <div className="group-suggestions__modes" role="tablist" aria-label="Grouping basis">
      {([['topic', 'By topic · AI'], ['tags', 'By tags'], ['repo', 'By source repo']] as const).map(([value, label]) => <button key={value} type="button" role="tab" aria-selected={mode === value} onClick={() => { setMode(value); setOverrides({}); setReport(undefined); setPreviewing(false); setReceipt(''); onPreview(null); }}>{label}</button>)}
    </div>
    <button type="button" className="group-suggestions__generate" onClick={() => { void generate(); }} disabled={loading}>{loading ? 'Working…' : mode === 'topic' ? 'Ask Jev for groups' : 'Preview groups'}</button>
    <p className="group-suggestions__explanation">Proposed groups are separate from saved canvas groups. Review each document before accepting the placement.</p>
    <div className="group-suggestions__list">
      {[...grouped].map(([group, blocks]) => <section key={group}><h3>{groupLabel(group)} <span>{blocks.length}</span></h3><p>{blocks.slice(0, 3).map(block => block.title).join(' · ')}{blocks.length > 3 ? ` · +${blocks.length - 3} more` : ''}</p></section>)}
      {ungrouped.length > 0 && <section><h3>Needs a group <span>{ungrouped.length}</span></h3><p>Where should these documents go?</p>{ungrouped.map(block => <label key={block.id}>{block.title}<select aria-label={`Group for ${block.title}`} value={overrides[block.id] ?? ''} onChange={event => { setOverrides(value => ({ ...value, [block.id]: event.target.value })); setPreviewing(false); onPreview(null); }}><option value="">Leave ungrouped</option>{[...grouped.keys()].map(group => <option key={group} value={group}>{groupLabel(group)}</option>)}</select></label>)}</section>}
    </div>
    {error && <p className="group-suggestions__error" role="alert">{error}</p>}
    {previewing && <p className="group-suggestions__receipt" role="status">Canvas preview shows the proposed group frames. {preview.length} documents would be placed. Nothing has been saved.</p>}
    {receipt && <p className="group-suggestions__receipt" role="status">{receipt}</p>}
    <footer><button type="button" onClick={() => { onPreview(Object.fromEntries(draft.filter(item => item.group).map(item => [item.blockId, item.group!]))); setPreviewing(true); setReceipt(''); }} disabled={!preview.length}>Show preview on canvas</button><button type="button" onClick={() => { void apply(); }} disabled={!preview.length || loading}>Accept grouping</button>{undo && <button type="button" onClick={() => { void undoLast(); }} disabled={loading}>Undo grouping</button>}</footer>
  </aside>;
}
