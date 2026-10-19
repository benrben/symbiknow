import { useEffect, useState, useRef, useId } from "react";
import * as Tabs from "@radix-ui/react-tabs";
import * as Menu from "@radix-ui/react-dropdown-menu";
import * as Dialog from "@radix-ui/react-dialog";
import Markdown from "./MarkdownRenderer";
import ReaderTools from "./ReaderTools";
import PdfPreview from "./PdfPreview";
import { useAppearance } from "../appearance";
import DOMPurify from "dompurify";
import { ArrowLeft, Info, X, Download, ExternalLink, MoreHorizontal, ChevronRight, Maximize2, Minimize2 } from "lucide-react";
import { VersionsIcon, EvidenceIcon, DocumentIcon as FileText, ConnectionsIcon as Link2 } from "./KnowledgeIcons";
import {
  api,
  title,
  kind,
  fileUrl,
  location,
  indexingLabel,
  linkKey,
  type Doc,
  type Detail,
  type Link,
  type Evidence,
  type CardPreview,
} from "../api";
import { contextualTitle } from "../browsePresentation";
import { searchEvidence, passagePreview } from "../searchEvidence";
import { Judgment } from "./FileList";
export function Preview({
  doc,
  highlights = [],
  libraryId,
}: {
  doc: Doc;
  highlights?: string[];
  libraryId?: string;
}) {
  const [text, setText] = useState("");
  const proseRef = useRef<HTMLDivElement>(null);
  const outlineId = useId();
  const [headings, setHeadings] = useState<
    { id: string; text: string; level: number }[]
  >([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [table, setTable] = useState<string[][]>();
  const { theme } = useAppearance();
  const k = kind(doc);
  useEffect(() => {
    setText("");
    setTable(undefined);
    setError("");
    setLoading(true);
    const c = new AbortController();
    if (["Text", "Markdown", "HTML"].includes(k)) {
      if ((doc.size || 0) > 2 * 1024 * 1024) {
        setError(
          "This text file is too large for an inline preview. Download the original to read it.",
        );
        setLoading(false);
        return;
      }
      fetch(fileUrl(doc), { signal: c.signal })
        .then((r) => {
          if (!r.ok) throw new Error("Preview unavailable");
          return r.text();
        })
        .then(setText)
        .catch((e) => {
          if (e.name !== "AbortError") setError(e.message);
        })
        .finally(() => {
          if (!c.signal.aborted) setLoading(false);
        });
    } else if (k === "CSV" || k === "Word") {
      api<CardPreview>(
        `card?id=${encodeURIComponent(doc.document_id)}&version=${encodeURIComponent(doc.version)}`,
        undefined,
        c.signal,
      )
        .then((result) => {
          if (c.signal.aborted) return;
          setTable(result.table);
          setText(result.evidence.map((e) => e.text).join("\n\n"));
        })
        .catch((e) => {
          if (!c.signal.aborted) setError(e.message);
        })
        .finally(() => {
          if (!c.signal.aborted) setLoading(false);
        });
    } else setLoading(false);
    return () => c.abort();
  }, [doc.document_id, doc.version, k, doc.size]);
  useEffect(() => {
    const root = proseRef.current;
    if (!root || loading || error || k !== "Markdown") {
      setHeadings([]);
      return;
    }
    const nodes = Array.from(
      root.querySelectorAll<HTMLElement>("h1,h2,h3,h4"),
    ).slice(0, 80);
    setHeadings(
      nodes.map((node, index) => {
        const id = `${outlineId}-section-${index}`;
        node.id = id;
        node.tabIndex = -1;
        return {
          id,
          text: node.textContent || "Section",
          level: Number(node.tagName.slice(1)),
        };
      }),
    );
  }, [text, loading, error, k, outlineId]);
  if (error && k !== "PDF")
    return (
      <p role="status">
        {error} Metadata, history and download remain available.
        <a href={fileUrl(doc, true)}>Download original</a>
      </p>
    );
  if (loading)
    return (
      <p className="secondary" role="status">
        Loading preview…
      </p>
    );
  if (k === "Image")
    return (
      <img
        className="image-preview"
        src={fileUrl(doc)}
        alt={doc.filename}
        onError={() => setError("Image preview failed.")}
      />
    );
  if (k === "PDF")
    return <PdfPreview key={doc.document_id + ":" + doc.version} doc={doc} />;
  if (k === "HTML")
    return (
      <iframe
        className="html-preview"
        title={doc.filename}
        sandbox=""
        srcDoc={
          '<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; style-src &#39;unsafe-inline&#39;; img-src data:; form-action &#39;none&#39;; base-uri &#39;none&#39;">' +
          `<style>:root{color-scheme:${theme}}body{margin:0;padding:8px;font:15px/23px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;color:${theme === "dark" ? "#eceef2" : "#252932"};background:${theme === "dark" ? "#202124" : "#ffffff"};overflow-wrap:anywhere}h1,h2,h3{font-size:16px;line-height:22px}pre,table{display:block;max-width:100%;overflow:auto}pre{white-space:pre;font-size:13px}</style>` +
          DOMPurify.sanitize(text, {
            FORBID_TAGS: [
              "script",
              "iframe",
              "object",
              "embed",
              "meta",
              "base",
              "link",
              "form",
              "input",
              "button",
              "textarea",
              "select",
              "style",
              "svg",
              "math",
            ],
            FORBID_ATTR: [
              "href",
              "src",
              "srcset",
              "action",
              "formaction",
              "xlink:href",
              "poster",
              "background",
              "style",
            ],
          })
        }
      />
    );
  if (k === "Markdown")
    return (
      <div className="document-text-preview">
        <ReaderTools
          content={proseRef}
          ready={!loading}
          identity={doc.document_id + ":" + doc.version}
          libraryId={libraryId}
        />
        {headings.length > 0 && (
          <label className="document-outline">
            On this page
            <select
              aria-label="On this page"
              value=""
              onChange={(e) => {
                const node = document.getElementById(e.target.value);
                node?.scrollIntoView({ block: "start", behavior: "auto" });
                node?.focus({ preventScroll: true });
              }}
            >
              <option value="">Jump to section…</option>
              {headings.map((h) => (
                <option key={h.id} value={h.id}>
                  {" ".repeat(Math.max(0, h.level - 1))}
                  {h.text}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="prose" ref={proseRef}>
          <Markdown
            highlights={highlights}
            components={{
              p: ({ children }) => {
                const text = typeof children === "string" ? children : "";
                return (
                  <p>
                    {text.length > 12 &&
                    highlights.some((e) => e.includes(text)) ? (
                      <mark>{children}</mark>
                    ) : (
                      children
                    )}
                  </p>
                );
              },
              img: () => null,
              a: ({ children }) => <span>{children}</span>,
            }}
          >
            {text}
          </Markdown>
        </div>
      </div>
    );
  if (k === "Text")
    return (
      <div className="document-text-preview">
        <ReaderTools
          content={proseRef}
          ready={!loading}
          identity={doc.document_id + ":" + doc.version}
          libraryId={libraryId}
        />
        <div ref={proseRef}>
          <pre className="text-preview">{text}</pre>
        </div>
      </div>
    );
  if (table?.length)
    return (
      <div className="preview-table-wrap">
        <p className="extracted-preview-label">
          Preview · first {table.length - 1} data rows · up to 6 columns
        </p>
        <table className="card-table">
          <tbody>
            {table.map((row, i) => (
              <tr key={i}>
                {row.map((cell, n) =>
                  i === 0 ? <th key={n}>{cell}</th> : <td key={n}>{cell}</td>,
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  if (k === "Word" && text)
    return (
      <div className="prose">
        <p className="extracted-preview-label">
          Extracted content preview · download for original formatting
        </p>
        <Markdown
          components={{
            img: () => null,
            a: ({ children }) => <span>{children}</span>,
          }}
        >
          {text}
        </Markdown>
      </div>
    );
  return (
    <p className="secondary">
      This format has no browser preview. Your original file is stored and
      available to download.
    </p>
  );
}
export function EvidencePassage({
  e,
  highlight = false,
}: {
  e: Evidence;
  highlight?: boolean;
}) {
  return (
    <div className="passage" id={"evidence-" + e.evidence_id}>
      <a href={"#evidence-" + e.evidence_id}>{location(e)}</a>
      <small>
        {e.basis === "ocr"
          ? "OCR evidence"
          : e.basis === "visual"
            ? "Visual evidence"
            : "Text evidence"}
      </small>
      {e.text && (
        <p>
          {highlight ? (
            <mark>{passagePreview(e, 900)}</mark>
          ) : (
            passagePreview(e, 900)
          )}
        </p>
      )}
      {e.text.length > 900 && (
        <details>
          <summary>View complete evaluated passage</summary>
          <pre className="complete-passage">{e.text}</pre>
        </details>
      )}
    </div>
  );
}
export default function DocumentInspector(p: {
  libraryId?: string;
  doc: Doc;
  hidden?: boolean;
  expanded?: boolean;
  onExpand?: () => void;
  initialTab?: string;
  evidenceNavigation?: {
    sequence: number;
    document_id: string;
    version: string;
  };
  onVersion: (v: string) => void;
  onMove: (d: Doc) => void;
  busy: boolean;
  refreshKey?: string;
  match?: Doc;
  evaluate: boolean;
  unavailable: boolean;
  onClose: () => void;
  onSelect: (d: Doc) => void;
  onUpdate: (d: Doc) => void;
  onDelete: (d: Doc) => void;
  open: boolean;
  onOpen: (v: boolean) => void;
  onPreviewClose: () => void;
  link?: Link;
  visibleIds?: string[];
  onLink: (l: Link) => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const readingContent = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!p.expanded || p.hidden) return;
    const frame = requestAnimationFrame(() => closeRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [p.doc.document_id, p.doc.version, p.expanded, p.hidden]);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    // Keep row/card focus available for range selection and keyboard browsing.
  }, [p.doc.document_id]);
  const [detail, setDetail] = useState<Detail>();
  const [version, setVersion] = useState(p.doc.version);
  const [tab, setTab] = useState("preview");
  const [history, setHistory] = useState<{
    versions: Doc[];
    has_more: boolean;
    head: string;
  }>();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyBusy, setHistoryBusy] = useState(false);
  const historyGeneration = useRef(0);
  useEffect(() => {
    historyGeneration.current++;
    setHistory(undefined);
    setHistoryOpen(false);
    setHistoryBusy(false);
  }, [p.doc.document_id, p.refreshKey]);
  const priorVersion = useRef({
    id: p.doc.document_id,
    version: p.doc.version,
  });
  useEffect(() => {
    if (
      priorVersion.current.id === p.doc.document_id &&
      priorVersion.current.version !== p.doc.version
    )
      setHistoryOpen(true);
    priorVersion.current = { id: p.doc.document_id, version: p.doc.version };
  }, [p.doc.document_id, p.doc.version]);
  async function loadHistory(more = false) {
    if (historyBusy) return;
    setHistoryBusy(true);
    const identity = p.doc.document_id;
    const generation = historyGeneration.current;
    try {
      const result = await api<{
        versions: Doc[];
        has_more: boolean;
        head: string;
      }>(
        `history?id=${encodeURIComponent(identity)}&offset=${more ? history?.versions.length || 0 : 0}${more && history ? "&head=" + history.head : ""}`,
      );
      if (generation !== historyGeneration.current) return;
      setHistory((old) => ({
        ...result,
        versions: more
          ? [...(old?.versions || []), ...result.versions]
          : result.versions,
      }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      if (generation === historyGeneration.current) setHistoryBusy(false);
    }
  }
  useEffect(() => {
    if ((tab === "history" || historyOpen) && !history) void loadHistory();
  }, [tab, historyOpen, history]);
  const [error, setError] = useState("");
  const [linkDetail, setLinkDetail] = useState<{
    source: Evidence[];
    target: Evidence[];
    link: Link;
  }>();
  const [linkError, setLinkError] = useState("");
  useEffect(() => {
    setVersion(p.doc.version);
  }, [p.doc.document_id, p.doc.version]);
  useEffect(
    () => setTab(p.initialTab || "preview"),
    [p.doc.document_id, p.initialTab],
  );
  useEffect(() => {
    const request = p.evidenceNavigation;
    if (
      request?.document_id === p.doc.document_id &&
      request.version === p.match?.version
    ) {
      setVersion(request.version);
      setTab("evidence");
    }
  }, [p.evidenceNavigation?.sequence]);
  useEffect(() => {
    const c = new AbortController();
    setDetail((old) =>
      old?.document.document_id === p.doc.document_id &&
      old.document.version === version
        ? old
        : undefined,
    );
    setError("");
    api<Detail>(
      "document?id=" +
        p.doc.document_id +
        "&version=" +
        version +
        "&section=" +
        (["details", "connections", "evidence"].includes(tab)
          ? "details"
          : "summary"),
      undefined,
      c.signal,
    )
      .then((r) => {
        if (!c.signal.aborted) {
          setDetail(r);
          // Older compatible servers may already include the version list.
          if (r.versions.length > 1)
            setHistory({
              versions: [...r.versions].reverse(),
              has_more: false,
              head: r.current_version,
            });
        }
      })
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => c.abort();
  }, [
    p.doc.document_id,
    version,
    p.refreshKey,
    retry,
    ["details", "connections", "evidence"].includes(tab),
  ]);
  useEffect(() => {
    setLinkDetail(undefined);
    setLinkError("");
    if (!p.link) return;
    setTab("connections");
    const l = p.link,
      c = new AbortController();
    api<{ source: Evidence[]; target: Evidence[]; link: Link }>(
      `link?id=${l.source_document_id}&version=${l.source_version}&target=${l.document_id}&target_version=${l.version}&source_chunk=${encodeURIComponent(l.source_chunk_id)}&target_chunk=${encodeURIComponent(l.target_chunk_id)}`,
      undefined,
      c.signal,
    )
      .then(setLinkDetail)
      .catch((e) => {
        if (e.name !== "AbortError") setLinkError(e.message);
      });
    return () => c.abort();
  }, [p.link]);
  const doc =
    detail?.document.document_id === p.doc.document_id &&
    detail.document.version === version
      ? detail.document
      : { ...p.doc, version };
  const historical = detail && version !== detail.current_version;
  const matched =
    p.match?.document_id === doc.document_id &&
    p.match?.version === version &&
    !historical
      ? p.match
      : undefined;
  const rows = matched ? searchEvidence(matched, p.evaluate) : [];
  const evidenceRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (tab === "evidence" && matched && detail) {
      const frame = requestAnimationFrame(() => evidenceRef.current?.focus());
      return () => cancelAnimationFrame(frame);
    }
    if (!matched && tab === "evidence") setTab("preview");
  }, [tab, matched, detail]);
  return (
    <aside
      tabIndex={-1}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
          const field = e.currentTarget.querySelector<HTMLInputElement>(
            '[aria-label="Find in document"]',
          );
          if (field) {
            e.preventDefault();
            field.focus();
            field.select();
          }
        }
      }}
      className={"inspector" + (p.hidden ? " hidden" : "")}
      aria-label={p.hidden ? undefined : "Document inspector"}
      aria-hidden={p.hidden || undefined}
    >
      <div className="inspector-heading">
        <div>
          <h2 title={doc.filename}>
            {contextualTitle(
              doc.filename,
              detail?.organization?.folder || p.doc.folder,
            )}
          </h2>
          <p className="secondary">
            {historical
              ? "Historical version"
              : (detail ? detail.organization?.folder : p.doc.folder) ||
                "Unfiled"}{" "}
          </p>
        </div>
        <button
          className="reader-expand"
          aria-label={p.expanded ? "Split view" : "Expand reader"}
          title={p.expanded ? "Split view" : "Expand reader"}
          onClick={p.onExpand}
        >
          {p.expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          <span>{p.expanded ? "Split view" : "Expand reader"}</span>
        </button>
        <button
          ref={closeRef}
          className={
            p.expanded ? "reader-back close-inspector" : "icon close-inspector"
          }
          aria-label={p.expanded ? "Back to library" : "Close inspector"}
          onClick={() => {
            setTab("preview");
            p.onClose();
          }}
        >
          {p.expanded ? <><ArrowLeft size={16} /> Back to library</> : <X size={20} />}
        </button>
      </div>
      <div className="inspector-meta">
        <span title={doc.filename}>
          {kind(doc)} · {version}
          {doc.created_at
            ? " · Saved " + new Date(doc.created_at).toLocaleDateString()
            : ""}
        </span>
        <Menu.Root>
          <Menu.Trigger asChild>
            <button className="icon" aria-label="Document actions">
              <MoreHorizontal />
            </button>
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Content className="menu" align="end">
              <Menu.Item
                onSelect={() =>
                  p.onUpdate({
                    ...p.doc,
                    version: detail?.current_version || p.doc.version,
                  })
                }
              >
                Update file…
              </Menu.Item>
              <Menu.Item
                disabled={p.busy || !!historical}
                onSelect={() =>
                  p.onMove({
                    ...p.doc,
                    version: detail?.current_version || p.doc.version,
                  })
                }
              >
                Move to…
              </Menu.Item>
              <Menu.Item onSelect={() => setTab("history")}>
                View versions
              </Menu.Item>
              <Menu.Item
                disabled={p.busy}
                onSelect={() =>
                  p.onDelete({
                    ...p.doc,
                    version: detail?.current_version || p.doc.version,
                  })
                }
              >
                Delete document…
              </Menu.Item>
            </Menu.Content>
          </Menu.Portal>
        </Menu.Root>
      </div>
      <Tabs.Root value={tab} onValueChange={setTab}>
        <Tabs.List className="tabs" aria-label="Document tabs">
          {[
            "preview",
            ...(matched ? ["evidence"] : []),
            "history",
            "connections",
            "details",
          ].map((t) => (
            <Tabs.Trigger key={t} value={t}>
              {t === "history" ? <VersionsIcon size={16} />
                : t === "preview" ? <FileText size={16} />
                : t === "evidence" ? <EvidenceIcon size={16} />
                : t === "connections" ? <Link2 size={16} />
                : <Info className="tab-icon" size={16} aria-hidden="true" />}
              {t === "history"
                ? "Versions"
                : t === "preview"
                  ? "Document"
                  : t === "evidence"
                    ? "Evidence"
                    : t === "connections"
                      ? "Connections"
                      : "Details"}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        <div className="inspector-content" ref={readingContent}>
          {error ? (
            <div role="alert">
              {error}
              <button onClick={() => setRetry((n) => n + 1)}>
                Retry preview
              </button>
            </div>
          ) : !detail ? (
            <p role="status">Loading document…</p>
          ) : (
            <>
              <Tabs.Content value="preview">
                {matched && (
                  <section
                    className="search-context"
                    aria-label="Search context"
                  >
                    <Judgment
                      doc={matched}
                      evaluate={p.evaluate}
                      unavailable={p.unavailable}
                    />
                    <small>
                      {version} ·{" "}
                      {rows.filter((r) => r.priority < 3).length
                        ? "Evaluated evidence available"
                        : "Retrieved passages"}
                    </small>
                    {p.evaluate &&
                      matched.jev?.cross_document_assessment_status ===
                        "unavailable" && (
                        <small>
                          Supporting passages retained · Source comparison
                          unavailable
                        </small>
                      )}
                    <details className="result-explanation">
                      <summary>Why this result?</summary>
                      <p>
                        {p.evaluate &&
                        matched.jev?.status === "evaluated" &&
                        matched.jev.explanation
                          ? matched.jev.explanation
                          : `Search returned ${rows.length} passage${rows.length === 1 ? "" : "s"} from this saved version. Open Evidence to inspect the matching text and its source location.`}
                      </p>
                    </details>
                    <button onClick={() => setTab("evidence")}>
                      View evidence
                    </button>
                  </section>
                )}
                <Preview
                  key={doc.document_id + ":" + doc.version}
                  libraryId={p.libraryId}
                  doc={doc}
                  highlights={
                    p.evaluate && !historical
                      ? matched?.evidence
                          ?.filter((e) =>
                            matched.jev?.supporting_chunk_ids?.includes(
                              e.evidence_id,
                            ),
                          )
                          .map((e) => e.text)
                      : []
                  }
                />
                {historical && (
                  <p className="notice">
                    Original {version}. Current organization and links are shown
                    only for the latest version.
                    <button
                      onClick={() => {
                        setVersion(detail.current_version);
                        p.onVersion(detail.current_version);
                      }}
                    >
                      Back to current version
                    </button>
                  </p>
                )}
                {!historical && !!detail.connections.length && (
                  <section className="connected-files">
                    <h3>Related documents</h3>
                    {detail.connections.slice(0, 5).map((l) => (
                      <button key={linkKey(l)} onClick={() => p.onLink(l)}>
                        <FileText size={22} />
                        <span>
                          <strong>
                            {(l.source_document_id === doc.document_id
                              ? l.target_filename
                              : l.source_filename
                            ).replace(/\.[^.]+$/, "")}
                          </strong>
                          <small>
                            {l.relation}
                            {["supports", "contradicts"].includes(l.relation)
                              ? l.source_document_id === doc.document_id
                                ? " · Outgoing"
                                : " · Incoming"
                              : ""}
                          </small>
                        </span>
                        <ChevronRight size={16} />
                      </button>
                    ))}
                    <button
                      className="link-button"
                      onClick={() => setTab("connections")}
                    >
                      Why linked?
                    </button>
                  </section>
                )}
              </Tabs.Content>
              <Tabs.Content value="evidence">
                {matched && (
                  <section
                    className="why-file"
                    ref={evidenceRef}
                    tabIndex={-1}
                    aria-label="Search evidence"
                  >
                    <h3>
                      <FileText size={20} />
                      Why this file? · {version}
                    </h3>
                    <Judgment
                      doc={matched}
                      evaluate={p.evaluate}
                      unavailable={p.unavailable}
                    />
                    <p className="secondary">
                      {p.evaluate && matched.jev?.status === "evaluated"
                        ? matched.jev.explanation
                        : "Retrieved passages from this version. Answer checking is off or unavailable."}
                    </p>
                    {p.evaluate &&
                      matched.jev?.cross_document_assessment_status ===
                        "unavailable" && (
                        <p className="secondary">
                          Source comparison unavailable; accepted local support
                          does not establish agreement across documents.
                        </p>
                      )}
                    {rows
                      .filter((r, i) => r.priority < 3 || i === 0)
                      .map((r) => (
                        <section key={r.evidence.evidence_id}>
                          <h4>
                            {r.role} · {version} · {location(r.evidence)}
                          </h4>
                          <EvidencePassage
                            e={r.evidence}
                            highlight={r.priority === 0}
                          />
                        </section>
                      ))}
                    {rows.filter((r, i) => r.priority === 3 && i > 0).length >
                      0 && (
                      <details>
                        <summary>Other retrieved passages</summary>
                        {rows
                          .filter((r, i) => r.priority === 3 && i > 0)
                          .map((r) => (
                            <EvidencePassage
                              key={r.evidence.evidence_id}
                              e={r.evidence}
                            />
                          ))}
                      </details>
                    )}
                    <button onClick={() => setTab("preview")}>
                      Return to original
                    </button>
                  </section>
                )}
              </Tabs.Content>
              <Tabs.Content value="history">
                <h3>Every saved version</h3>
                <p className="secondary">
                  Choose a version to pin preview and download.
                </p>
                {(history?.versions || [doc]).map((v) => (
                  <button
                    className={
                      "version-row " + (version === v.version ? "selected" : "")
                    }
                    key={v.version}
                    onClick={() => {
                      setVersion(v.version);
                      p.onVersion(v.version);
                      setTab("preview");
                    }}
                  >
                    <strong>
                      {v.version}
                      {v.version === detail.current_version ? " · Current" : ""}
                    </strong>
                    <span>{new Date(v.created_at || "").toLocaleString()}</span>
                    <small>
                      {v.filename} · {v.size?.toLocaleString()} bytes
                    </small>
                  </button>
                ))}
                {history?.has_more && (
                  <button
                    disabled={historyBusy}
                    onClick={() => void loadHistory(true)}
                  >
                    Load older versions
                  </button>
                )}
              </Tabs.Content>
              <Tabs.Content value="details">
                <h3>File details</h3>
                {detail.indexing_error && (
                  <p className="secondary">{detail.indexing_error}</p>
                )}
                {detail.organization?.status === "failed" && (
                  <button
                    onClick={() =>
                      void api("retry-index", {
                        document_id: doc.document_id,
                        expected_version: doc.version,
                      }).then(() => setRetry((n) => n + 1))
                    }
                  >
                    Retry indexing
                  </button>
                )}
                <dl className="document-details">
                  <dt>Original filename</dt>
                  <dd>{doc.filename}</dd>
                  <dt>Type</dt>
                  <dd>{doc.mime_type}</dd>
                  <dt>Size</dt>
                  <dd>{doc.size?.toLocaleString() ?? "—"} bytes</dd>
                  <dt>Version</dt>
                  <dd>
                    {version}
                    {historical ? " · Historical" : " · Current"}
                  </dd>
                  <dt>Saved</dt>
                  <dd>
                    {doc.created_at
                      ? new Date(doc.created_at).toLocaleString()
                      : "—"}
                  </dd>
                  {!historical && (
                    <>
                      <dt>Folder</dt>
                      <dd>{detail.organization?.folder || "Unfiled"}</dd>
                      <dt>Groups</dt>
                      <dd>{detail.organization?.groups?.join(", ") || "—"}</dd>
                    </>
                  )}
                  <dt>Processing</dt>
                  <dd>
                    {historical
                      ? "Historical original"
                      : indexingLabel(detail.organization?.status)}
                  </dd>
                  <dt>Organization</dt>
                  <dd>
                    {historical
                      ? "Organization not recorded for this historical version"
                      : detail.organization_review?.origin === "manual"
                        ? "Manual correction"
                        : detail.organization?.organization_status ===
                            "not_evaluated"
                          ? "Jev needs extracted text"
                          : detail.organization?.organization_status ===
                              "evaluated"
                            ? "Reviewed"
                            : detail.organization?.organization_status ||
                              "Pending"}
                  </dd>
                </dl>
                {!historical && (
                  <details className="why-here">
                    <summary>Why this folder?</summary>
                    <p className="secondary">
                      {detail.organization_review?.origin === "manual"
                        ? "The folder was assigned manually. Routine indexing preserves this correction."
                        : typeof detail.organization_review
                              ?.organization_reason === "string"
                          ? detail.organization_review.organization_reason
                          : detail.organization_review?.evidence_ids
                            ? "Jev selected this folder from content candidates using the passages below."
                            : "No assignment passage IDs were recorded for this older organization result. Current extracted passages are shown for reference."}
                    </p>
                    {typeof detail.organization_review?.project_scope ===
                      "string" && (
                      <p>
                        Project scope:{" "}
                        {detail.organization_review.project_scope ||
                          "Unspecified"}
                      </p>
                    )}
                    {detail.evidence
                      .filter(
                        (e) =>
                          !Array.isArray(
                            detail.organization_review?.evidence_ids,
                          ) ||
                          detail.organization_review.evidence_ids.includes(
                            e.evidence_id,
                          ),
                      )
                      .slice(0, 3)
                      .map((e) => (
                        <EvidencePassage key={e.evidence_id} e={e} />
                      ))}
                  </details>
                )}
              </Tabs.Content>
              <Tabs.Content value="connections">
                <h3>Document connections</h3>
                {historical ? (
                  <p className="secondary">
                    Current links are not historical evidence. Preview or
                    download this saved version.
                  </p>
                ) : (
                  <>
                    {!detail.connections.length && (
                      <p className="secondary">
                        No validated connections for this version.
                      </p>
                    )}
                    {detail.connections.map((l) => (
                      <button
                        className="connection-row"
                        key={linkKey(l)}
                        onClick={() => p.onLink(l)}
                      >
                        <Link2 size={18} />
                        <span>
                          <strong>
                            {l.source_filename}{" "}
                            {["supports", "contradicts"].includes(l.relation)
                              ? "→"
                              : "↔"}{" "}
                            {l.target_filename}
                          </strong>
                          <small>
                            {l.relation} · {l.source_version} / {l.version}
                          </small>
                        </span>
                      </button>
                    ))}
                    {p.link && (
                      <section className="link-evidence">
                        <h3>
                          {p.link.relation[0].toUpperCase() +
                            p.link.relation.slice(1)}
                        </h3>
                        <p className="secondary">
                          {p.link.source_filename} ({p.link.source_version}){" "}
                          {["supports", "contradicts"].includes(p.link.relation)
                            ? "→"
                            : "↔"}{" "}
                          {p.link.target_filename} ({p.link.version})
                        </p>
                        {p.visibleIds &&
                          [p.link.source_document_id, p.link.document_id].some(
                            (id) => !p.visibleIds!.includes(id),
                          ) && (
                            <p className="secondary">
                              A linked endpoint is outside the loaded files in
                              this view. View connected file opens its saved
                              version.
                            </p>
                          )}
                        {linkError ? (
                          <p role="alert">{linkError}</p>
                        ) : !linkDetail ? (
                          <p role="status">Loading supporting passages…</p>
                        ) : (
                          <>
                            <h4>Source passage</h4>
                            {linkDetail.source.map((e) => (
                              <EvidencePassage key={e.evidence_id} e={e} />
                            ))}
                            <h4>Target passage</h4>
                            {linkDetail.target.map((e) => (
                              <EvidencePassage key={e.evidence_id} e={e} />
                            ))}
                            <button
                              className="link-button"
                              onClick={() =>
                                p.onSelect({
                                  document_id:
                                    p.link!.source_document_id ===
                                    doc.document_id
                                      ? p.link!.document_id
                                      : p.link!.source_document_id,
                                  version:
                                    p.link!.source_document_id ===
                                    doc.document_id
                                      ? p.link!.version
                                      : p.link!.source_version,
                                  filename:
                                    p.link!.source_document_id ===
                                    doc.document_id
                                      ? p.link!.target_filename
                                      : p.link!.source_filename,
                                  mime_type: "application/octet-stream",
                                })
                              }
                            >
                              View connected file
                            </button>
                          </>
                        )}
                      </section>
                    )}
                  </>
                )}
              </Tabs.Content>
            </>
          )}
        </div>
      </Tabs.Root>
      <footer className="inspector-footer">
        <label className="version-select">
          <select
            aria-label="Preview version"
            onFocus={() => setHistoryOpen(true)}
            value={version}
            onChange={(e) => {
              setVersion(e.target.value);
              p.onVersion(e.target.value);
            }}
          >
            {(history?.versions.some((v) => v.version === doc.version)
              ? history.versions
              : [doc, ...(history?.versions || [])]
            ).map((v) => (
              <option key={v.version} value={v.version}>
                {v.version}
                {v.version === (detail?.current_version || p.doc.version)
                  ? " · Current"
                  : ""}
              </option>
            ))}
          </select>
        </label>
        {history?.has_more && historyOpen && (
          <button disabled={historyBusy} onClick={() => void loadHistory(true)}>
            Older versions
          </button>
        )}
        <div>
          <button className="open-file" onClick={() => p.onOpen(true)}>
            <ExternalLink size={18} />
            Open file
          </button>
          <a
            className="button icon"
            aria-label={"Download " + version}
            href={fileUrl(doc, true)}
          >
            <Download size={20} />
          </a>
        </div>
      </footer>
      <Dialog.Root open={p.open} onOpenChange={p.onOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="overlay" />
          <Dialog.Content
            className="preview-dialog"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              p.onPreviewClose();
            }}
          >
            <Dialog.Title>
              {doc.filename} · {version}
            </Dialog.Title>
            <Dialog.Description className="sr-only">
              Original file preview of the selected saved version.
            </Dialog.Description>
            <Dialog.Close
              className="icon preview-close"
              aria-label="Close file preview"
            >
              <X />
            </Dialog.Close>
            <Preview doc={doc} />
            <a className="button" href={fileUrl(doc, true)}>
              <Download size={18} />
              Download {version}
            </a>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </aside>
  );
}
