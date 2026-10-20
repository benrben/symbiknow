import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, ExternalLink } from "lucide-react";
import { fileUrl, type Doc } from "../../../shared/api/client";

export default function PdfPreview({ doc }: { doc: Doc }) {
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState<number>();
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl = "";
    setUrl("");
    setError("");
    setLoading(true);
    fetch(
      `/api/pdf-page?id=${encodeURIComponent(doc.document_id)}&version=${encodeURIComponent(doc.version)}&page=${page}`,
      { signal: controller.signal },
    )
      .then(async (response) => {
        if (!response.ok)
          throw new Error(
            (await response.json().catch(() => ({}))).error ||
              "PDF page unavailable",
          );
        const count = Number(response.headers.get("X-PDF-Page-Count"));
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
        if (Number.isInteger(count) && count > 0) setPages(count);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [doc.document_id, doc.version, page]);
  return (
    <div className="pdf-preview-container">
      <div className="pdf-navigation">
        <button
          className="icon"
          aria-label="Previous PDF page"
          disabled={page === 1 || loading}
          onClick={() => setPage(page - 1)}
        >
          <ChevronLeft size={16} />
        </button>
        <span aria-live="polite">
          Page {page}
          {pages ? ` of ${pages}` : ""}
        </span>
        <button
          className="icon"
          aria-label="Next PDF page"
          disabled={!pages || page >= pages || loading}
          onClick={() => setPage(page + 1)}
        >
          <ChevronRight size={16} />
        </button>
        <a
          href={fileUrl(doc)}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Open original PDF"
        >
          <ExternalLink size={15} />
        </a>
      </div>
      {loading && (
        <p className="secondary" role="status">
          Loading page {page}…
        </p>
      )}
      {error && (
        <p className="notice" role="status">
          PDF page preview unavailable. {error}.{" "}
          <a href={fileUrl(doc, true)}>Download PDF</a>
        </p>
      )}
      {url && (
        <img
          className="image-preview pdf-page-preview"
          alt={`Page ${page} of ${doc.filename}`}
          src={url}
          onError={() => setError("PDF page preview unavailable")}
        />
      )}
    </div>
  );
}
