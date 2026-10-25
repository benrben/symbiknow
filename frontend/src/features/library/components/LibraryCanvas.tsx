import { useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  Handle,
  Position,
  MarkerType,
  BaseEdge,
  type EdgeProps,
  applyNodeChanges,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import { Folder, ChevronDown, ChevronRight, Image as ImageIcon, MousePointer2, Hand, Minus, Plus, Scan, SlidersHorizontal, Undo2 } from "lucide-react";
import { DocumentIcon as FileText } from "../../../shared/components/KnowledgeIcons";
import "@xyflow/react/dist/style.css";
import {
  title,
  kind,
  formatLabel,
  linkKey,
  uniqueLinks,
  folderCounts,
  type Doc,
  type Link,
} from "../../../shared/api/client";
import { preferenceKey, readSaved, save, usePreference } from "../../../shared/presentation/format";
import { Judgment, type SelectionEvent } from "./FileList";
import ContentCard from "./ContentCard";
function FolderNode({ data }: NodeProps) {
  return (
    <div className="folder-container">
      <div className="folder-heading frame-handle">
        <button
          className="icon nodrag"
          aria-label={(data.expanded ? "Collapse " : "Expand ") + data.name}
          onClick={() => (data.toggle as () => void)()}
        >
          {data.expanded ? (
            <ChevronDown size={15} />
          ) : (
            <ChevronRight size={15} />
          )}
        </button>
        <Folder size={18} />
        <button
          className="frame-label nodrag"
          title={String(data.path)}
          onClick={() => (data.choose as () => void)()}
        >
          {String(data.name) || "Unfiled"}
        </button>
        <small>
          {String(data.count)}{" "}
          {data.search
            ? data.count === 1
              ? "match"
              : "matches"
            : data.count === 1
              ? "file"
              : "files"}
        </small>
      </div>
      {data.more ? (
        <button
          className="frame-more nodrag"
          onClick={() => (data.choose as () => void)()}
        >
          {String(data.shown)} of {String(data.count)} files shown · Open folder
        </button>
      ) : null}
      {!data.expanded && (
        <p className="frame-summary">{String(data.summary)}</p>
      )}
    </div>
  );
}
function DocumentNode({ data }: NodeProps) {
  const d = data.doc as Doc;
  return (
    <div
      data-document-id={d.document_id}
      className={
        "canvas-document " +
        (data.search ? "search-card " : "") +
        (data.overview ? "overview-card " : "") +
        (data.legacyGeometry ? "legacy-card " : "") +
        (data.selected ? "selected" : "") +
        (data.search && !data.matched ? " context-card" : "")
      }
    >
      <Handle
        id="in"
        type="target"
        position={Position.Top}
        isConnectable={false}
      />
      <div className="card-handle">
        {kind(d) === "Image" ? <ImageIcon size={16} /> : <FileText size={16} />}
        <button
          className="canvas-title nodrag"
          title={d.filename}
          aria-label={"Select " + title(d)}
          onClick={(e) => {
            e.stopPropagation();
            (data.select as (e: SelectionEvent) => void)(e);
          }}
          onDoubleClick={() => (data.open as () => void)()}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              const action = (
                e.key === " " ? data.quickLook : data.open
              ) as () => void;
              action();
            }
          }}
        >
          {title(d)}
        </button>
        <small>{kind(d) === "Markdown" ? "MD" : kind(d)}</small>
      </div>
      <div
        onClick={(e) => {
          e.stopPropagation();
          (data.select as (e: SelectionEvent) => void)(e);
        }}
        onDoubleClick={() => (data.open as () => void)()}
      >
        <ContentCard
          doc={d}
          compactPreview
          search={!!data.search && !!data.matched}
          evaluate={!!data.evaluate}
          query={String(data.query || "")}
        />
      </div>
      <div className="canvas-meta">
        <span>{formatLabel(d)}</span>
        <span>{d.version}</span>
      </div>
      {data.search ? (
        data.matched ? (
          <div className="canvas-judgment">
            <small>#{Number(data.rank)}</small>
            <Judgment
              doc={d}
              evaluate={!!data.evaluate}
              unavailable={!!data.unavailable}
              onEvidence={data.evidence as () => void}
            />
          </div>
        ) : (
          <small className="context-label">Related context</small>
        )
      ) : null}
      <Handle
        id="out"
        type="source"
        position={Position.Top}
        isConnectable={false}
      />
    </div>
  );
}
function RoutedLink({
  sourceX,
  sourceY,
  targetX,
  targetY,
  data,
  ...props
}: EdgeProps) {
  const lane = Number(data?.lane),
    shelfA = sourceY - 14,
    shelfB = targetY - 14;
  return (
    <BaseEdge
      {...props}
      path={`M ${sourceX},${sourceY} V ${shelfA} H ${lane} V ${shelfB} H ${targetX} V ${targetY}`}
      labelX={lane}
      labelY={(shelfA + shelfB) / 2}
    />
  );
}
const edgeTypes = { routed: RoutedLink };
const nodeTypes = { folder: FolderNode, document: DocumentNode };
type XY = { x: number; y: number };
const GEOMETRY_VERSION = 3;
const MIN_ZOOM = 0.01;
type Origin = "generated" | "manual" | "legacy";
type Geometry = { version: number; cardWidth: number; cardHeight: number };
type Layout = {
  positions: Record<string, XY>;
  overviewPositions?: Record<string, XY>;
  folderById?: Record<string, string>;
  viewport?: { x: number; y: number; zoom: number };
  collapsed: string[];
  overview?: boolean;
  geometry?: Geometry;
  overviewGeometry?: Geometry;
  positionOrigins?: Record<string, Origin>;
  overviewPositionOrigins?: Record<string, Origin>;
  previous?: Layout;
};
const blank = (): Layout => ({ positions: {}, collapsed: [] });
function validLayout(value: Layout, allowPrevious = true): Layout {
  if (!value || typeof value !== "object") return blank();
  const positions: Record<string, XY> = {};
  if (value.positions && typeof value.positions === "object")
    for (const [id, xy] of Object.entries(value.positions).slice(0, 200))
      if (xy && Number.isFinite(xy.x) && Number.isFinite(xy.y))
        positions[id] = xy;
  const v = value.viewport;
  const overviewPositions: Record<string, XY> = {};
  for (const [id, xy] of Object.entries(value.overviewPositions || {}).slice(
    0,
    200,
  ))
    if (xy && Number.isFinite(xy.x) && Number.isFinite(xy.y))
      overviewPositions[id] = xy;
  const origins = (map: Record<string, XY>, raw?: Record<string, Origin>) =>
    Object.fromEntries(
      Object.keys(map).map((id) => [
        id,
        ["generated", "manual", "legacy"].includes(raw?.[id] || "")
          ? raw![id]
          : "legacy",
      ]),
    );
  const geometry = (raw?: Geometry) =>
    raw && [raw.version, raw.cardWidth, raw.cardHeight].every(Number.isFinite)
      ? raw
      : undefined;
  return {
    positions,
    overviewPositions,
    positionOrigins: origins(positions, value.positionOrigins),
    overviewPositionOrigins: origins(
      overviewPositions,
      value.overviewPositionOrigins,
    ),
    geometry: geometry(value.geometry),
    overviewGeometry: geometry(value.overviewGeometry),
    previous:
      allowPrevious && value.previous
        ? validLayout(value.previous, false)
        : undefined,
    folderById:
      value.folderById && typeof value.folderById === "object"
        ? value.folderById
        : {},
    overview: value.overview === true,
    collapsed: Array.isArray(value.collapsed)
      ? value.collapsed.filter((s) => typeof s === "string").slice(0, 100)
      : [],
    viewport:
      !(value.overview && !value.overviewPositions) &&
      v &&
      [v.x, v.y, v.zoom].every(Number.isFinite) &&
      v.zoom >= MIN_ZOOM &&
      v.zoom <= 2
        ? v
        : undefined,
  };
}
function frameFor(d: Doc, scope?: string) {
  const folder = d.folder || "";
  if (scope !== undefined && folder === scope) return "";
  if (scope && folder.startsWith(scope + " / "))
    return scope + " / " + folder.slice(scope.length + 3).split(" / ")[0];
  return folder.split(" / ")[0];
}
const overlaps = (a: XY, b: XY, height: number) =>
  a.x < b.x + 174 &&
  a.x + 174 > b.x &&
  a.y < b.y + height &&
  a.y + height > b.y;
