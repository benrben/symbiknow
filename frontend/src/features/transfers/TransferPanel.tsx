import { Upload } from "lucide-react";
import type { UploadWarning } from "../../shared/api/client";
import type { Transfer } from "./useTransfers";
import "./transfers.css";

export function ImportFormats({ maxFileBytes }: { maxFileBytes: number }) {
  return <details className="import-formats">
    <summary>Import formats · searchable or stored only</summary>
    <p>Searchable after indexing: TXT, Python and shell text, Markdown (.md, .markdown),
      HTML (.html, .htm), CSV, Word (.docx), Excel (.xlsx), PDF, SVG text, and PNG,
      JPEG, WebP, GIF, BMP and TIFF images. Office extraction keeps document text and
      tables; spreadsheet formulas use saved calculated values. Scripts are read as
      text and never run. PDF and image extraction depends on OCR and model availability.</p>
    <p>Stored only: PowerPoint, older Office formats, and other unsupported formats.
      Their original bytes and versions are saved and downloadable; their contents are not searchable.</p>
    <p>Up to {Math.round(maxFileBytes / 1048576)} MiB per file. Import creates new files.
      To replace an existing file, use its Update version action; previous versions remain available.</p>
  </details>;
}

export default function TransferPanel({ transfers, retry, dismiss, openExisting, updateExisting }: {
  transfers: Transfer[];
  retry: (item: Transfer) => void;
  dismiss: (id: string) => void;
  openExisting: (item: Transfer, warning: UploadWarning) => Promise<void>;
  updateExisting: (item: Transfer, warning: UploadWarning) => Promise<void>;
}) {
  if (!transfers.length) return null;
  return <section className="transfers" aria-label="File imports" aria-live="polite">
    {transfers.map(item => {
      const active = ["Uploading", "Queued"].includes(item.state);
      return <div className="transfer-receipt" key={item.id}>
        <div className="transfer-summary">
          <Upload size={14} aria-hidden="true" />
          <strong title={item.file.name}>{item.file.name}</strong>
          <span>{item.state === "Uploading"
            ? `Uploading ${item.percent}% · ${Math.round(item.file.size * item.percent / 100).toLocaleString()} / ${item.file.size.toLocaleString()} bytes`
            : item.state}</span>
          {active && <progress aria-label={`Import progress for ${item.file.name}`} max={100} value={item.percent} />}
          {item.error && <><span className="error">{item.error}</span><button onClick={() => retry(item)}>Retry</button></>}
          {!active && <button disabled={item.actionBusy} onClick={() => dismiss(item.id)}>Dismiss</button>}
        </div>
        {item.document?.warnings?.length ? <div className="transfer-warnings">
          <p>A new copy was saved. Possible duplicates:</p>
          {item.document.warnings.map(warning => <div className="transfer-warning" key={`${warning.document_id}:${warning.version}`}>
            <span>{warning.filename} · {warning.version} · {warning.reason}</span>
            <code>{warning.document_id}</code>
            <button disabled={item.actionBusy} onClick={() => void openExisting(item, warning)}>Open existing</button>
            <button disabled={item.actionBusy} onClick={() => void updateExisting(item, warning)}>Update version</button>
          </div>)}
          <p>Update version adds these bytes to the existing file. This imported copy is kept.</p>
        </div> : null}
        {item.actionError && <p className="error">{item.actionError}</p>}
      </div>;
    })}
  </section>;
}
