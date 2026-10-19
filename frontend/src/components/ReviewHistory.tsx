import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ClipboardList, X } from "lucide-react";
import type { Rebuild } from "../api";
import { reviewMetrics } from "../browsePresentation";
import { boundedHistory } from "../readingTools";
import { readSaved, save, preferenceKey } from "../presentation";
type Entry = {
  id: string;
  status: string;
  mode: string;
  scope: string;
  metrics: string;
  observed: string;
  failed: number;
};
export default function ReviewHistory(p: {
  job: Rebuild | null;
  libraryId?: string;
  onShowCurrent: () => void;
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!p.libraryId) {
      setEntries([]);
      return;
    }
    const key = preferenceKey(p.libraryId, "reviewHistory");
    const stored = readSaved<Entry[]>(key, []);
    const history = Array.isArray(stored)
      ? stored
          .filter(
            (e) =>
              e && typeof e.id === "string" && typeof e.observed === "string",
          )
          .slice(0, 30)
      : [];
    const job = p.job;
    if (!job || ["running", "queued"].includes(job.status)) {
      setEntries(history);
      return;
    }
    const old = history.find((e) => e.id === job.request_id);
    const entry: Entry = {
      id: job.request_id,
      status: job.status,
      mode:
        job.mode === "links"
          ? "Connection review"
          : job.mode === "unfiled"
            ? "Unfiled review"
            : "Organization rebuild",
      scope: job.folder === null ? "All files" : job.folder || "Unfiled",
      metrics: reviewMetrics(job),
      failed: job.failed,
      observed: old?.observed || new Date().toISOString(),
    };
    const next = boundedHistory(history, entry);
    setEntries(next);
    save(key, next);
  }, [p.job, p.libraryId]);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          className="icon"
          aria-label="Review history"
          title="Review history"
        >
          <ClipboardList size={18} />
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className="reset-dialog review-history">
          <div className="search-options-heading">
            <div>
              <Dialog.Title>Review history</Dialog.Title>
              <Dialog.Description>
                Latest 30 completed reviews observed in this browser. Times
                record when this browser first saw the result.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button className="icon" aria-label="Close review history">
                <X size={18} />
              </button>
            </Dialog.Close>
          </div>
          {!entries.length && (
            <p>
              No completed reviews recorded yet. New review results will appear
              here.
            </p>
          )}
          <ol>
            {entries.map((entry) => (
              <li key={entry.id}>
                <strong>
                  {entry.mode} · {entry.status}
                </strong>
                <p>{entry.scope}</p>
                <p>{entry.metrics}</p>
                <time dateTime={entry.observed}>
                  First observed {new Date(entry.observed).toLocaleString()}
                </time>
                {entry.failed > 0 && (
                  <p>
                    Some items failed. Open the current review for available
                    retry actions.
                  </p>
                )}
                {entry.id === p.job?.request_id && (
                  <p>
                    <button
                      onClick={() => {
                        setOpen(false);
                        p.onShowCurrent();
                      }}
                    >
                      Open current review
                    </button>
                  </p>
                )}
              </li>
            ))}
          </ol>
          <small>
            Only reported counts are shown. File-by-file change history is not
            provided by the review service.
          </small>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
