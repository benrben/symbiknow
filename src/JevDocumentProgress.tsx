import type { SymbiDocumentProgress } from '../shared/symbi-contract';
import { jevActionLabels } from '../shared/jev-action-labels';
import type { CanvasDocument } from '../shared/types';

const stateLabels = { waiting: 'Waiting', changed: 'Changed', no_change: 'No change', failed: 'Failed' } as const;

export function JevDocumentProgress({ canvas, documents, error }: {
  canvas: CanvasDocument; documents: SymbiDocumentProgress[]; error?: string;
}) {
  const current = new Map(canvas.blocks.map(block => [block.id, block]));
  const visible = documents.filter(document => document.canvasId === canvas.id && current.has(document.blockId))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  if (!visible.length && !error) return null;
  return <section className="jev-card jev-document-progress" aria-label="Document progress">
    <h2>Document progress</h2>
    {error && <p role="alert">{error}</p>}
    {visible.map(document => {
      const block = current.get(document.blockId)!;
      const completed = document.actions.filter(action => action.state !== 'waiting').length;
      return <details key={`${document.blockId}:${document.contentHash}`}>
        <summary><strong>{block.title}</strong><span>{document.durable ? 'Complete and saved' : `${completed} of ${document.actions.length} checks finished`}</span></summary>
        <ol>{document.actions.map(action => <li key={action.action}>
          <span>{jevActionLabels[action.action]}</span>
          <span>{stateLabels[action.state]}{action.reason ? `: ${action.reason}` : ''}</span>
        </li>)}</ol>
      </details>;
    })}
  </section>;
}
