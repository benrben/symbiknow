import { useEffect, useState } from "react";
import { Folder, Search } from "lucide-react";
import { DocumentIcon as FileText } from "../../../shared/components/KnowledgeIcons";
import { contextualTitle } from "../../library/presentation";
import { api, title, type Doc, type Library } from "../../../shared/api/client";

export default function ReaderNavigator(p: {
  doc: Doc;
  docs: Doc[];
  search: boolean;
  group?: string;
  revision: string;
  onOpen: (doc: Doc) => void;
}) {
  const [result, setResult] = useState<Library>();
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState(0);
  const [retry, setRetry] = useState(0);
  const folder = p.doc.folder || "";
  useEffect(() => {
    setPage(0);
    setQuery("");
    setResult(undefined);
  }, [folder, p.search, p.group]);
  useEffect(() => {
    if (p.search) return;
    const c = new AbortController();
    setBusy(true);
    setError("");
    const params = new URLSearchParams({
      folder,
      limit: "60",
      sort: "filename",
    });
    if (p.group) params.set("group", p.group);
    // Pages remain bounded while every file in a large folder stays reachable.
    params.set("offset", String(page * 60));
    api<Library>("library?" + params, undefined, c.signal)
      .then((r) => {
        if (!c.signal.aborted) setResult(r);
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!c.signal.aborted) setBusy(false);
      });
    return () => c.abort();
  }, [folder, p.search, p.group, p.revision, page, retry]);
  const loaded = p.search
    ? p.docs
    : result?.documents || p.docs.filter((d) => (d.folder || "") === folder);
  const docs = loaded.some((d) => d.document_id === p.doc.document_id)
    ? loaded
    : [p.doc, ...loaded];
  const filtered = docs.filter((d) =>
    title(d).toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <nav className="reader-navigator" aria-label="Reader file navigation">
      <div className="reader-navigation-heading">
        <Folder size={17} />
        <strong title={folder}>
          {p.search ? "Search results" : folder || "Unfiled"}
        </strong>
      </div>
      <label className="reader-file-search">
        <Search size={15} />
        <input
          aria-label="Find a file in reader"
          placeholder="Find a file…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <p className="reader-navigation-count">
        {p.search
          ? `${loaded.length} matches`
          : `${loaded.length ? page * 60 + 1 : 0}–${page * 60 + loaded.length} of ${result?.total ?? loaded.length} files`}
        {busy ? " · Loading…" : ""}
      </p>
      {error && (
        <p role="alert">
          Files unavailable.{" "}
          <button onClick={() => setRetry((n) => n + 1)}>Retry</button>
        </p>
      )}
      <div className="reader-file-list">
        {filtered.map((d) => (
          <button
            key={d.document_id}
            title={d.filename}
            aria-label={`Read ${title(d)}`}
            aria-current={
              d.document_id === p.doc.document_id ? "page" : undefined
            }
            onClick={() => p.onOpen(d)}
          >
            <FileText size={17} />
            <span>{contextualTitle(d.filename, d.folder)}</span>
          </button>
        ))}
        {!filtered.length && (
          <p className="secondary">No matching loaded files.</p>
        )}
      </div>
      {!p.search && (page > 0 || result?.has_more) && (
        <div className="reader-navigation-more">
          <button
            disabled={busy || page === 0}
            onClick={() => setPage((n) => Math.max(0, n - 1))}
          >
            Previous files
          </button>
          <button
            disabled={busy || !result?.has_more}
            onClick={() => setPage((n) => n + 1)}
          >
            Next files
          </button>
          <p>
            File search filters this page. Library search covers the entire
            folder.
          </p>
        </div>
      )}
    </nav>
  );
}
