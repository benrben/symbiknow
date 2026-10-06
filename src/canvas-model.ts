import { type Connection, type Edge, type NodeChange, type Viewport } from '@xyflow/react';
import { useCallback, useEffect, useRef } from 'react';
import { groupPath, normalizedGroup } from '../shared/groups';
import type { CanvasBlock } from '../shared/types';
import { canvasConnection, documentDragChanges, droppedBlockPatch } from './canvas-drag';
import { drillCamera } from './canvas-drill-layout';
import { makeNodes } from './canvas-flow-helpers';
import { useCanvasFlowNodes } from './canvas-flow-nodes';
import { useCanvasGraph } from './canvas-graph';
import { changedCanvasNodes } from './canvas-node-changes';
import { pullNeighbors } from './canvas-interactions';
import { useCanvasState } from './canvas-state';
import { useCanvasOperationScope } from './canvas-model-scope';
import { useCanvasFocusRequests, useCanvasFitRequest } from './canvas-model-camera';
import type { CanvasNode, CanvasProps, FlowNode } from './canvas-types';
import { canvasFitPadding, rememberViewport } from './canvas-view-helpers';
import { useCanvasViewport, zoomBandFor } from './canvas-viewport';

export function useCanvasModel(props: CanvasProps) {
  const {
    canvas, theme = 'light', onUpdateBlock, onDeleteBlock, onSelectBlock, onReadBlock = onSelectBlock,
    onHistoryBlock = onSelectBlock, onOpenCrossLink, onMoveBlocks, focusRequest: requestedFocus,
    fitRequest, groupFocusRequest, searchQuery = '', searchMatchIds = [], onSummarizeSelection, onSelectionChange,
    viewportRequest, focusZoom, focusSelect = true, groupsEnabled = true,
  } = props;
  const { id: canvasId, blocks } = canvas;
  const canvasScope = useCanvasOperationScope(canvasId);
  const canvasGeneration = canvasScope.current.generation;
  const state = useCanvasState(props);
  const {
    message, setMessage, setHighlightedId, zoom, setZoom, mapPinned, setMapPinned, selectedIds, setSelectedIds,
    focusHops, setFocusHops, setCollapsed, drillGroup, setDrillGroup, activeSupergroup, setActiveSupergroup,
    mapParent, setMapParent, setMapColumns, showDrillBoard, setShowDrillBoard, setHoveredGroup, pointRequest,
    setPointRequest, pointSequence, setFittedGroup, pullActive, setPullActive, flowInstance,
    rememberedViewports, surface, zoomBand, enteringFiles, focusTransition, appliedFocusSequence,
    zoomIntent, zoomTarget, nodes, setNodes, onNodesChange, nodeSource, setNodeSource,
    selectionCallback, lastSelection,
  } = state;
  const { cameraRequest: focusRequest, selectionRequest } = useCanvasFocusRequests(viewportRequest?.sequence, requestedFocus, () => setPointRequest(undefined));
  const selectionTarget = blocks.find(block => block.id === selectionRequest?.blockId);
  const appliedFocusOwner = useRef({ generation: canvasGeneration, select: focusSelect });
  const activeFitRequest = useCanvasFitRequest(viewportRequest?.sequence, fitRequest, requestedFocus?.sequence);
  useEffect(() => {
    const element = surface.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      const columns = entry.contentRect.width >= 900 ? 3 : entry.contentRect.width >= 520 ? 2 : 1;
      setMapColumns(previous => previous === columns ? previous : columns);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const graph = useCanvasGraph(props, state);
  const {
    viewBlocks, zoomLevel, searchIds, livePositions, groupFrames, supergroups, supergroupByRoot, activeSuper, edges,
    selectedBlocks,
  } = graph;
  const focusGroup = useCallback((group: string) => {
    setFittedGroup(undefined);
    enteringFiles.current = true;
    const transition = ++focusTransition.current;
    window.setTimeout(() => { if (focusTransition.current === transition) enteringFiles.current = false; }, 650);
    setMapPinned(false);
    setHoveredGroup(null);
    setDrillGroup(group);
    setShowDrillBoard(false);
    setSelectedIds([]);
    setNodes(current => current.map(node => ({ ...node, selected: false })));
    lastSelection.current = '';
    setCollapsed(current => {
      const next = new Set(current);
      for (const path of groupPath(group)) next.delete(path);
      return next;
    });
    const frame = framesRef.current.find(item => item.group === group);
    const view = { width: surface.current?.clientWidth ?? 0, height: surface.current?.clientHeight ?? 0 };
    const camera = drillCamera(blocksRef.current, group, frame, view);
    if (camera) {
      const sequence = ++pointSequence.current;
      setPointRequest({ ...camera, sequence });
      setFittedGroup({ group, zoom: camera.zoom, sequence });
    }
  }, []);
  function setSupergroupForRoot(group: string) {
    if (supergroups.length) setActiveSupergroup(supergroupByRoot.get(groupPath(group)[0]) ?? '');
  }
  const openHierarchyGroup = useCallback((group: string) => {
    setHoveredGroup(null);
    if (group.startsWith('super:')) {
      setActiveSupergroup(group);
      setMapParent('');
      setDrillGroup('');
      return;
    }
    if (group.startsWith('files:')) {
      focusGroup(group.slice('files:'.length));
      return;
    }
    setSupergroupForRoot(group);
    const depth = groupPath(group).length;
    const hasChildren = groupFrames.some(frame => {
      const path = groupPath(frame.group);
      return path.length === depth + 1 && path[depth - 1] === group;
    });
    if (hasChildren && zoomLevel === 'overview') {
      setMapParent(group);
      setDrillGroup('');
    } else focusGroup(group);
  }, [focusGroup, groupFrames, zoomLevel, supergroups.length, supergroupByRoot]);
  const lastGroupFocus = useRef(0);
  useEffect(() => {
    if (!groupFocusRequest || groupFocusRequest.canvasId !== canvasId || lastGroupFocus.current === groupFocusRequest.sequence) return;
    if (!viewBlocks.some(block => groupPath(normalizedGroup(block.group) ?? '__ungrouped').includes(groupFocusRequest.group))) return;
    lastGroupFocus.current = groupFocusRequest.sequence;
    focusGroup(groupFocusRequest.group);
  }, [groupFocusRequest, canvasId, viewBlocks, focusGroup]);
  const returnOverview = useCallback(() => {
    focusTransition.current++;
    enteringFiles.current = false;
    setPointRequest(undefined);
    setFittedGroup(undefined);
    setMapPinned(true);
    setDrillGroup('');
    setShowDrillBoard(false);
    setMapParent('');
    setActiveSupergroup('');
    setSelectedIds([]);
    setNodes(current => current.map(node => ({ ...node, selected: false })));
    lastSelection.current = '';
    void flowInstance.current?.setViewport({ x: 24, y: 68, zoom: 0.28 }, { duration: 250 });
  }, []);
  const toggleGroup = useCallback((group: string) => setCollapsed(current => {
    const next = new Set(current);
    if (next.has(group)) next.delete(group); else next.add(group);
    return next;
  }), []);
  const flowNodes = useCanvasFlowNodes(props, state, graph, { focusGroup, openHierarchyGroup, toggleGroup });
  const framesRef = useRef(groupFrames);
  framesRef.current = groupFrames;
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const onSelectBlockRef = useRef(onSelectBlock);
  onSelectBlockRef.current = onSelectBlock;
  const openBlock = useCallback((block: CanvasBlock) => onSelectBlockRef.current(block), []);
  const onReadBlockRef = useRef(onReadBlock);
  onReadBlockRef.current = onReadBlock;
  const readBlock = useCallback((block: CanvasBlock) => onReadBlockRef.current(block), []);
  const onHistoryBlockRef = useRef(onHistoryBlock);
  onHistoryBlockRef.current = onHistoryBlock;
  const historyBlock = useCallback((block: CanvasBlock) => onHistoryBlockRef.current(block), []);
  const onOpenCrossLinkRef = useRef(onOpenCrossLink);
  onOpenCrossLinkRef.current = onOpenCrossLink;
  const openCrossLink = useCallback((targetCanvasId: string, blockId: string) => onOpenCrossLinkRef.current?.(targetCanvasId, blockId), []);

  const reportError = useCallback((reason: string) => {
    if (canvasScope.current.generation === canvasGeneration) setMessage(reason);
  }, [canvasGeneration]);
  const updateBlockRef = useRef(onUpdateBlock);
  updateBlockRef.current = onUpdateBlock;
  const saveBlock = useCallback(async (blockId: string, patch: Partial<CanvasBlock>) => {
    const generation = canvasScope.current.generation;
    try {
      setMessage('');
      await updateBlockRef.current(blockId, patch);
    } catch (error) {
      if (canvasScope.current.generation === generation) setMessage(error instanceof Error ? `Could not save: ${error.message}` : 'Could not save this change.');
      throw error;
    }
  }, []);
  const resizeBlock = useCallback((blockId: string, patch: Partial<CanvasBlock>) => {
    void saveBlock(blockId, patch).catch(() => undefined);
  }, [saveBlock]);
  useEffect(() => {
    if (!selectionRequest) return;
    if (appliedFocusMatches(appliedFocusSequence.current, appliedFocusOwner.current, canvasGeneration, selectionRequest.sequence, focusSelect)) return;
    const target = selectionTarget;
    if (!target) return;
    appliedFocusOwner.current = { generation: canvasGeneration, select: focusSelect };
    applyFocusSelection(state, target, selectionRequest, focusSelect);
    setCollapsed(current => {
      const next = new Set(current);
      for (const path of groupPath(normalizedGroup(target?.group) ?? '')) next.delete(path);
      return next;
    });
    setDrillGroup('');
    enteringFiles.current = true;
    const transition = ++focusTransition.current;
    window.setTimeout(() => { if (focusTransition.current === transition) enteringFiles.current = false; }, 650);
    setMapPinned(false);
    setShowDrillBoard(false);
    setActiveSupergroup('');
    setMapParent('');
    const timer = window.setTimeout(() => setHighlightedId(''), 2500);
    return () => window.clearTimeout(timer);
    // Source refreshes retain the consumed request; only request/target arrival,
    // canvas binding or selection mode changes start its selection lifecycle.
  }, [selectionRequest?.sequence, selectionTarget?.id, canvasGeneration, setNodes, focusSelect]);
  useEffect(() => {
    if (activeFitRequest === undefined) return;
    const timer = window.setTimeout(() => {
      void flowInstance.current?.fitView({ padding: canvasFitPadding, maxZoom: 0.75, duration: 350 });
    }, 180);
    return () => window.clearTimeout(timer);
  }, [activeFitRequest, canvasId]);
  const previousCanvasView = useRef({ canvasId, viewportSequence: viewportRequest?.sequence, focusSequence: requestedFocus?.sequence });
  useEffect(() => {
    const previous = previousCanvasView.current;
    previousCanvasView.current = { canvasId, viewportSequence: viewportRequest?.sequence, focusSequence: requestedFocus?.sequence };
    if (previous.canvasId === canvasId) return;
    const leavingViewport = flowInstance.current?.getViewport();
    if (leavingViewport) rememberViewport(rememberedViewports.current, previous.canvasId, leavingViewport);
    // Bookmarked viewports and focused documents set their own destination after navigation.
    if (previous.viewportSequence !== viewportRequest?.sequence || previous.focusSequence !== requestedFocus?.sequence) return;
    const remembered = rememberedViewports.current.get(canvasId);
    const frame = window.requestAnimationFrame(() => {
      if (remembered) void flowInstance.current?.setViewport(remembered, { duration: 0 });
      else void flowInstance.current?.fitView({ padding: canvasFitPadding, maxZoom: 1, duration: 0 });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [canvasId, viewportRequest?.sequence, requestedFocus?.sequence]);
  useEffect(() => {
    if (!mapPinned) return;
    const frame = window.requestAnimationFrame(() => {
      const instance = flowInstance.current;
      if (instance) void instance.setViewport({ x: 24, y: 68, zoom: 0.28 }, { duration: 250 });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [canvasId, mapPinned, activeSupergroup, mapParent]);
  const selectNodes = useCallback(({ nodes: chosen }: { nodes: FlowNode[] }) => {
    const ids = chosen.filter(node => node.type === 'document').map(node => node.id);
    const key = [...ids].sort().join('\u0000');
    if (lastSelection.current === key) return;
    lastSelection.current = key;
    setSelectedIds(ids);
    const target = ids.length === 1 ? blocks.find(block => block.id === ids[0]) : undefined;
    if (target) setPointRequest({ x: target.x + target.width / 2, y: target.y + target.height / 2, zoom: Math.max(zoom, 0.85), sequence: ++pointSequence.current });
    selectionCallback.current?.(blocks.filter(block => ids.includes(block.id)));
  }, [blocks, zoom]);
  const selectBlock = useCallback((blockId: string) => {
    const target = blocks.find(block => block.id === blockId);
    if (!target) return;
    if (lastSelection.current === blockId) return;
    setShowDrillBoard(false);
    lastSelection.current = blockId;
    setNodes(current => current.map(node => ({ ...node, selected: node.id === blockId })));
    setSelectedIds([blockId]);
    setPointRequest({ x: target.x + target.width / 2, y: target.y + target.height / 2, zoom: Math.max(zoom, 0.85), sequence: ++pointSequence.current });
    selectionCallback.current?.([target]);
  }, [blocks, zoom, setNodes]);
  const { moved, moveEnded } = useCanvasViewport(state, graph, props, flowNodes, openHierarchyGroup);
  const restoreLayout = useCallback(() => {
    setNodes(current => current.map(node => ({ ...node, position: { x: node.data.block.x, y: node.data.block.y } })));
    setPullActive(false);
  }, [setNodes]);
  const pullRelated = useCallback(() => {
    if (selectedIds.length !== 1) return;
    const positions = pullNeighbors(blocks, selectedIds[0], focusHops);
    setNodes(current => current.map(node => ({ ...node, position: positions.get(node.id) ?? node.position })));
    setPullActive(true);
  }, [blocks, selectedIds, focusHops, setNodes]);

  /** Dragging a frame moves every card in it by the same amount. */
  const changeNodes = useCallback((changes: NodeChange<FlowNode>[]) => {
    const documentChanges = changedCanvasNodes(documentDragChanges(changes, framesRef.current, nodesRef.current), nodesRef.current);
    if (documentChanges.length) onNodesChange(documentChanges);
  }, [onNodesChange]);
  const saveGroupMove = useCallback((frameId: string) => {
    const generation = canvasScope.current.generation;
    const frame = framesRef.current.find(item => item.id === frameId);
    if (!frame) return;
    const positions = frame.members.flatMap(id => {
      const node = nodesRef.current.find(item => item.id === id);
      return node ? [{ blockId: id, x: node.position.x, y: node.position.y }] : [];
    });
    if (!positions.length) return;
    setMessage('');
    const save = onMoveBlocks ? onMoveBlocks(positions) : Promise.all(positions.map(position => saveBlock(position.blockId, { x: position.x, y: position.y })));
    void Promise.resolve(save).catch((error: unknown) => {
      if (canvasScope.current.generation === generation) setMessage(error instanceof Error ? `Could not move group: ${error.message}` : 'Could not move this group.');
    });
  }, [onMoveBlocks, saveBlock]);

  /** A card dropped inside another group's frame joins it; a card dropped well outside its own frame leaves it. */
  const dropBlock = useCallback((node: CanvasNode) => {
    const patch = groupsEnabled ? droppedBlockPatch(node, blocks, livePositions) : { x: node.position.x, y: node.position.y };
    void saveBlock(node.id, patch).catch(() => undefined);
  }, [blocks, livePositions, saveBlock, groupsEnabled]);
  const connect = useCallback((connection: Connection) => {
    const documentConnection = canvasConnection(connection, blocks);
    if (!documentConnection) return;
    const { source, target } = documentConnection;
    if (!source || source.links.includes(target)) return;
    void saveBlock(source.id, { links: [...source.links, target] }).catch(() => undefined);
  }, [blocks, saveBlock]);
  const deleteEdges = useCallback((removed: Edge[]) => {
    const targetsBySource = new Map<string, Set<string>>();
    for (const edge of removed) {
      if (edge.id.startsWith('group-edge:')) continue;
      const targets = targetsBySource.get(edge.source) ?? new Set<string>();
      targets.add(edge.target);
      targetsBySource.set(edge.source, targets);
    }
    for (const [sourceId, targets] of targetsBySource) {
      const source = blocks.find((block) => block.id === sourceId);
      if (source) void saveBlock(sourceId, { links: source.links.filter((link) => !targets.has(link)) }).catch(() => undefined);
    }
  }, [blocks, saveBlock]);
  const beforeDelete = useCallback(async ({ nodes: removed }: { nodes: FlowNode[]; edges: Edge[] }) => {
    const generation = canvasScope.current.generation;
    const documents = removed.filter(node => node.type === 'document');
    if (!documents.length) return removed.length === 0;
    setMessage('');
    try {
      for (const node of documents) await onDeleteBlock(node.id);
    } catch (error) {
      if (canvasScope.current.generation === generation) setMessage(error instanceof Error ? `Could not delete: ${error.message}` : 'Could not delete this document.');
    }
    // The refreshed canvas props replace the nodes after the server deletes them.
    return false;
  }, [onDeleteBlock]);

  // React discards this render and retries with the new nodes before React Flow commits.
  // An effect here would commit old nodes once and then commit the new canvas a second time.
  if (!nodeSource || nodeSource.canvasId !== canvasId || nodeSource.blocks !== blocks) {
    const canvasChanged = Boolean(nodeSource && nodeSource.canvasId !== canvasId);
    setNodeSource({ canvasId, blocks });
    const refreshedNodes = makeNodes(canvasId, blocks, saveBlock, openBlock, readBlock, historyBlock, openCrossLink, resizeBlock, reportError);
    setNodes(preservedNodeSelection(refreshedNodes, flowNodes, nodeSource?.canvasId === canvasId));
    setPullActive(false);
    if (canvasChanged) {
      resetCanvasState(state);
      const nextZoom = restoredCanvasZoom(props, previousCanvasView.current, rememberedViewports.current);
      setZoom(nextZoom);
      zoomBand.current = zoomBandFor(nextZoom);
    }
  }
  return {
    canvas, theme, groupsEnabled, onUpdateBlock, onReadBlock, focusRequest, searchQuery, searchMatchIds, onSummarizeSelection,
    onSelectionChange, viewportRequest, focusZoom, focusSelect, canvasId, blocks, message, setMessage,
    zoom, mapPinned, selectedIds, setSelectedIds, focusHops, setFocusHops, drillGroup, setDrillGroup, mapParent,
    setMapParent, showDrillBoard, setShowDrillBoard, pointRequest, pullActive, flowInstance, surface,
    zoomIntent, zoomTarget, nodes, onNodesChange, selectionCallback, lastSelection, viewBlocks, zoomLevel, searchIds,
    groupFrames, supergroups, activeSuper, edges, selectedBlocks, focusGroup, openHierarchyGroup, returnOverview,
    overviewSequence: focusTransition.current,
    flowNodes, openBlock, readBlock, reportError, saveBlock, selectNodes, selectBlock, moved, moveEnded,
    restoreLayout, pullRelated, changeNodes, saveGroupMove, dropBlock, connect,
    deleteEdges, beforeDelete,
  };
}

export type CanvasModel = ReturnType<typeof useCanvasModel>;

function preservedNodeSelection(next: CanvasNode[], visible: FlowNode[], sameCanvas: boolean) {
  if (!sameCanvas) return next;
  const selected = new Set(visible.filter(node => node.selected).map(node => node.id));
  return next.map(node => selected.has(node.id) ? { ...node, selected: true } : node);
}

function applyFocusSelection(state: ReturnType<typeof useCanvasState>, target: CanvasBlock, focusRequest: NonNullable<CanvasProps['focusRequest']>, focusSelect: boolean) {
  const { appliedFocusSequence, setHighlightedId, setSelectedIds, setNodes, lastSelection, selectionCallback } = state;
  appliedFocusSequence.current = focusRequest.sequence;
  setHighlightedId(focusRequest.blockId);
  setSelectedIds(focusSelect ? [focusRequest.blockId] : []);
  setNodes(current => current.map(node => ({ ...node, selected: focusSelect && node.id === focusRequest.blockId })));
  if (focusSelect && lastSelection.current !== target.id) {
    lastSelection.current = target.id;
    selectionCallback.current?.([target]);
  }
}

function appliedFocusMatches(sequence: number | undefined, owner: { generation: number; select: boolean }, generation: number, requested: number, select: boolean) {
  return sequence === requested && owner.generation === generation && owner.select === select;
}

function resetCanvasState(state: ReturnType<typeof useCanvasState>) {
  const {
    setSelectedIds, lastSelection, setCollapsed, setDrillGroup, setMapPinned, focusTransition, enteringFiles,
    setShowDrillBoard, setActiveSupergroup, setMapParent, setHoveredGroup, setHighlightedId, setPointRequest,
    setFocusHops, setMessage, setFittedGroup,
  } = state;
  setSelectedIds([]);
  lastSelection.current = '';
  setCollapsed(new Set());
  setDrillGroup('');
  setMapPinned(false);
  focusTransition.current++;
  enteringFiles.current = false;
  setShowDrillBoard(false);
  setActiveSupergroup('');
  setMapParent('');
  setHoveredGroup(null);
  setHighlightedId('');
  setPointRequest(undefined);
  setFittedGroup(undefined);
  setFocusHops(1);
  setMessage('');
}

function restoredCanvasZoom(props: CanvasProps, previous: { viewportSequence?: number; focusSequence?: number }, remembered: Map<string, Viewport>) {
  const explicitView = previous.viewportSequence !== props.viewportRequest?.sequence
    || previous.focusSequence !== props.focusRequest?.sequence;
  return (explicitView ? undefined : remembered.get(props.canvas.id))?.zoom ?? 1;
}
