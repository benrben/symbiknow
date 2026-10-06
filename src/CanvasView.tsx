import { Background, Controls, MiniMap, ReactFlow, type Edge } from '@xyflow/react';
import { type CSSProperties } from 'react';
import { groupPath } from '../shared/groups';
import { groupDisplayLabel } from './canvas-group-labels';
import { groupPrefix } from './canvas-flow-helpers';
import { CanvasInspector } from './canvas-inspector';
import type { CanvasModel } from './canvas-model';
import type { CanvasNode, FlowNode, GroupNode, GroupNodeData } from './canvas-types';
import { nodeTypes } from './CanvasNodes';
import { CanvasDrillBoard, CanvasOverview } from './CanvasOverview';
import { FocusBlock, FocusFittedBlock, FocusPoint, OverviewRequest, ViewRequest } from './CanvasViewRequests';
import { canvasFitPadding } from './canvas-view-helpers';

const initialFitOptions = { padding: canvasFitPadding, maxZoom: 1 };

export function CanvasView({ model }: { model: CanvasModel }) {
  const { surface, zoomLevel, selectedIds, zoom, canvas } = model;
  return (
    <section ref={surface} className={`canvas-surface canvas-surface--${zoomLevel}${selectedIds.length ? ' canvas-surface--inspecting' : ''}`} style={{ '--canvas-label-scale': String(1 / Math.max(zoom, .28)), '--canvas-map-summary-opacity': String(Math.max(0, Math.min(1, (zoom - .1) / .12))) } as CSSProperties} aria-label={`${canvas.name} infinite canvas`}>
      <CanvasToolbar model={model}/>
      <CanvasFlowStage model={model}/>      <CanvasDetails model={model}/>      <CanvasStatus model={model}/>
    </section>
  );

}


function CanvasToolbar({ model }: { model: CanvasModel }) {
  const { drillGroup, zoomLevel, selectedIds, showDrillBoard, setShowDrillBoard } = model;
  return <>
      <div className="canvas-toolbar" aria-label="Canvas tools">
        <CanvasBreadcrumb model={model}/>
        <span className="canvas-zoom-label">{zoomLabel(model)} · {Math.round(model.zoom * 100)}%</span>
        {drillGroup && zoomLevel === 'full' && selectedIds.length === 0 && <button type="button" aria-pressed={showDrillBoard} onClick={() => setShowDrillBoard(value => !value)}>{showDrillBoard ? 'Show canvas' : 'Browse files'}</button>}
        <CanvasLayoutControls model={model}/>
      </div>
  </>;
}

function CanvasBreadcrumb({ model }: { model: CanvasModel }) {
  const { returnOverview, canvas, activeSuper, setMapParent, setDrillGroup, flowInstance, mapParent } = model;
  return <>
        <div className="canvas-breadcrumb"><button type="button" aria-label="Return to canvas group overview" onClick={returnOverview}>{canvas.name}</button>{activeSuper && <span>› <button type="button" onClick={() => { setMapParent(''); setDrillGroup(''); void flowInstance.current?.setViewport({ x: 24, y: 68, zoom: .28 }, { duration: 200 }); }}>Supergroup: {activeSuper.title}</button></span>}{mapParent && groupPath(mapParent).map(path => <span key={path}>› <button type="button" onClick={() => { setMapParent(path); setDrillGroup(''); void flowInstance.current?.setViewport({ x: 24, y: 68, zoom: .28 }, { duration: 200 }); }}>{groupDisplayLabel(path, model.canvas.groupLabels)}</button></span>)}<CanvasDrillBreadcrumb model={model}/></div>
  </>;
}

function CanvasLayoutControls({ model }: { model: CanvasModel }) {
  const { restoreLayout, pullActive } = model;
  return <>
        {pullActive && <button type="button" onClick={restoreLayout}>Restore positions</button>}
  </>;
}