export default function LibraryCanvas(p: {
  docs: Doc[];
  links: Link[];
  selected?: string;
  selectedIds: string[];
  onSelect: (d: Doc, e?: SelectionEvent) => void;
  onOpen: (d: Doc) => void;
  onEvidence: (d: Doc) => void;
  onQuickLook: (d: Doc) => void;
  onLink: (l: Link) => void;
  search?: boolean;
  query?: string;
  evaluate?: boolean;
  unavailable?: boolean;
  matchedIds?: string[];
  searchKey?: string;
  libraryId: string;
  scope?: string;
  folders: Record<string, number>;
  total: number;
  onFolder: (f: string) => void;
}) {
  const key = preferenceKey(
    p.libraryId,
    "canvas:" +
      (p.scope === undefined ? "*" : p.scope) +
      (p.search
        ? "|search:" +
          Array.from(p.searchKey || "")
            .reduce((n, c) => (n * 31 + c.charCodeAt(0)) | 0, 0)
            .toString(36)
        : ""),
  );
  const [layout, setLayout] = useState<Layout>(() =>
    validLayout(readSaved(key, blank())),
  );
  const latestLayout = useRef(layout);
  latestLayout.current = layout;
  const latestViewport = useRef(layout.viewport);
  const mounted = useRef(true);
  const organizationRevision = useRef(
    readSaved(preferenceKey(p.libraryId, "organizationRevision"), ""),
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // A view switch can unmount before React Flow's move-end event arrives.
      // Never resurrect entries that an organization reset has just invalidated.
      if (
        latestViewport.current &&
        organizationRevision.current ===
          readSaved(preferenceKey(p.libraryId, "organizationRevision"), "")
      )
        save(key, {
          ...latestLayout.current,
          viewport: latestViewport.current,
        });
    };
  }, [key, p.libraryId]);
  const [undo, setUndo] = useState<Layout | undefined>(layout.previous),
    [pan, setPan] = useState(false),
    [zoom, setZoom] = useState(1),
    [overview, setOverview] = useState(layout.overview === true);
  const [linksDisplay, setLinksDisplay] = usePreference<
    "selected" | "all" | "hidden"
  >(p.libraryId, "linksDisplay", "selected", (v) =>
    ["selected", "all", "hidden"].includes(v),
  );
  const [selectedLink, setSelectedLink] = useState<Link>();
  useEffect(() => {
    if (
      selectedLink &&
      !p.links.some((l) => linkKey(l) === linkKey(selectedLink))
    )
      setSelectedLink(undefined);
  }, [p.links, selectedLink]);
  const [searchCollapsed, setSearchCollapsed] = useState<string[]>(
    layout.collapsed,
  );

  const surfaceRef = useRef<HTMLDivElement>(null);
  const [surfaceSize, setSurfaceSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = surfaceRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      setSurfaceSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const pendingFit = useRef<
    { ids: string[] | null; reading?: boolean } | undefined
  >(undefined);
  const [flow, setFlow] = useState<ReactFlowInstance | null>(null),
    [nodes, setNodes] = useState<Node[]>([]);
  const fitted = useRef("");
  const fitRevision = useRef(0);
  const focusGroup = useRef<(ids: string[]) => void>(() => {});
  const draggingNode = useRef(false);
  const matched = p.matchedIds || [];
  const legacyFrames = useMemo(() => {
    const frames = new Set<string>();
    const docs = p.docs.filter(
      (d) =>
        layout.positions[d.document_id] &&
        frameFor(
          { ...d, folder: layout.folderById?.[d.document_id] },
          p.scope,
        ) === frameFor(d, p.scope),
    );
    for (let i = 0; i < docs.length; i++)
      for (let n = i + 1; n < docs.length; n++) {
        const a = docs[i],
          b = docs[n],
          path = frameFor(a, p.scope);
        if (path !== frameFor(b, p.scope)) continue;
        const unknown = [a, b].some(
          (d) =>
            (layout.positionOrigins?.[d.document_id] || "legacy") === "legacy",
        );
        if (
          unknown &&
          overlaps(
            layout.positions[a.document_id],
            layout.positions[b.document_id],
            142,
          ) &&
          !overlaps(
            layout.positions[a.document_id],
            layout.positions[b.document_id],
            112,
          )
        )
          frames.add(path);
      }
    return frames;
  }, [
    p.docs,
    p.scope,
    layout.positions,
    layout.positionOrigins,
    layout.folderById,
  ]);
  // Keep the older detailed height throughout a map awaiting explicit reflow.
  // Otherwise enlarging the unaffected frames moves saved cards and folders
  // before the user has accepted the reversible spacing upgrade.
  const detailedHeight = p.search ? (legacyFrames.size ? 142 : 224) : 196;
  const built = useMemo(() => {
    if (!surfaceSize.width) return [];
    const frames = new Map<string, Doc[]>();
    p.docs.slice(0, 100).forEach((d) => {
      const f = frameFor(d, p.scope);
      frames.set(f, [...(frames.get(f) || []), d]);
    });
    const counts = folderCounts(p.folders),
      all: Node[] = [];
    let rowY = 24,
      rowHeight = 0,
      columnX = 24;
    const frameWidth =
      overview && !p.search
        ? 200
        : frames.size > 1 && surfaceSize.width >= 848
          ? 384
          : surfaceSize.width >= 618
            ? 570
            : 384;
    const assignmentChanged = p.docs.some(
      (d) =>
        typeof layout.folderById?.[d.document_id] === "string" &&
        layout.folderById[d.document_id] !== (d.folder || ""),
    );
    const originMap =
      (overview ? layout.overviewPositionOrigins : layout.positionOrigins) ||
      {};
    const recordedGeometry = overview
      ? layout.overviewGeometry
      : layout.geometry;
    const currentHeight = overview ? 72 : detailedHeight;
    const geometryChanged =
      !recordedGeometry ||
      recordedGeometry.version !== GEOMETRY_VERSION ||
      recordedGeometry.cardWidth !== 174 ||
      recordedGeometry.cardHeight !== currentHeight;
    const savedPositions = Object.fromEntries(
      Object.entries(
        overview ? layout.overviewPositions || {} : layout.positions,
      ).filter(([id]) => !(geometryChanged && originMap[id] === "generated")),
    );
    [...frames]
      .sort(([a], [b]) => a.localeCompare(b))
      .forEach(([path, allDocs], i) => {
        // Search is the same result set as Files. Only ordinary browsing uses
        // representative previews; a large folder count must not discard hits.
        const docs = p.search
          ? allDocs
          : allDocs.slice(0, frames.size > 6 ? 1 : 6);
        if (!p.search && p.selected) {
          const important = new Set([
            p.selected,
            ...p.links
              .filter(
                (l) =>
                  l.source_document_id === p.selected ||
                  l.document_id === p.selected,
              )
              .flatMap((l) => [l.source_document_id, l.document_id]),
          ]);
          for (const doc of allDocs.filter((d) =>
            important.has(d.document_id),
          )) {
            if (!docs.some((d) => d.document_id === doc.document_id)) {
              let replace = docs.length - 1;
              while (replace >= 0 && important.has(docs[replace].document_id))
                replace--;
              if (replace >= 0) docs[replace] = doc;
            }
          }
        }
        const id = "folder:" + path,
          expanded = p.search
            ? !searchCollapsed.includes(path)
            : !layout.collapsed.includes(path);
        const compatible = (d: Doc) =>
          typeof layout.folderById?.[d.document_id] === "string" &&
          frameFor(
            { ...d, folder: layout.folderById[d.document_id] },
            p.scope,
          ) === path;
        const positions: Record<string, XY> = {};
        const cardWidth = 174,
          cardHeight =
            !overview && p.search && legacyFrames.has(path)
              ? 112
              : currentHeight,
          cardColumns = overview && !p.search ? 1 : frameWidth >= 550 ? 3 : 2;
        const occupied: XY[] = geometryChanged
          ? []
          : docs.flatMap((d) =>
              compatible(d) && savedPositions[d.document_id]
                ? [savedPositions[d.document_id]]
                : [],
            );
        const placementDocs = geometryChanged
          ? [...docs].sort(
              (a, b) =>
                Number(originMap[b.document_id] === "manual") -
                Number(originMap[a.document_id] === "manual"),
            )
          : docs;
        for (const d of placementDocs) {
          let pos = compatible(d) ? savedPositions[d.document_id] : undefined;
          let slot = 0;
          // Growing a preview must not cover its neighbor. Keep every compatible
          // placement unless the new card bounds collide after a geometry upgrade.
          if (
            pos &&
            geometryChanged &&
            !legacyFrames.has(path) &&
            occupied.some(
              (xy) =>
                Math.abs(pos!.x - xy.x) < cardWidth + 6 &&
                Math.abs(pos!.y - xy.y) < cardHeight + 10,
            )
          )
            pos = undefined;
          if (!pos) {
            do {
              pos = {
                x: 12 + (slot % cardColumns) * (cardWidth + 12),
                y: 44 + Math.floor(slot / cardColumns) * (cardHeight + 12),
              };
              slot++;
            } while (
              occupied.some(
                (xy) =>
                  Math.abs(pos!.x - xy.x) < cardWidth + 6 &&
                  Math.abs(pos!.y - xy.y) < cardHeight + 10,
              )
            );
          }
          occupied.push(pos);
          positions[d.document_id] = pos;
        }
        const width = expanded
          ? Math.max(
              overview && !p.search
                ? 198
                : docs.length > 2
                  ? frameWidth
                  : docs.length > 1
                    ? 384
                    : 198,
              ...Object.values(positions).map((pos) => pos.x + cardWidth + 12),
            )
          : 260;
        const height = expanded
          ? Math.max(
              docs.length ? 128 : 80,
              ...Object.values(positions).map(
                (pos) =>
                  pos.y +
                  cardHeight +
                  (!p.search &&
                  (path ? counts[path] || 0 : p.folders[p.scope || ""] || 0) >
                    docs.length
                    ? 40
                    : 12),
              ),
            )
          : 84;
        // Shelf packing uses the actual width: a singleton does not consume
        // the pitch of a full two/three-column frame.
        if (columnX > 24 && columnX + width > surfaceSize.width - 24) {
          rowY += rowHeight + 32;
          rowHeight = 0;
          columnX = 24;
        }
        let { x, y } = savedPositions[id] || {
          x: columnX,
          y: rowY,
        };
        // Existing folder-assignment migration repairs containment collisions;
        // routine polling, resizing and view switches preserve saved positions.
        for (
          ;
          !savedPositions[id] ||
          assignmentChanged ||
          (geometryChanged && !legacyFrames.size);
        ) {
          const collision = all.find(
            (n) =>
              n.type === "folder" &&
              x < n.position.x + Number(n.style?.width) + 24 &&
              x + width + 24 > n.position.x &&
              y < n.position.y + Number(n.style?.height) + 24 &&
              y + height + 24 > n.position.y,
          );
          if (!collision) break;
          const nextX =
            collision.position.x + Number(collision.style?.width) + 32;
          const nextY =
            collision.position.y + Number(collision.style?.height) + 32;
          if (Math.abs(nextX - x) < Math.abs(nextY - y)) x = nextX;
          else y = nextY;
        }
        all.push({
          id,
          type: "folder",
          position: { x, y },
          dragHandle: ".frame-handle",
          draggable: true,
          data: {
            path: path || p.scope || "",
            placementOrigin: savedPositions[id]
              ? originMap[id] || "legacy"
              : "generated",
            name:
              path.split(" / ").at(-1) ||
              p.scope?.split(" / ").at(-1) ||
              "Unfiled",
            search: p.search,
            count: p.search
              ? allDocs.filter((d) => matched.includes(d.document_id)).length
              : path
                ? counts[path] || allDocs.length
                : (p.folders[p.scope || ""] ?? allDocs.length),
            shown: docs.length,
            more: !p.search
              ? (path
                  ? counts[path] || allDocs.length
                  : (p.folders[p.scope || ""] ?? allDocs.length)) > docs.length
              : false,
            expanded,
            summary: docs.slice(0, 3).map(title).join(" · "),
            choose: () =>
              p.search
                ? focusGroup.current(docs.map((d) => d.document_id))
                : p.onFolder(path || p.scope || ""),
            toggle: () => {
              const collapsed = p.search ? searchCollapsed : layout.collapsed;
              const nextCollapsed = collapsed.includes(path)
                ? collapsed.filter((f) => f !== path)
                : [...collapsed, path];
              if (p.search) setSearchCollapsed(nextCollapsed);
              setLayout((old) => {
                const next = { ...old, collapsed: nextCollapsed };
                save(key, next);
                return next;
              });
            },
          },
          style: {
            width,
            height,
            background: "var(--surface-frame)",
            borderColor: "var(--border)",
          },
        });
        if (expanded) {
          docs.forEach((d) => {
            const pos = positions[d.document_id];
            all.push({
              id: d.document_id,
              type: "document",
              parentId: id,
              extent: "parent",
              position: pos,
              dragHandle: ".card-handle",
              draggable: true,
              data: {
                doc: d,
                overview,
                legacyGeometry: !overview && p.search && legacyFrames.has(path),
                placementOrigin:
                  savedPositions[d.document_id] && compatible(d)
                    ? originMap[d.document_id] || "legacy"
                    : "generated",
                selected: p.selectedIds.includes(d.document_id),
                search: p.search,
                matched: matched.includes(d.document_id),
                rank: matched.indexOf(d.document_id) + 1,
                evaluate: p.evaluate,
                query: p.query,
                unavailable: p.unavailable,
                select: (e?: SelectionEvent) => p.onSelect(d, e),
                open: () => p.onOpen(d),
                evidence: () => p.onEvidence(d),
                quickLook: () => p.onQuickLook(d),
              },
              style: { width: cardWidth, height: cardHeight },
              zIndex: 2,
            });
          });
        }
        columnX += width + 32;
        rowHeight = Math.max(rowHeight, height);
      });
    return all;
  }, [
    p.docs,
    detailedHeight,
    p.links,
    surfaceSize.width,
    overview,
    p.scope,
    p.folders,
    p.selected,
    p.selectedIds,
    p.search,
    searchCollapsed,
    p.evaluate,
    p.query,
    p.unavailable,
    p.matchedIds,
    layout.positions,
    layout.overviewPositions,
    layout.folderById,
    layout.collapsed,
    layout.geometry,
    layout.overviewGeometry,
    layout.positionOrigins,
    layout.overviewPositionOrigins,
    legacyFrames,
    key,
    p.onSelect,
    p.onOpen,
    p.onEvidence,
    p.onQuickLook,
    p.onFolder,
  ]);
  useEffect(() => {
    if (draggingNode.current) return;
    setNodes((previous) => {
      const prior = new Map(previous.map((n) => [n.id, n]));
      return built.map((n) => ({
        ...n,
        // Old measurements must not pin a card to its pre-undo size.
        measured:
          prior.get(n.id)?.style?.height === n.style?.height &&
          prior.get(n.id)?.style?.width === n.style?.width
            ? prior.get(n.id)?.measured
            : undefined,
        initialWidth: Number(n.style?.width),
        initialHeight: Number(n.style?.height),
      }));
    });
    const field = overview ? "overviewPositions" : "positions";
    const current = layout[field] || {};
    const originField = overview
      ? "overviewPositionOrigins"
      : "positionOrigins";
    const geometryField = overview ? "overviewGeometry" : "geometry";
    const currentGeometry = {
      version: GEOMETRY_VERSION,
      cardWidth: 174,
      cardHeight: overview ? 72 : detailedHeight,
    };
    if (
      built.some(
        (n) =>
          !current[n.id] ||
          layout[originField]?.[n.id] !== n.data.placementOrigin ||
          layout[geometryField]?.version !== GEOMETRY_VERSION ||
          layout[geometryField]?.cardHeight !== currentGeometry.cardHeight ||
          current[n.id].x !== n.position.x ||
          current[n.id].y !== n.position.y ||
          (n.type === "document" &&
            layout.folderById?.[n.id] !== ((n.data.doc as Doc).folder || "")),
      )
    )
      setLayout((old) => {
        const positions = { ...old[field] },
          origins = { ...old[originField] },
          folderById = { ...old.folderById };
        built.forEach((n) => {
          positions[n.id] = n.position;
          origins[n.id] = n.data.placementOrigin as Origin;
          if (n.type === "document")
            folderById[n.id] = (n.data.doc as Doc).folder || "";
        });
        const next = {
          ...old,
          [field]: positions,
          [originField]: origins,
          [geometryField]: currentGeometry,
          folderById,
        };
        save(key, next);
        return next;
      });
  }, [built]);
  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const edges: Edge[] = useMemo(
    () =>
      uniqueLinks(p.links)
        .filter(
          (l) =>
            linksDisplay !== "hidden" &&
            (linksDisplay === "all" ||
              l.source_document_id === p.selected ||
              l.document_id === p.selected ||
              (selectedLink && linkKey(selectedLink) === linkKey(l))) &&
            nodeById.has(l.source_document_id) &&
            nodeById.has(l.document_id),
        )
        .map((l) => {
          const highlight =
            l.source_document_id === p.selected ||
            l.document_id === p.selected ||
            (!!selectedLink && linkKey(selectedLink) === linkKey(l));
          return {
            id: linkKey(l),
            source: l.source_document_id,
            target: l.document_id,
            sourceHandle: "out",
            targetHandle: "in",
            label:
              selectedLink && linkKey(selectedLink) === linkKey(l)
                ? l.relation
                : undefined,
            type: "routed",
            data: {
              link: l,
              lane:
                Math.max(
                  ...nodes
                    .filter(
                      (n) =>
                        n.type === "folder" &&
                        [
                          nodeById.get(l.source_document_id)?.parentId,
                          nodeById.get(l.document_id)?.parentId,
                        ].includes(n.id),
                    )
                    .map((n) => n.position.x + Number(n.style?.width || 0)),
                ) + 24,
            },
            style: {
              stroke: highlight ? "var(--accent)" : "var(--link-muted)",
              strokeWidth: highlight ? 1.8 : 1,
              opacity: p.selected && !highlight ? 0.35 : 1,
            },
            labelStyle: { fontSize: 12, fill: "var(--text-secondary)" },
            labelBgStyle: { fill: "var(--surface-subtle)" },
            labelBgPadding: [6, 4] as [number, number],
            markerEnd: ["supports", "contradicts"].includes(l.relation)
              ? { type: MarkerType.ArrowClosed, color: "var(--link-muted)" }
              : undefined,
            zIndex: 3,
            interactionWidth: 24,
          };
        }),
    [p.links, linksDisplay, p.selected, selectedLink, nodes, nodeById],
  );
  function fit(ids?: string[], reading = false) {
    if (!flow || !nodes.length) return;
    const boxes = nodes
      .filter((n) => !ids || ids.includes(n.id))
      .map((n) => {
        const parent = nodeById.get(n.parentId!);
        return {
          x: n.position.x + (parent?.position.x || 0),
          y: n.position.y + (parent?.position.y || 0),
          width: Number(n.style?.width || 264),
          height: Number(n.style?.height || 246),
        };
      });
    if (!boxes.length) return;
    if (ids && ids.length > 1) {
      const parents = new Set(
        nodes.filter((n) => ids.includes(n.id)).map((n) => n.parentId),
      );
      for (const parent of nodes.filter((n) => parents.has(n.id)))
        boxes.push({
          x: parent.position.x,
          y: parent.position.y,
          width: Number(parent.style?.width || 296),
          height: 54,
        });
    }
    if (!ids)
      for (const edge of edges)
        boxes.push({
          x: Number(edge.data?.lane) - 50,
          y: 0,
          width: 100,
          height: 60,
        });
    const x = Math.min(...boxes.map((b) => b.x)),
      y = Math.min(...boxes.map((b) => b.y));
    const bounds = {
      x,
      y,
      width: Math.max(...boxes.map((b) => b.x + b.width)) - x,
      height: Math.max(...boxes.map((b) => b.y + b.height)) - y,
    };
    const surface = surfaceRef.current?.getBoundingClientRect();
    let fittedZoom = surface
      ? Math.min(
          (surface.width - 48) / bounds.width,
          (surface.height - 140) / bounds.height,
        )
      : 1;
    // At marker scale keep the readable group navigation beside the graph,
    // instead of covering the first cards and intercepting their pointer input.
    // A narrow surface has no room beside it: the navigation spans the width.
    const leftInset =
      !reading && (surface?.width ?? 0) >= 720 &&
      fittedZoom < (p.search && overview ? 0.75 : 0.45) ? 360 : 24;
    if (surface && leftInset > 24)
      fittedZoom = Math.min(
        fittedZoom,
        (surface.width - leftInset - 24) / bounds.width,
      );
    const fittedGroups = ids
      ? new Set(nodes.filter((n) => ids.includes(n.id)).map((n) => n.parentId))
          .size
      : built.filter((n) => n.type === "folder").length;
    if (
      !overview &&
      !reading &&
      (!ids || ids.length > 1) &&
      (fittedZoom < 0.8 || fittedGroups > 6)
    ) {
      pendingFit.current = { ids: ids || null };
      setOverview(true);
      return;
    }
    // Fit the entire bounded map even in a short split pane. The separate
    // folder navigation stays readable; selecting a group restores reading scale.
    // Reserve top arrange buttons and bottom toolbar/hint space explicitly.
    const nextZoom = Math.max(reading ? 0.75 : MIN_ZOOM, Math.min(1, fittedZoom));
    if (surface)
      void flow.setViewport(
        {
          x:
            leftInset -
            bounds.x * nextZoom +
            Math.max(
              0,
              (surface.width - leftInset - 24 - bounds.width * nextZoom) / 2,
            ),
          y: 62 - bounds.y * nextZoom,
          zoom: nextZoom,
        },
        { duration: 0 },
      );
  }
  function fitSelection(ids: string[], reading = false) {
    if (overview) {
      pendingFit.current = { ids, reading };
      setOverview(false);
    } else fit(ids, reading);
  }
  focusGroup.current = (ids) => fitSelection(ids, true);
  useEffect(() => {
    if (
      pendingFit.current === undefined ||
      !flow ||
      !nodes.length ||
      nodes.some((n) => n.type === "document" && !!n.data.overview !== overview)
    )
      return;
    const pending = pendingFit.current;
    const revision = fitRevision.current;
    const timer = requestAnimationFrame(() => {
      if (revision !== fitRevision.current || pendingFit.current !== pending)
        return;
      // A redraw may cancel this frame. Keep the request until it executes
      // so selecting a card during a layout update still reaches reading scale.
      pendingFit.current = undefined;
      fit(pending.ids || undefined, pending.reading);
    });
    return () => cancelAnimationFrame(timer);
  }, [nodes, overview, flow]);

  useEffect(() => {
    if (!flow || !nodes.length) return;
    const signature = p.search ? "search:" + p.searchKey : "browse";
    if (fitted.current === signature) return;
    const revision = fitRevision.current;
    const timer = requestAnimationFrame(() => {
      if (revision !== fitRevision.current) return;
      if (latestLayout.current.viewport)
        void flow.setViewport(latestLayout.current.viewport, { duration: 0 });
      else if (p.search) fit(matched);
      else fit();
      fitted.current = signature;
    });
    return () => cancelAnimationFrame(timer);
  }, [flow, nodes, p.search, p.searchKey]);
  useEffect(() => {
    if (layout.overview === overview) return;
    setLayout((old) => {
      const next = { ...old, overview };
      save(key, next);
      return next;
    });
  }, [overview]);
  function storePositions(current: Node[], movedId: string) {
    setLayout((old) => {
      const field = overview ? "overviewPositions" : "positions";
      const positions = { ...old[field] };
      current.forEach((n) => (positions[n.id] = n.position));
      const folderById = { ...old.folderById };
      p.docs.forEach((d) => (folderById[d.document_id] = d.folder || ""));
      const originField = overview
        ? "overviewPositionOrigins"
        : "positionOrigins";
      const origins = { ...old[originField], [movedId]: "manual" as Origin };
      const next = {
        ...old,
        [field]: positions,
        [originField]: origins,
        folderById,
      };
      save(key, next);
      return next;
    });
  }
  return (
    <div
      ref={surfaceRef}
      className={
        "canvas " +
        (overview ? "canvas-overview " : "") +
        (zoom >= 0.75
          ? "zoom-detail"
          : zoom >= 0.45
            ? "zoom-summary"
            : "zoom-markers")
      }
      style={{ "--canvas-zoom": zoom } as import("react").CSSProperties}
      aria-label="Folder canvas"
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onInit={(f) => {
          setFlow(f);
          setZoom(f.getZoom());
        }}
        onNodesChange={(changes) =>
          setNodes((ns) => applyNodeChanges(changes, ns))
        }
        onNodeDragStart={() => {
          draggingNode.current = true;
        }}
        onNodeDragStop={(_, node) => {
          draggingNode.current = false;
          storePositions(
            (flow?.getNodes() || nodes).map((n) =>
              n.id === node.id ? { ...n, position: node.position } : n,
            ),
            node.id,
          );
        }}
        onMove={(_, v) => {
          latestViewport.current = v;
          setZoom((old) =>
            (old >= 0.75 ? 2 : old >= 0.45 ? 1 : 0) ===
            (v.zoom >= 0.75 ? 2 : v.zoom >= 0.45 ? 1 : 0)
              ? old
              : v.zoom,
          );
          surfaceRef.current?.style.setProperty(
            "--canvas-zoom",
            String(v.zoom),
          );
        }}
        onMoveEnd={(_, v) => {
          // React Flow debounces scroll-end by 150ms; a prior viewport's end
          // can arrive after a view switch or a more recent zoom.
          if (
            !mounted.current ||
            (latestViewport.current &&
              (v.x !== latestViewport.current.x ||
                v.y !== latestViewport.current.y ||
                v.zoom !== latestViewport.current.zoom))
          )
            return;
          setZoom(v.zoom);
          setLayout((old) => {
            const next = { ...old, viewport: v };
            save(key, next);
            return next;
          });
        }}
        defaultViewport={layout.viewport || { x: 0, y: 0, zoom: 1 }}
        onNodeClick={(e, n) => {
          if (n.type === "document") p.onSelect(n.data.doc as Doc, e);
        }}
        onNodeDoubleClick={(_, n) => {
          if (n.type === "document") p.onOpen(n.data.doc as Doc);
        }}
        onEdgeClick={(_, e) => setSelectedLink(e.data!.link as Link)}
        nodesConnectable={false}
        edgesReconnectable={false}
        deleteKeyCode={null}
        panOnDrag={pan ? true : [1, 2]}
        panOnScroll
        zoomOnScroll={false}
        zoomActivationKeyCode={["Meta", "Control"]}
        panActivationKeyCode="Space"
        minZoom={MIN_ZOOM}
        maxZoom={2}
        onlyRenderVisibleElements={import.meta.env.VITE_VISIBLE_MAP === "1"}
      >
        <Background gap={20} size={1} color="var(--dot)" />
      </ReactFlow>
      {(zoom < 0.45 || (p.search && overview && zoom < 0.75)) && (
        <nav
          className="canvas-group-summary"
          aria-label="Folder groups at low zoom"
        >
          <strong>
            {nodes.filter((n) => n.type === "folder").length} folder groups ·
            Open a folder to read its documents
          </strong>
          <div>
            {nodes
              .filter((n) => n.type === "folder")
              .map((n) => (
                <button
                  key={n.id}
                  title={String(n.data.path)}
                  onClick={() => (n.data.choose as () => void)()}
                >
                  <Folder size={14} />
                  {String(n.data.name)}
                  <small>
                    {String(n.data.count)}{" "}
                    {p.search
                      ? n.data.count === 1
                        ? "match"
                        : "matches"
                      : n.data.count === 1
                        ? "file"
                        : "files"}
                  </small>
                </button>
              ))}
          </div>
        </nav>
      )}
      {selectedLink && (
        <div className="link-strip" role="status">
          <strong>{selectedLink.relation}</strong>
          <span>
            {selectedLink.source_filename}{" "}
            {["supports", "contradicts"].includes(selectedLink.relation)
              ? "→"
              : "↔"}{" "}
            {selectedLink.target_filename}
          </span>
          <button onClick={() => p.onLink(selectedLink)}>View evidence</button>
          <button
            aria-label="Dismiss connection"
            className="icon"
            onClick={() => setSelectedLink(undefined)}
          >
            ×
          </button>
        </div>
      )}
      {!!legacyFrames.size && (
        <section
          className="canvas-layout-notice"
          role="status"
          aria-label="Saved layout upgrade"
        >
          <strong>Saved map uses older spacing</strong>
          <p>
            Compact cards keep decisions visible. Reflow updates spacing; manual
            placements stay in place. Undo restores this map.
          </p>
          <button
            onClick={() => {
              const previous = { ...layout, previous: undefined };
              const keepManual = (
                map: Record<string, XY> = {},
                origins: Record<string, Origin> = {},
              ) =>
                Object.fromEntries(
                  Object.entries(map).filter(
                    ([id]) => origins[id] === "manual",
                  ),
                );
              const next = {
                ...layout,
                positions: keepManual(layout.positions, layout.positionOrigins),
                overviewPositions: keepManual(
                  layout.overviewPositions,
                  layout.overviewPositionOrigins,
                ),
                previous,
                viewport: undefined,
                overview: false,
              };
              setUndo(previous);
              setOverview(false);
              setLayout(next);
              save(key, next);
              fitted.current = "";
            }}
          >
            Reflow saved layout
          </button>
        </section>
      )}
      <div className="canvas-arrange">
        <button
          aria-pressed={overview}
          onClick={() => {
            const firstFolder = nodes.find((n) => n.type === "folder")?.id;
            pendingFit.current = {
              ids: overview
                ? nodes
                    .filter(
                      (n) =>
                        n.type === "document" && n.parentId === firstFolder,
                    )
                    .slice(0, 3)
                    .map((n) => n.id)
                : null,
              reading: overview,
            };
            setOverview(!overview);
          }}
        >
          {overview ? "Document map" : "Folder overview"}
        </button>
        <select
          aria-label="Connection visibility"
          title="Display only; All shows returned connections, not the entire library graph"
          value={linksDisplay}
          onChange={(e) =>
            setLinksDisplay(e.target.value as "selected" | "all" | "hidden")
          }
        >
          <option value="selected">Links: selected</option>
          <option value="all">All returned links</option>
          <option value="hidden">Links: hidden</option>
        </select>
        <button
          onClick={() => {
            setOverview(false);
            const previous = { ...layout, previous: undefined };
            setUndo(previous);
            const next = {
              ...layout,
              positions: {},
              overviewPositions: {},
              positionOrigins: {},
              overviewPositionOrigins: {},
              previous,
              viewport: undefined,
              overview: false,
            };
            setLayout(next);
            save(key, next);
            fitted.current = "";
          }}
        >
          <SlidersHorizontal size={15} />
          Arrange
        </button>
        {(undo || layout.previous) && (
          <button
            title="Undo arrangement"
            onClick={() => {
              const previous = undo || layout.previous!;
              // A queued Arrange fit must not switch the restored layout back
              // to overview after Undo has restored its detailed positions.
              fitRevision.current += 1;
              pendingFit.current = undefined;
              latestViewport.current = previous.viewport;
              if (previous.viewport)
                void flow?.setViewport(previous.viewport, { duration: 0 });
              setLayout(previous);
              setOverview(previous.overview === true);
              save(key, previous);
              setUndo(undefined);
              fitted.current = previous.viewport
                ? p.search
                  ? "search:" + p.searchKey
                  : "browse"
                : "";
            }}
          >
            <Undo2 size={15} />
            Undo
          </button>
        )}
      </div>
      <div
        className="canvas-toolbar"
        title="Scroll to pan; Space + drag to pan; Cmd/Ctrl + wheel to zoom around pointer"
      >
        <button
          className={pan ? "icon" : "icon active"}
          aria-label="Select tool"
          aria-pressed={!pan}
          onClick={() => setPan(false)}
        >
          <MousePointer2 size={18} />
        </button>
        <button
          className={pan ? "icon active" : "icon"}
          aria-label="Pan tool"
          aria-pressed={pan}
          onClick={() => setPan(true)}
        >
          <Hand size={18} />
        </button>
        <span className="toolbar-divider" />
        <button
          className="icon"
          aria-label="Zoom out"
          onClick={() => void flow?.zoomOut()}
        >
          <Minus size={17} />
        </button>
        <span className="zoom-percent">{Math.round(zoom * 100)}%</span>
        <button
          className="icon"
          aria-label="Zoom in"
          onClick={() => void flow?.zoomIn()}
        >
          <Plus size={17} />
        </button>
        <span className="toolbar-divider" />
        <button title="Fit overview" onClick={() => fit()}>
          Fit
        </button>
        {p.search ? (
          <button onClick={() => fitSelection(matched)}><Scan size={16} aria-hidden="true" /> Fit results</button>
        ) : p.selected ? (
          <button onClick={() => fitSelection([p.selected!])}>
            <Scan size={16} aria-hidden="true" /> Fit selection
          </button>
        ) : null}
      </div>
      <span className="canvas-hint">
        {overview
          ? "Overview · Scroll to browse; open a folder to read · "
          : "Space + drag to pan · "}
        {p.search
          ? `${matched.length} results · ${p.docs.length - matched.length} related context`
          : overview
            ? `${nodes.filter((n) => n.type === "document").length} preview cards · ${p.total} files in this scope`
            : `${nodes.filter((n) => n.type === "document").length} preview cards · ${p.total} files in this scope`}
      </span>
    </div>
  );
}
