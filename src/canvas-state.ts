import { useNodesState, type Edge, type ReactFlowInstance, type Viewport } from '@xyflow/react';
import { useRef, useState } from 'react';
import type { CanvasBlock } from '../shared/types';
import type { CanvasNode, CanvasProps, FlowNode } from './canvas-types';

export function useCanvasState(props: CanvasProps) {
  const { onSelectionChange, onViewportChange } = props;
  const initialOverview = props.canvas.blocks.length >= 100;
  const [message, setMessage] = useState('');
  const [highlightedId, setHighlightedId] = useState('');
  const [zoom, setZoom] = useState(initialOverview ? .28 : 1);
  const [mapPinned, setMapPinned] = useState(initialOverview);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [focusHops, setFocusHops] = useState<1 | 2>(1);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [drillGroup, setDrillGroup] = useState('');
  const [activeSupergroup, setActiveSupergroup] = useState('');
  const [mapParent, setMapParent] = useState('');
  const [mapColumns, setMapColumns] = useState(2);
  const [showDrillBoard, setShowDrillBoard] = useState(false);
  const [hoveredGroup, setHoveredGroup] = useState<string | null>(null);
  const [pointRequest, setPointRequest] = useState<{ x: number; y: number; zoom: number; sequence: number }>();
  const [fittedGroup, setFittedGroup] = useState<{ group: string; zoom: number; sequence: number }>();
  const fittedGroupSettled = useRef<number | undefined>(undefined);
  const pointSequence = useRef(0);
  const [pullActive, setPullActive] = useState(false);
  const flowInstance = useRef<ReactFlowInstance<FlowNode, Edge> | null>(null);
  const rememberedViewports = useRef(new Map<string, Viewport>());
  const surface = useRef<HTMLElement>(null);
  const zoomBand = useRef<'overview' | 'titles' | 'full'>(initialOverview ? 'overview' : 'full');
  const enteringFiles = useRef(false);
  const focusTransition = useRef(0);
  const appliedFocusSequence = useRef<number | undefined>(undefined);
  const zoomIntent = useRef<'in' | 'out' | null>(null);
  const zoomTarget = useRef<string | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>([]);
  const [nodeSource, setNodeSource] = useState<{ canvasId: string; blocks: CanvasBlock[] } | null>(null);
  const selectionCallback = useRef(onSelectionChange);
  selectionCallback.current = onSelectionChange;
  const viewportCallback = useRef(onViewportChange);
  viewportCallback.current = onViewportChange;
  const lastSelection = useRef('');
  return {
    message, setMessage, highlightedId, setHighlightedId, zoom, setZoom, mapPinned, setMapPinned, selectedIds,
    setSelectedIds, focusHops, setFocusHops, collapsed, setCollapsed, drillGroup, setDrillGroup, activeSupergroup,
    setActiveSupergroup, mapParent, setMapParent, mapColumns, setMapColumns, showDrillBoard, setShowDrillBoard,
    hoveredGroup, setHoveredGroup, pointRequest, setPointRequest, pointSequence, fittedGroup, setFittedGroup, fittedGroupSettled,
    pullActive, setPullActive, flowInstance, rememberedViewports, surface, zoomBand, enteringFiles, focusTransition,
    appliedFocusSequence, zoomIntent, zoomTarget, nodes, setNodes, onNodesChange, nodeSource,
    setNodeSource, selectionCallback, viewportCallback, lastSelection,
  };
}

export type CanvasState = ReturnType<typeof useCanvasState>;
