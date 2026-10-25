import { useEffect, useRef, useState } from "react";
import { searchEvidence, passagePreview } from "../../search/evidence";
import Markdown from "../../reader/components/Markdown";
import { browseExcerpt } from "../presentation";
import { api, kind, useDataRevision, type Doc, type CardPreview } from "../../../shared/api/client";
import { Image as ImageIcon } from "lucide-react";
import { DocumentIcon as FileText } from "../../../shared/components/KnowledgeIcons";
export default function ContentCard({
  doc,
  search = false,
  evaluate = true,
  query = "",
  compactPreview = false,
}: {
  doc: Doc;
  search?: boolean;
  evaluate?: boolean;
  query?: string;
  compactPreview?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [table, setTable] = useState<string[][]>();
  const [visible, setVisible] = useState(false),
    [text, setText] = useState(""),
    [heading, setHeading] = useState(""),
    [failed, setFailed] = useState(false),
    [pending, setPending] = useState(true);
  const revision = useDataRevision();
  const k = kind(doc),
    key = JSON.stringify([doc.document_id, doc.version, k === "Image" || k === "PDF" ? "" : revision]);
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        setVisible(entries.some((e) => e.isIntersecting));
      },
      { rootMargin: "150px" },
    );
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, [doc.document_id, doc.version]);
  useEffect(() => {
    if (!visible && !(search && doc.evidence)) return;
    setFailed(false);
    setTable(undefined);
    setText("");
    setHeading("");
    setPending(true);
    const c = new AbortController();
    if (k === "Image" || k === "PDF") {
      void api("preview-ready?id=" + encodeURIComponent(doc.document_id) + "&version=" + encodeURIComponent(doc.version), undefined, c.signal)
        .then(() => { if (!c.signal.aborted) setPending(false); })
        .catch(e => { if (e.name !== "AbortError") { setFailed(true); setPending(false); } });
      return () => c.abort();
    }
    if (search && doc.evidence) {
      const rows = searchEvidence(doc, evaluate);
      const suppliedExcerpt = (doc.excerpt || "").replace(/[.…]+$/, "").trim();
      const row =
        rows.find((r) => r.priority < 3 && r.evidence.text) ||
        (suppliedExcerpt
          ? rows.find((r) => r.evidence.text.includes(suppliedExcerpt))
          : undefined) ||
        rows.find((r) => r.evidence.text);
      setText(
        row ? passagePreview(row.evidence, 360, query, compactPreview) : "",
      );
      setHeading(row?.role || "Retrieved passage");
      setPending(false);
      return;
    }
    api<CardPreview>(
      `card?id=${encodeURIComponent(doc.document_id)}&version=${doc.version}`,
      undefined,
      c.signal,
    )
      .then((r) => {
        if (c.signal.aborted) return;
        setTable(r.table);
        const preview = browseExcerpt(r.evidence);
        setText(preview.text);
        setHeading(preview.heading);
      })
      .catch((e) => {
        if (e.name !== "AbortError") setFailed(true);
      })
      .finally(() => {
        if (!c.signal.aborted) setPending(false);
      });
    return () => c.abort();
  }, [
    key,
    visible,
    search,
    doc.excerpt,
    doc.evidence,
    doc.jev,
    evaluate,
    query,
    compactPreview,
    k,
  ]);
  return (
    <div
      ref={ref}
      className={`content-card nodrag nowheel preview-${k.toLowerCase()}`}
      aria-label={`${k} preview`}
    >
      {visible && !pending && !failed && (k === "Image" || k === "PDF") ? (
        <img
          loading="lazy"
          alt={doc.filename}
          src={`/api/thumbnail?id=${encodeURIComponent(doc.document_id)}&version=${encodeURIComponent(doc.version)}`}
          onError={() => setFailed(true)}
        />
      ) : table?.length ? (
        <table className="card-table">
          <tbody>
            {table.map((row, i) => (
              <tr key={i}>
                {row.map((cell, n) =>
                  i === 0 ? (
                    <th key={n} title={cell}>
                      {cell}
                    </th>
                  ) : (
                    <td key={n} title={cell}>
                      {cell}
                    </td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      ) : text ? (
        <div className="card-prose">
          {heading && !compactPreview && <h2>{heading}</h2>}
          <Markdown
            components={{
              img: () => null,
              a: ({ children }) => <span>{children}</span>,
            }}
          >
            {(heading && text.startsWith(heading)
              ? text.slice(heading.length).trim()
              : text
            ).slice(0, 1200)}
          </Markdown>
        </div>
      ) : (
        <div className="card-placeholder">
          {k === "Image" ? <ImageIcon size={18} /> : <FileText size={18} />}
          <span>
            {pending
              ? "Loading preview…"
              : failed
                ? "Preview unavailable · Open or download"
                : `${k} · Open or download`}
          </span>
        </div>
      )}
      {visible && !pending && !failed && k === "PDF" && (
        <span className="preview-page-label">Page 1</span>
      )}
    </div>
  );
}
