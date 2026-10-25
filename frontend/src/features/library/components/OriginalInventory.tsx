import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import {
  api,
  indexingLabel,
  waitForJob,
  type Doc,
  type Job,
  type InventoryPage as Page,
  type TaxonomyFacet as Facet,
  type TaxonomyPage as Taxonomy,
} from "../../../shared/api/client";
import "./audit-clarity.css";

const dimensions = ["project", "folder", "topic", "status"] as const;
const names = {
  project: "projects",
  folder: "folders",
  topic: "topics",
  status: "statuses",
};

async function read<T>(path: string, signal: AbortSignal): Promise<T> {
  const reply = await api<T | Job<T>>(path, undefined, signal);
  return reply && typeof reply === "object" && "job_id" in reply
    ? await waitForJob(reply as Job<T>, signal)
    : (reply as T);
}

export default function OriginalInventory(p: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpen: (doc: Doc) => void;
}) {
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [cursor, setCursor] = useState<string>();
  const [page, setPage] = useState<Page>();
  const [facets, setFacets] = useState<Facet[]>([]);
  const [facetCursor, setFacetCursor] = useState<string>();
  const [nextFacet, setNextFacet] = useState<string>();
  const [error, setError] = useState("");
  const [taxonomyError, setTaxonomyError] = useState("");
  const [loading, setLoading] = useState(false);
  const [facetLoading, setFacetLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!p.open) {
      setCursor(undefined);
      setFacetCursor(undefined);
      setNextFacet(undefined);
      setFacets([]);
      setPage(undefined);
    }
  }, [p.open]);
  useEffect(() => {
    if (!p.open) return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setPage(undefined);
    const query = new URLSearchParams({ limit: "50", ...filters });
    if (cursor) query.set("cursor", cursor);
    read<Page>("catalog?" + query, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setPage(result);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [p.open, filters, cursor, retry]);
  useEffect(() => {
    if (!p.open) return;
    const controller = new AbortController();
    setTaxonomyError("");
    setFacetLoading(true);
    read<Taxonomy>(
      "taxonomy?limit=100" +
        (facetCursor ? "&cursor=" + encodeURIComponent(facetCursor) : ""),
      controller.signal,
    )
      .then((result) => {
        if (controller.signal.aborted) return;
        setFacets((old) =>
          facetCursor ? [...old, ...result.items] : result.items,
        );
        setNextFacet(result.next_cursor || undefined);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setTaxonomyError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setFacetLoading(false);
      });
    return () => controller.abort();
  }, [p.open, facetCursor, retry]);
  function change(key: string, value: string) {
    setCursor(undefined);
    setFilters((old) => {
      const next = { ...old };
      if (value === "*") delete next[key];
      else next[key] = value;
      return next;
    });
  }
  function restart() {
    setCursor(undefined);
    setFacetCursor(undefined);
    setRetry((n) => n + 1);
  }
  return (
    <Dialog.Root open={p.open} onOpenChange={p.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className="reset-dialog original-inventory">
          <header>
            <div>
              <Dialog.Title>Browse all originals</Dialog.Title>
              <Dialog.Description>
                Every saved current original, including files without searchable
                text.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button className="icon" aria-label="Close original inventory">
                <X size={18} />
              </button>
            </Dialog.Close>
          </header>
          <p className="field-help">
            Project is ownership. Folder is placement. Topics describe subjects.
            Connections record evidence between two versions. These are separate
            choices.
          </p>
          <div className="inventory-filters">
            {dimensions.map((dimension) => (
              <label key={dimension}>
                {dimension === "status"
                  ? "Search status"
                  : dimension[0].toUpperCase() + dimension.slice(1)}
                <select
                  aria-label={`Inventory ${dimension}`}
                  value={filters[dimension] ?? "*"}
                  onChange={(event) => change(dimension, event.target.value)}
                >
                  <option value="*">All {names[dimension]}</option>
                  {dimension === "folder" && <option value="">Unfiled</option>}
                  {facets
                    .filter(
                      (f) =>
                        f.dimension === names[dimension] &&
                        (dimension !== "folder" || f.id),
                    )
                    .map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name || "Unassigned"} ({f.count})
                      </option>
                    ))}
                </select>
              </label>
            ))}
          </div>
          {facetLoading && <p role="status">Loading filter choices…</p>}
          <p className="field-help">
            Filter counts describe the whole library. Selected filters are
            combined.
          </p>
          {nextFacet && (
            <button onClick={() => setFacetCursor(nextFacet)}>
              Load more filter choices
            </button>
          )}
          {taxonomyError && (
            <p role="alert">
              Filter choices: {taxonomyError}{" "}
              <button onClick={restart}>Refresh choices</button>
            </p>
          )}
          <div className="inventory-controls">
            <button
              onClick={() => {
                setFilters({});
                setCursor(undefined);
              }}
            >
              Clear inventory filters
            </button>
            <button onClick={restart}>Refresh inventory</button>
          </div>
          {loading && <p role="status">Loading saved originals…</p>}
          {error && (
            <p role="alert">
              {error} <button onClick={restart}>Restart inventory</button>
            </p>
          )}
          {page && (
            <>
              <p role="status">
                {page.total_originals} originals saved in the library ·{" "}
                {page.documents.length} on this page
                {Object.keys(filters).length ? " with these filters" : ""}.
              </p>
              {!page.documents.length && (
                <p>
                  {page.has_more
                    ? "No matches in this part of the inventory. Continue to the next page."
                    : "No originals match these filters on this page."}
                </p>
              )}
              <ul className="inventory-results">
                {page.documents.map((doc) => (
                  <li key={doc.document_id}>
                    <button
                      className="inventory-open"
                      title={doc.filename}
                      onClick={() => {
                        p.onOpenChange(false);
                        p.onOpen({ ...doc, status: doc.indexing_status });
                      }}
                    >
                      <strong>{doc.filename}</strong>
                      <span>
                        {doc.version} ·{" "}
                        {doc.indexing_status === "indexed" && !doc.searchable
                          ? "Stored · Current version not ready for search"
                          : indexingLabel(doc.indexing_status)}
                      </span>
                    </button>
                    <p>
                      Project: {doc.project?.name || "Unassigned"} · Folder:{" "}
                      {doc.folder || "Unfiled"} · Topics:{" "}
                      {doc.topics.join(", ") || "None"}
                    </p>
                    {doc.indexing_error && <p>{doc.indexing_error}</p>}
                  </li>
                ))}
              </ul>
              <div className="inventory-controls">
                {cursor && (
                  <button onClick={() => setCursor(undefined)}>
                    First page
                  </button>
                )}
                {page.has_more && (
                  <button
                    onClick={() => setCursor(page.next_cursor || undefined)}
                  >
                    Next originals
                  </button>
                )}
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
