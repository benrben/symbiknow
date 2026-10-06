import type { AnswerCanvasModel } from './useAnswerCanvas';
import { Canvas } from './Canvas';

export function AnswerCanvasWorkspace({ model }: { model: AnswerCanvasModel }) {
  const {
    canvas, theme, fitRequest, sourceLabels, updateBlock, deleteBlock, moveBlocks, editBlock, setReaderId,
    setHistoryOpen, openSourceLink, setDuplicateId, onAskSelection, focusRequest, viewportRequest, search, matches,
    selectionChanged, viewChanged,
  } = model;
  return <>
    <div className="answer-canvas__workspace"><Canvas canvas={canvas} theme={theme} focusZoom={1} focusSelect={false} fitRequest={fitRequest} crossLinkLabels={sourceLabels}
      onUpdateBlock={updateBlock} onDeleteBlock={deleteBlock} onMoveBlocks={moveBlocks} onSelectBlock={editBlock}
      onReadBlock={block => setReaderId(block.id)} onHistoryBlock={() => setHistoryOpen(true)}
      onOpenCrossLink={openSourceLink} onFindSimilar={setDuplicateId} onSummarizeSelection={onAskSelection}
      focusRequest={focusRequest} viewportRequest={viewportRequest} searchQuery={search} searchMatchIds={matches.map(block => block.id)}
      onSelectionChange={selectionChanged} onViewportChange={viewChanged} /></div>

  </>;
}