function CanvasFlowStage({ model }: { model: CanvasModel }) {
  const {
    zoomIntent, zoomTarget, flowInstance, flowNodes, edges, changeNodes, saveGroupMove, dropBlock, selectBlock,
    selectNodes, openBlock, openHierarchyGroup, connect, deleteEdges, beforeDelete, mapPinned, theme, moved,
    moveEnded, searchIds,
  } = model;
  return <>
      <div className="canvas-flow-stage" onWheelCapture={event => {
        zoomIntent.current = event.deltaY < 0 ? 'in' : 'out';
        zoomTarget.current = event.target instanceof Element ? event.target.closest('[data-canvas-group]')?.getAttribute('data-canvas-group') ?? null : null;
      }} onClickCapture={event => {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest('.react-flow__controls-zoomin')) { zoomIntent.current = 'in'; zoomTarget.current = null; }
        if (target?.closest('.react-flow__controls-zoomout')) { zoomIntent.current = 'out'; zoomTarget.current = null; }
      }}><ReactFlow<FlowNode, Edge>
        onInit={instance => {
          flowInstance.current = instance;
          // Pin can run before measurements trigger the first camera movement.
          moved(null, instance.getViewport());
        }}
        nodes={flowNodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onlyRenderVisibleElements
        onNodesChange={changeNodes}
        onNodeDragStop={(_, node) => {
          if (node.id.startsWith(groupPrefix)) saveGroupMove(node.id);
          else dropBlock(node as CanvasNode);
        }}
        onNodeClick={(_, node) => { if (node.type === 'document') selectBlock(node.id); }}
        onSelectionChange={selectNodes}
        // The actual model producers emit concrete document or groupFrame types.
        onNodeDoubleClick={(_, node) => { if (node.type === 'document') openBlock((node as CanvasNode).data.block); else openHierarchyGroup((node as GroupNode).data.group); }}
        onConnect={connect}
        onEdgesDelete={deleteEdges}
        onBeforeDelete={beforeDelete}
        fitView
        fitViewOptions={initialFitOptions}
        minZoom={0.005}
        maxZoom={mapPinned ? .6 : 2.5}
        deleteKeyCode={['Backspace', 'Delete']}
        panOnDrag
        panOnScroll={false}
        zoomOnScroll
        colorMode={theme}
        onMove={moved}
        onMoveEnd={moveEnded}
        selectionKeyCode="Shift"
      >
        <CanvasFlowFocus model={model}/>
        <Background color={theme === 'dark' ? '#2D4649' : '#D6DEDC'} gap={22} size={1.1} />
        <Controls position="bottom-left" showInteractive={false} fitViewOptions={initialFitOptions} />
        <MiniMap position="bottom-right" nodeStrokeWidth={3} pannable zoomable nodeColor={node => node.type === 'groupFrame'
          ? ['#aebcf0', '#e9c48f', '#97d4cf', '#d1afe9', '#efb1c2', '#a9d7a8', '#9fc9ea', '#d8c49a'][Number((node.data as GroupNodeData).tone) || 0]
          : (searchIds.has(node.id) ? theme === 'dark' ? '#AFC0FF' : '#3858B8' : '#BCE7C9')} />
      </ReactFlow></div>
  </>;
}

function CanvasFlowFocus({ model }: { model: CanvasModel }) {
  const { focusSelect, focusRequest, blocks, focusZoom, pointRequest, viewportRequest, canvasId,
    mapParent, activeSuper, overviewSequence, mapPinned, surface } = model;
  return <>
    {focusSelect && focusRequest && <FocusBlock block={blocks.find(block => block.id === focusRequest.blockId)} sequence={focusRequest.sequence} minZoom={focusZoom}/>}
    {!focusSelect && focusRequest && <FocusFittedBlock block={blocks.find(block => block.id === focusRequest.blockId)} sequence={focusRequest.sequence} maxZoom={focusZoom} surface={surface}/>}
    <FocusPoint request={pointRequest}/><ViewRequest request={viewportRequest}/>
    <OverviewRequest active={mapPinned} canvasId={canvasId} parent={mapParent} supergroup={activeSuper} sequence={overviewSequence}
      viewportRequest={viewportRequest} pointRequest={pointRequest} focusRequest={focusRequest}/>
  </>;
}

