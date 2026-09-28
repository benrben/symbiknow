import type { KeyboardEvent } from 'react';
import { groupLabel, groupPath, normalizedGroup } from '../shared/groups';
import type { CanvasBlock, CanvasDocument } from '../shared/types';
import './browse-groups.css';

export type BrowseGroupsProps = {
  canvas: CanvasDocument | null;
  onOpenBlock: (blockId: string) => void;
  onOrganize: () => void;
  onClose: () => void;
};

type SavedGroup = { key: string; label: string; blocks: CanvasBlock[] };

function savedGroups(blocks: CanvasBlock[]): SavedGroup[] {
  const byGroup = new Map<string, CanvasBlock[]>();
  for (const block of blocks) {
    const key = normalizedGroup(block.group) ?? '';
    const members = byGroup.get(key) ?? [];
    members.push(block);
    byGroup.set(key, members);
  }
  return [...byGroup].map(([key, members]) => ({
    key, label: key ? groupPath(key).map(groupLabel).join(' / ') : 'Ungrouped',
    blocks: [...members].sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id)),
  })).sort((a, b) => (a.key === '' ? 1 : b.key === '' ? -1 : a.label.localeCompare(b.label)));
}

export function BrowseGroups({ canvas, onOpenBlock, onOrganize, onClose }: BrowseGroupsProps) {
  const groups = savedGroups(canvas?.blocks ?? []);
  const count = canvas?.blocks.length ?? 0;
  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
  }

  return <aside className="browse-groups" aria-label="Browse groups" onKeyDown={onKeyDown}>
    <header className="browse-groups__header">
      <div><p>Canvas library</p><h2>Browse groups</h2><span>{canvas?.name ?? 'No canvas selected'} · {count} {count === 1 ? 'document' : 'documents'}</span></div>
      <button type="button" className="browse-groups__close" onClick={onClose} aria-label="Close browse groups">×</button>
    </header>
    <div className="browse-groups__body">
      {groups.length === 0 ? <p className="browse-groups__empty">No documents in this canvas yet.</p>
        : groups.map(group => <section className="browse-groups__group" key={group.key || '__ungrouped'} aria-label={group.label}>
          <h3>{group.label} <span>{group.blocks.length}</span></h3>
          <ul>{group.blocks.map(block => <li key={block.id}><button type="button" aria-label={`Open ${block.title}`} onClick={() => onOpenBlock(block.id)}>
            <span>{block.title}</span><small aria-hidden="true">{block.kind}</small>
          </button></li>)}</ul>
        </section>)}
    </div>
    <footer><button type="button" onClick={onOrganize}>Organize with Jev <span aria-hidden="true">↗</span></button></footer>
  </aside>;
}
