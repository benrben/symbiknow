import { useEffect, useLayoutEffect, useRef, useState, useId } from "react";
import { Folder, X, ArrowRight, Minus, Plus, Scan } from "lucide-react";
import { DocumentIcon as FileText, UnfiledIcon as Inbox, ConnectionsIcon as Link2 } from "../../../shared/components/KnowledgeIcons";
import {
  api,
  title,
  location,
  linkKey,
  type Doc,
  type Link,
  type Evidence,
} from "../../../shared/api/client";
import { overviewFolders } from "../../library/presentation";
import {
  currentMapLinks,
  mapGroup,
  mapSample,
  selectedMapLinks,
} from "../presentation";
import Markdown from "../../reader/components/Markdown";

function LinkEvidence(p: {
  link: Link;
  docs: Doc[];
  onOpen: (doc: Doc) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [passages, setPassages] = useState<{
    source: Evidence[];
    target: Evidence[];
  }>();
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const l = p.link;
  useEffect(() => {
    if (!expanded) return;
    const c = new AbortController();
    setError("");
    setPassages(undefined);
    const params = new URLSearchParams({
      id: l.source_document_id,
      version: l.source_version,
      target: l.document_id,
      target_version: l.version,
      source_chunk: l.source_chunk_id,
      target_chunk: l.target_chunk_id,
    });
    api<{ source: Evidence[]; target: Evidence[] }>(
      "link?" + params,
      undefined,
      c.signal,
    )
      .then((r) => {
        if (!c.signal.aborted) setPassages(r);
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(e.message);
      });
    return () => c.abort();
  }, [expanded, retry, l]);
  function open(source: boolean) {
    const id = source ? l.source_document_id : l.document_id;
    const version = source ? l.source_version : l.version;
    p.onOpen({
      ...p.docs.find((d) => d.document_id === id),
      document_id: id,
      version,
      filename: source ? l.source_filename : l.target_filename,
      mime_type:
        p.docs.find((d) => d.document_id === id)?.mime_type ||
        "application/octet-stream",
    });
  }
  return (
    <>
      <dl className="map-link-endpoints">
        <dt>Source</dt>
        <dd>
          <button onClick={() => open(true)}>
            <FileText size={17} />
            <span>
              {l.source_filename}
              <small>{l.source_version}</small>
            </span>
            <ArrowRight size={14} />
          </button>
        </dd>
        <dt>Target</dt>
        <dd>
          <button onClick={() => open(false)}>
            <FileText size={17} />
            <span>
              {l.target_filename}
              <small>{l.version}</small>
            </span>
            <ArrowRight size={14} />
          </button>
        </dd>
        <dt>Relation</dt>
        <dd className="map-relation">
          <Link2 size={16} />
          {l.relation}
        </dd>
      </dl>
      <button
        className="primary map-evidence-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? "Hide source passages" : "Open source passages"}
      </button>
      {expanded && (
        <section
          className="map-source-passages"
          aria-label="Connection source passages"
        >
          {error ? (
            <p role="alert">
              {error}{" "}
              <button onClick={() => setRetry((n) => n + 1)}>
                Retry passages
              </button>
            </p>
          ) : !passages ? (
            <p role="status">Loading recorded evidence…</p>
          ) : (
            (["source", "target"] as const).map((side) => (
              <div key={side}>
                <h3>
                  {side === "source" ? "Source passage" : "Target passage"}
                </h3>
                {passages[side].length ? (
                  passages[side].map((e) => (
                    <article key={e.evidence_id}>
                      <small>{location(e)}</small>
                      <Markdown>{e.text}</Markdown>
                    </article>
                  ))
                ) : (
                  <p>No passage text was returned for this endpoint.</p>
                )}
              </div>
            ))
          )}
        </section>
      )}
    </>
  );
}

export default function ConnectionMap(p: {
  docs: Doc[];
  links: Link[];
  selected?: string;
  selectedLink?: Link;
  scope?: string;
  folders: Record<string, number>;
  total: number;
  loaded: number;
  hasMore: boolean;
  loading: boolean;
  linksLoading: boolean;
  linksError: string;
  onRetryLinks: () => void;
  onLoadMore: () => void;
  onSelect: (d: Doc) => void;
  onOpen: (d: Doc, origin?: HTMLElement) => void;
  onLink: (l?: Link) => void;
  onClear: () => void;
  onFolder: (path: string) => void;
  onFreeform: () => void;
  search?: boolean;
}) {
  const [zoom, setZoom] = useState(1);
  const [query, setQuery] = useState("");
  const [relation, setRelation] = useState("");
  const [connectionLimit, setConnectionLimit] = useState(20);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const mapOrigin = useRef<HTMLButtonElement | null>(null);
  const term = query.trim().toLocaleLowerCase();
  useEffect(() => {
    setConnectionLimit(20);
    setRelation("");
  }, [p.selected]);
  useEffect(() => {
    if (!p.selected) return;
    detailHeading.current?.focus({ preventScroll: true });
  }, [p.selected, p.selectedLink && linkKey(p.selectedLink)]);
  function closeEvidence() {
    p.onClear();
    requestAnimationFrame(() =>
      (mapOrigin.current?.isConnected
        ? mapOrigin.current
        : stage.current
            ?.closest(".connection-map")
            ?.querySelector<HTMLInputElement>("input")
      )?.focus(),
    );
  }

  const [limits, setLimits] = useState<Record<string, number>>({});
  const stage = useRef<HTMLDivElement>(null);
  const [route, setRoute] = useState<{ d: string; x: number; y: number }>();
  const arrow = useId().replace(/:/g, "");
  const selected = p.docs.find((d) => d.document_id === p.selected);
  const validLinks = currentMapLinks(p.docs, p.links);
  const inspected =
    p.selectedLink &&
    p.links.find((l) => linkKey(l) === linkKey(p.selectedLink!));
  const active =
    inspected && validLinks.find((l) => linkKey(l) === linkKey(inspected));
  const totals = new Map(overviewFolders(p.folders, p.scope));
  const grouped = new Map<string, Doc[]>();
  for (const d of p.docs) {
    if (
      term &&
      !`${d.filename} ${d.folder || ""}`.toLocaleLowerCase().includes(term)
    )
      continue;
    const path = mapGroup(d, p.scope);
    if (!grouped.has(path)) grouped.set(path, []);
    grouped.get(path)!.push(d);
  }
  // Empty aggregate groups stay visible so missing pages never look like missing folders.
  if (!term)
    for (const [path] of totals) if (!grouped.has(path)) grouped.set(path, []);
  const groups = [...grouped].sort(
    ([a, ad], [b, bd]) =>
      Number(!ad.length) - Number(!bd.length) ||
      (!a ? 1 : !b ? -1 : a.localeCompare(b)),
  );
  const displayed = groups.map(([path, docs]) => ({
    path,
    docs,
    shown: mapSample(docs, limits[path] || 3, p.selected, active),
  }));
  const visibleIds = new Set(
    displayed.flatMap((g) => g.shown.map((d) => d.document_id)),
  );
  const signature = JSON.stringify([
    displayed.map((g) => [g.path, g.shown.map((d) => d.document_id)]),
    active && linkKey(active),
    zoom,
    !!selected,
  ]);
  useLayoutEffect(() => {
    const el = stage.current;
    if (!el || !active) {
      setRoute(undefined);
      return;
    }
    const measure = () => {
      const nodes = new Map(
        Array.from(el.querySelectorAll<HTMLElement>("[data-map-document]")).map(
          (node) => [node.dataset.mapDocument, node],
        ),
      );
      const a = nodes.get(active.source_document_id),
        b = nodes.get(active.document_id);
      if (!a || !b) {
        setRoute(undefined);
        return;
      }
      const box = el.getBoundingClientRect(),
        ab = a.getBoundingClientRect(),
        bb = b.getBoundingClientRect();
      const sameColumn = Math.abs(ab.left - bb.left) < 10;
      let x1, y1, x2, y2, d;
      if (sameColumn) {
        // Route down the right gutter so intervening file titles remain unobscured.
        x1 = (ab.right - box.left) / zoom;
        y1 = (ab.top + ab.height / 2 - box.top) / zoom;
        x2 = (bb.right - box.left) / zoom;
        y2 = (bb.top + bb.height / 2 - box.top) / zoom;
        const down = ab.top < bb.top;
        const gap = down ? bb.top - ab.bottom : ab.top - bb.bottom;
        if (gap >= 0 && gap < 55 * zoom) {
          const center = (ab.left + ab.width / 2 - box.left) / zoom;
          const start = ((down ? ab.bottom : ab.top) - box.top) / zoom;
          const end = ((down ? bb.top : bb.bottom) - box.top) / zoom;
          d = `M ${center} ${start} V ${end}`;
          setRoute({ d, x: center, y: (start + end) / 2 });
        } else {
          const lane = Math.max(x1, x2) + 13;
          d = `M ${x1} ${y1} H ${lane} V ${y2} H ${x2}`;
          setRoute({ d, x: lane, y: (y1 + y2) / 2 });
        }
      } else {
        const right = ab.left < bb.left;
        x1 = ((right ? ab.right : ab.left) - box.left) / zoom;
        y1 = (ab.top + ab.height / 2 - box.top) / zoom;
        x2 = ((right ? bb.left : bb.right) - box.left) / zoom;
        y2 = (bb.top + bb.height / 2 - box.top) / zoom;
        const middle = (x1 + x2) / 2;
        d = `M ${x1} ${y1} C ${middle} ${y1}, ${middle} ${y2}, ${x2} ${y2}`;
        setRoute({ d, x: middle, y: (y1 + y2) / 2 });
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [signature]);
  const selectedLinks = selected ? selectedMapLinks(selected, p.links) : [];
  return (
    <section className="connection-map" aria-label="Document connection map">
      <header className="map-context-bar">
        <div>
          <strong>
            {p.search
              ? `${p.loaded} search matches loaded`
              : `${p.loaded} of ${p.total} files loaded`}
          </strong>
          <span>
            {p.docs.length > p.loaded
              ? ` · ${p.docs.length - p.loaded} connected files included`
              : ""}
          </span>
          <p>Select a file to explore its recorded connections.</p>
        </div>
        {p.hasMore && (
          <button disabled={p.loading} onClick={p.onLoadMore}>
            {p.loading ? "Loading…" : "Load more"}
          </button>
        )}
        <button className="map-freeform" onClick={p.onFreeform}>
          Freeform map
        </button>
      </header>
      <div className="map-filterbar">
        <label>
          Find loaded files
          <input
            type="search"
            aria-label="Find map files"
            placeholder="File name or folder…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        {query && (
          <button onClick={() => setQuery("")}>Clear map search</button>
        )}
        <span role="status">
          {term
            ? `${[...grouped.values()].reduce((n, docs) => n + docs.length, 0)} loaded files match`
            : "Browse by folder"}
          {term && p.hasMore
            ? " · Load more or use library search for all files"
            : ""}
        </span>
      </div>
      <div className={"map-workspace" + (selected ? " has-map-detail" : "")}>
        <div
          className="map-scroll"
          tabIndex={0}
          aria-label="Scrollable folder clusters"
        >
          <div className="map-stage" ref={stage} style={{ zoom }}>
            <div className="map-clusters">
              {!displayed.length && (
                <div className="map-no-results">
                  <h2>No loaded files match</h2>
                  <p>
                    Try a shorter name or clear this filter.
                    {p.hasMore
                      ? " More files are available using Load more above."
                      : ""}
                  </p>
                  <button onClick={() => setQuery("")}>
                    Show loaded files
                  </button>
                </div>
              )}
              {displayed.map(({ path, docs, shown }) => (
                <section
                  className="map-cluster"
                  key={path}
                  aria-label={`${path || "Unfiled"} map cluster`}
                >
                  <header>
                    {path ? <Folder size={21} /> : <Inbox size={21} />}
                    <div>
                      <h2 title={path}>
                        {path === p.scope && path
                          ? "Files in this folder"
                          : path.split(" / ").at(-1) || "Unfiled"}
                      </h2>
                      <small>
                        {docs.length} {term ? "matching" : "loaded"}
                        {totals.has(path)
                          ? ` · ${totals.get(path)} total`
                          : " · Connected context"}
                      </small>
                    </div>
                    <button
                      className="icon"
                      aria-label={`Browse ${path || "Unfiled"}`}
                      onClick={() => p.onFolder(path)}
                    >
                      <ArrowRight size={16} />
                    </button>
                  </header>
                  <div className="map-node-list">
                    {shown.map((d) => (
                      <button
                        data-map-document={d.document_id}
                        key={d.document_id}
                        title={d.filename}
                        aria-label={`Select map file ${title(d)} ${d.version}`}
                        aria-description={`Saved version ${d.version}`}
                        aria-pressed={d.document_id === p.selected}
                        className={
                          "map-file-node" +
                          (active &&
                          [
                            active.source_document_id,
                            active.document_id,
                          ].includes(d.document_id)
                            ? " linked-endpoint"
                            : "")
                        }
                        onClick={(e) => {
                          mapOrigin.current = e.currentTarget;
                          p.onSelect(d);
                        }}
                        onDoubleClick={() => p.onOpen(d)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                            e.preventDefault();
                            p.onOpen(d);
                          }
                        }}
                      >
                        <FileText size={18} />
                        <span>
                          {title(d).replace(
                            new RegExp(
                              "^" +
                                path
                                  .split(" / ")[0]
                                  .replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
                                "\\s+",
                              "i",
                            ),
                            "",
                          )}
                          <small aria-hidden="true"> {d.version}</small>
                        </span>
                      </button>
                    ))}
                  </div>
                  {!docs.length && (
                    <p className="map-empty-group">
                      Files in this folder are not loaded yet.
                      <button onClick={() => p.onFolder(path)}>
                        Open folder
                      </button>
                    </p>
                  )}
                  <footer>
                    <span>
                      {shown.length} of {docs.length}{" "}
                      {term ? "matching" : "loaded"} files shown
                    </span>
                    {docs.length > shown.length && (
                      <button
                        onClick={() =>
                          setLimits((old) => ({
                            ...old,
                            [path]: (old[path] || 3) + 3,
                          }))
                        }
                      >
                        Show more
                      </button>
                    )}
                    {shown.length > 3 && (
                      <button
                        onClick={() =>
                          setLimits((old) => ({ ...old, [path]: 3 }))
                        }
                      >
                        Show fewer
                      </button>
                    )}
                  </footer>
                </section>
              ))}
            </div>
            {active && route && (
              <svg className="map-connection-line" aria-hidden="true">
                <defs>
                  <marker
                    id={arrow}
                    markerWidth="8"
                    markerHeight="8"
                    refX="7"
                    refY="4"
                    orient="auto"
                  >
                    <path d="M0,0 L8,4 L0,8" fill="var(--accent)" />
                  </marker>
                </defs>
                <path
                  d={route.d}
                  fill="none"
                  stroke="var(--accent)"
                  strokeWidth="2"
                  markerEnd={
                    ["supports", "contradicts"].includes(active.relation)
                      ? `url(#${arrow})`
                      : undefined
                  }
                />
                <g transform={`translate(${route.x}, ${route.y})`}>
                  <rect
                    x={-Math.max(30, active.relation.length * 3.7)}
                    y={-9}
                    width={Math.max(60, active.relation.length * 7.4)}
                    height={18}
                    rx={8}
                    fill="var(--selection)"
                  />
                  <text
                    textAnchor="middle"
                    dominantBaseline="central"
                    fill="var(--accent)"
                    fontSize={10}
                  >
                    {active.relation}
                  </text>
                </g>
              </svg>
            )}
          </div>
        </div>
        {selected && (
          <aside
            className="map-detail"
            aria-label="Connection evidence"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                closeEvidence();
              }
            }}
          >
            <header>
              <h2 ref={detailHeading} tabIndex={-1}>
                {inspected
                  ? "Why these files are connected"
                  : "File connections"}
              </h2>
              <button
                className="icon"
                aria-label="Close connection evidence"
                onClick={closeEvidence}
              >
                <X size={17} />
              </button>
            </header>
            {inspected ? (
              <>
                <p className="selected-relation">
                  {inspected.relation}
                  {!active ||
                  !visibleIds.has(inspected.source_document_id) ||
                  !visibleIds.has(inspected.document_id)
                    ? " · Endpoint version outside the visible map"
                    : ""}
                </p>
                <LinkEvidence
                  key={linkKey(inspected)}
                  link={inspected}
                  docs={p.docs}
                  onOpen={p.onOpen}
                />
                <button
                  className="map-back-links"
                  onClick={() => p.onLink(undefined)}
                >
                  ← All connections for this file
                </button>
              </>
            ) : (
              <>
                <h3>{title(selected)}</h3>
                <button
                  className="map-read-file"
                  onClick={(event) => p.onOpen(selected, event.currentTarget)}
                >
                  <FileText size={16} />
                  Read document
                </button>
                {p.linksLoading ? (
                  <p role="status">Loading connections…</p>
                ) : p.linksError ? (
                  <p role="alert">
                    Connections unavailable.{" "}
                    <button onClick={p.onRetryLinks}>Retry</button>
                  </p>
                ) : (
                  <>
                    <p className="secondary">
                      {selectedLinks.length} recorded{" "}
                      {selectedLinks.length === 1
                        ? "connection"
                        : "connections"}{" "}
                      returned for {selected.version}.
                    </p>
                    {selectedLinks.length > 0 && (
                      <label className="map-relation-filter">
                        Connection type
                        <select
                          aria-label="Filter connection type"
                          value={relation}
                          onChange={(e) => {
                            setRelation(e.target.value);
                            setConnectionLimit(20);
                          }}
                        >
                          <option value="">All types</option>
                          {[...new Set(selectedLinks.map((l) => l.relation))]
                            .sort()
                            .map((type) => (
                              <option key={type}>{type}</option>
                            ))}
                        </select>
                      </label>
                    )}
                    {selectedLinks
                      .filter((l) => !relation || l.relation === relation)
                      .slice(0, connectionLimit)
                      .map((l) => (
                        <button
                          className="map-link-option"
                          key={linkKey(l)}
                          onClick={() => p.onLink(l)}
                        >
                          <Link2 size={16} />
                          <span>
                            {l.source_document_id === selected.document_id
                              ? l.target_filename
                              : l.source_filename}
                            <small>
                              {l.relation} · {l.source_version} / {l.version}
                            </small>
                          </span>
                        </button>
                      ))}
                    {selectedLinks.filter(
                      (l) => !relation || l.relation === relation,
                    ).length > connectionLimit && (
                      <button onClick={() => setConnectionLimit((n) => n + 20)}>
                        Show 20 more connections
                      </button>
                    )}
                    {!selectedLinks.length && (
                      <p className="secondary">
                        No current connections were returned. This does not mean
                        the file has no related content.
                      </p>
                    )}
                  </>
                )}
              </>
            )}
          </aside>
        )}
      </div>
      <footer className="map-footer">
        <span>
          {active
            ? "Selected connection shown with recorded endpoint versions."
            : "Connections load for the selected file; this is not a complete library graph."}
        </span>
        <div className="map-zoom">
          <button
            className="icon"
            aria-label="Zoom map out"
            disabled={zoom <= 0.85}
            onClick={() =>
              setZoom((v) => Math.max(0.85, Math.round((v - 0.1) * 100) / 100))
            }
          >
            <Minus size={16} />
          </button>
          <output aria-label="Map zoom">{Math.round(zoom * 100)}%</output>
          <button
            className="icon"
            aria-label="Zoom map in"
            disabled={zoom >= 1.4}
            onClick={() =>
              setZoom((v) => Math.min(1.4, Math.round((v + 0.1) * 100) / 100))
            }
          >
            <Plus size={16} />
          </button>
          <button onClick={() => setZoom(1)}>
            <Scan size={15} />
            Fit columns
          </button>
        </div>
      </footer>
    </section>
  );
}
