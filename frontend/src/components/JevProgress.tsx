import { CheckCircle2, RefreshCw, X, CircleAlert } from "lucide-react";
import type { Rebuild } from "../api";

export default function JevProgress({
  job,
  onHide,
  onRetry,
}: {
  job: Rebuild;
  onHide: () => void;
  onRetry: () => void;
}) {
  const busy = ["queued", "running"].includes(job.status);
  const review = !!job.mode && job.mode !== "reset";
  const done = job.completed + job.failed + (job.skipped || 0);
  const percent = job.total
    ? Math.min(100, Math.round((done / job.total) * 100))
    : 100;
  const title =
    job.mode === "links"
      ? "Jev · Reviewing links"
      : job.mode === "unfiled"
        ? "Jev · Grouping unfiled files"
        : "Jev · Reset & rebuild";
  return (
    <section
      className={`jev-progress ${busy ? "is-working" : "is-complete"}`}
      aria-label="Jev activity"
    >
      <div className="jev-progress-heading">
        {busy ? (
          <RefreshCw className="jev-working-icon" size={16} />
        ) : job.failed || job.unfiled ? (
          <CircleAlert size={16} />
        ) : (
          <CheckCircle2 size={16} />
        )}
        <strong>
          {busy
            ? title
            : job.failed
              ? "Jev finished with failures"
              : job.unfiled
                ? "Jev finished · Some files need a folder"
                : "Jev review complete"}
        </strong>
        <span className="jev-progress-count">
          {done} / {job.total} files · {percent}%
        </span>
        <button
          className="icon"
          title={
            busy ? "Hide progress; Jev continues working" : "Dismiss progress"
          }
          aria-label="Hide Jev progress"
          onClick={onHide}
        >
          <X size={14} />
        </button>
      </div>
      <progress
        aria-label="Jev review progress"
        max={Math.max(job.total, 1)}
        value={job.total ? done : 1}
      />
      <div
        className="jev-progress-description"
        role="status"
        aria-live="polite"
      >
        {busy ? (
          <>
            <span className="jev-current-file" title={job.current_filename}>
              {job.phase === "clearing"
                ? "Clearing selected organization…"
                : `${job.activity || "Preparing review"}${job.current_filename ? ` · ${job.current_filename}` : "…"}`}
            </span>
            <span>{Math.max(0, job.total - done)} remaining</span>
          </>
        ) : (
          <span>
            {job.grouping && job.grouped !== undefined
              ? `${job.grouped} grouped · ${job.unfiled || 0} still unfiled`
              : `${job.completed} reviewed`}
            {job.links_added !== undefined &&
              ` · ${job.links_added} links added`}{" "}
            · {job.skipped || 0} skipped · {job.failed} failed
          </span>
        )}
      </div>
      {!!job.details?.length && (
        <details>
          <summary>View files needing attention</summary>
          <ul>
            {job.details.map((d) => (
              <li key={d.document_id}>
                {d.filename} · {d.outcome}: {d.reason}
                {d.outcome === "unfiled"
                  ? " · Original stored; choose a folder manually or add context"
                  : review
                    ? " · Existing organization kept"
                    : job.grouping
                      ? " · Unfiled; original stored"
                      : " · Folder retained; links cleared"}
              </li>
            ))}
          </ul>
        </details>
      )}
      {job.failed > 0 && (
        <button disabled={busy} onClick={onRetry}>
          Retry failed items
        </button>
      )}
    </section>
  );
}
