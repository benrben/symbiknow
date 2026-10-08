import { useEffect, useRef, useState } from 'react';
import type { CanvasBlock } from '../shared/types';

/** A new server-owned mutation stamp signals an applied Jev change, never a manual edit. */
function useJevChange(mutationId: string | undefined) {
  const previous = useRef(mutationId);
  const [changed, setChanged] = useState(false);
  useEffect(() => {
    const before = previous.current;
    previous.current = mutationId;
    setChanged(false);
    if (!mutationId || mutationId === before) return;
    setChanged(true);
    const timer = window.setTimeout(() => setChanged(false), 1600);
    return () => window.clearTimeout(timer);
  }, [mutationId]);
  return changed;
}

export function JevCardStatus({ block, onOpenRelated }: { block: CanvasBlock; onOpenRelated: (blockId: string) => void }) {
  const changed = useJevChange(block.jevMutationId);
  const duplicates = block.jevDuplicates ?? [];
  if (!block.jevMutationId && duplicates.length === 0) return null;
  return <span className="canvas-card__jev-status">
    {block.jevMutationId && <em className="canvas-card__jev-marker" title="Organized by Reflex" aria-label="Organized by Reflex">Reflex did it</em>}
    {changed && <em className="canvas-card__jev-change" role="status">Updated by Reflex</em>}
    {duplicates.map(related => <button type="button" className="canvas-card__duplicate nodrag" key={`${related.findingId}:${related.blockId}`}
      title={`Compare with ${related.title}`} aria-label={`Possible duplicate: ${related.title}`}
      onClick={event => { event.stopPropagation(); onOpenRelated(related.blockId); }}>Possible duplicate <span dir="auto">· {related.title}</span></button>)}
  </span>;
}
