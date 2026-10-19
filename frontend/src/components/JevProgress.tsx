import { CheckCircle2, LoaderCircle, X, CircleAlert, ChevronRight } from "lucide-react";
import { reviewMetrics } from "../browsePresentation";
import type { Rebuild } from "../api";

export default function JevProgress({ job, onHide, onRetry }: {
  job: Rebuild; onHide: () => void; onRetry: () => void;
}) {
  const busy = ["queued", "running"].includes(job.status);
  const attention = job.failed > 0 || (job.unfiled || 0) > 0 || ["failed", "interrupted"].includes(job.status);
  const done = job.completed + job.failed + (job.skipped || 0);
  const percent = job.total ? Math.min(100, Math.round(done / job.total * 100)) : 100;
  const title = busy ? job.mode === "links" ? "Reviewing connections" : job.mode === "unfiled" ? "Organizing unfiled files" : "Rebuilding organization"
    : attention ? "Review needs attention" : "Review complete";
  const description = <>
    <p className="review-metrics">{reviewMetrics(job)}</p>
    {!!job.details?.length && <details><summary>View files needing attention</summary><ul>{job.details.map(d => <li key={d.document_id}>{d.filename} · {d.reason}</li>)}</ul></details>}
    {job.failed > 0 && <button disabled={busy} onClick={onRetry}>Retry failed items</button>}
    <button className="review-dismiss" onClick={onHide} aria-label="Hide Jev progress">Dismiss</button>
  </>;
  if (!busy && !attention) return <details className="review-status" aria-label="Review status">
    <summary><CheckCircle2 size={17} /><span>{title}</span><span className="review-details-label">Details</span><ChevronRight size={14} /></summary>
    <div className="review-status-panel"><strong>Library review</strong>{description}</div>
  </details>;
  return <section className={`jev-progress ${busy ? "is-working" : "needs-attention"}`} aria-label="Jev activity">
    <div className="jev-progress-heading">{busy ? <LoaderCircle className="jev-working-icon" size={16} /> : <CircleAlert size={16} />}<strong>{title}</strong><span className="jev-progress-count">{done} / {job.total} files · {percent}%</span><button className="icon" title="Hide progress" aria-label="Hide Jev progress" onClick={onHide}><X size={14} /></button></div>
    {busy && <><progress aria-label="Jev review progress" max={Math.max(job.total, 1)} value={job.total ? done : 1} /><div className="jev-progress-description" role="status"><span className="jev-current-file">{job.phase === "clearing" ? "Clearing selected organization…" : `${job.activity || "Preparing review"}${job.current_filename ? ` · ${job.current_filename}` : "…"}`}</span><span>{Math.max(0, job.total - done)} remaining</span></div></>}
    {!busy && description}
  </section>;
}