function CanvasDetails({ model }: { model: CanvasModel }) {
  const {
    groupFrames, viewBlocks, searchIds, searchMatchIds, zoomLevel, drillGroup, selectedIds,
    openHierarchyGroup, blocks, selectedBlocks, canvasId, saveBlock, readBlock, selectBlock,
    onSummarizeSelection, reportError, lastSelection, setSelectedIds, selectionCallback, surface, changeNodes,
  } = model;
  return <>

      <CanvasOverview groups={groupFrames} blocks={viewBlocks} searchIds={searchIds} matchCount={searchMatchIds.length} overview={zoomLevel === 'overview'} drill={Boolean(drillGroup && !selectedIds.length)} onFocus={openHierarchyGroup}/>
      <CanvasFileBoard model={model}/>      <CanvasFocusTools model={model}/>
      <CanvasInspector key={selectedIds.join('|')} blocks={blocks} selected={selectedBlocks} canvasId={canvasId} onUpdateBlock={saveBlock} onReadBlock={readBlock} onFocusBlock={selectBlock} onSummarizeSelection={onSummarizeSelection} onError={reportError} onClose={() => { changeNodes(selectedIds.map(id => ({ type: 'select', id, selected: false }))); lastSelection.current = ''; setSelectedIds([]); selectionCallback.current?.([]); }} onResize={(axis, size) => surface.current?.style.setProperty(axis === 'width' ? '--canvas-inspector-width' : '--canvas-inspector-height', `${size}px`)}/>
  </>;
}

function CanvasStatus({ model }: { model: CanvasModel }) {
  const { zoomLevel, message, setMessage } = model;
  return <>

      <div className="canvas-hint">{zoomLevel === 'overview' ? 'Zoom in over a card to open it · zoom out to go up · drag to pan' : 'Scroll to zoom · drag to pan · Shift and drag to select'}</div>
      {message && <div className="canvas-error" role="alert">{message}<button onClick={() => setMessage('')} aria-label="Dismiss error">×</button></div>}
  </>;
}

function CanvasDrillBreadcrumb({ model }: { model: CanvasModel }) {
  const { drillGroup, mapParent, openHierarchyGroup } = model;
  return <>
{drillGroup === '__ungrouped' ? <span>› Ungrouped</span> : drillGroup && groupPath(drillGroup).filter(path => !mapParent || groupPath(path).length > groupPath(mapParent).length).map(path => <span key={path}>› <button type="button" onClick={() => openHierarchyGroup(path)}>{groupDisplayLabel(path, model.canvas.groupLabels)}</button></span>)}
  </>;
}

function CanvasFileBoard({ model }: { model: CanvasModel }) {
  const { showDrillBoard, drillGroup, zoomLevel, selectedIds, groupFrames, viewBlocks, focusGroup, selectBlock } = model;
  if (!showDrillBoard || !drillGroup || zoomLevel === 'overview' || selectedIds.length !== 0) return null;
  return <>
      <CanvasDrillBoard group={drillGroup} groups={groupFrames} blocks={viewBlocks} onFocus={focusGroup} onSelect={selectBlock}/>
  </>;
}

function CanvasFocusTools({ model }: { model: CanvasModel }) {
  const { selectedIds, selectedBlocks, focusHops, setFocusHops, pullRelated } = model;
  if (selectedIds.length !== 1) return null;
  return <>

      <div className="canvas-focus-tools" aria-label="Connection focus"><strong>Connections for {selectedBlocks[0]?.title}</strong><button type="button" aria-pressed={focusHops === 1} onClick={() => setFocusHops(1)}>+1 hop</button><button type="button" aria-pressed={focusHops === 2} onClick={() => setFocusHops(2)}>+2 hops</button><button type="button" onClick={pullRelated}>Pull neighbors close</button></div>
  </>;
}

function zoomLabel(model: CanvasModel) {
  if (model.zoomLevel === 'titles') return 'Titles';
  if (model.zoomLevel !== 'overview') return 'Files';
  if (model.mapParent) return 'Subgroups';
  if (model.activeSuper) return 'Groups';
  return model.supergroups.length ? 'Supergroups' : 'Groups';
}
