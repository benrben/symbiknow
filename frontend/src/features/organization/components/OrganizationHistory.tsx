import { useEffect, useState } from "react";
import {
  api,
  waitForJob,
  useDataRevision,
  type Job,
  type OrganizationHistoryPage as HistoryPage,
} from "../../../shared/api/client";

function changedValue(value: unknown): string {
  if (typeof value === "string") return value || "Unfiled";
  if (Array.isArray(value))
    return (
      value.filter((item) => typeof item === "string").join(", ") || "No topics"
    );
  if (!value || typeof value !== "object") return "";
  const row = value as Record<string, unknown>;
  return [row.name, row.folder, row.relation, row.document_id, row.version]
    .filter((item) => typeof item === "string")
    .join(" · ");
}
export default function OrganizationHistory({
  documentId,
}: {
  documentId: string;
}) {
  const [open, setOpen] = useState(false),
    [cursor, setCursor] = useState<string>();
  const [page, setPage] = useState<HistoryPage>(),
    [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const revision = useDataRevision();
  useEffect(() => {
    setCursor(undefined);
  }, [revision, documentId]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setPage(undefined);
    setError("");
    const params = new URLSearchParams({ id: documentId, limit: "20" });
    if (cursor) params.set("cursor", cursor);
    api<HistoryPage | Job<HistoryPage>>(
      "organization-history?" + params,
      undefined,
      controller.signal,
    )
      .then(async (result) =>
        "job_id" in result
          ? await waitForJob(result, controller.signal)
          : result,
      )
      .then((result) => {
        if (!controller.signal.aborted) setPage(result);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [open, documentId, cursor, retry, revision]);
  return (
    <details
      className="organization-history"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Organization and connection history</summary>
      {open && (
        <>
          <p className="secondary">
            Recorded changes to this file across versions. Older decisions may
            have no saved date or reviewer.
          </p>
          <button
            onClick={() => {
              setCursor(undefined);
              setRetry((n) => n + 1);
            }}
          >
            Refresh organization history
          </button>
          {error ? (
            <p role="alert">
              {error}{" "}
              <button
                onClick={() => {
                  setCursor(undefined);
                  setRetry((n) => n + 1);
                }}
              >
                Reload history
              </button>
            </p>
          ) : !page ? (
            <p role="status">Loading history…</p>
          ) : (
            <>
              {!page.entries.length && <p>No saved changes were returned.</p>}
              <ol>
                {page.entries.map((entry) => (
                  <li key={entry.id}>
                    <strong>{entry.action}</strong> ·{" "}
                    {entry.version || "Version not recorded"}
                    <p>{entry.reason || "Reason not recorded"}</p>
                    {changedValue(entry.value) && (
                      <p>Recorded value: {changedValue(entry.value)}</p>
                    )}
                    {entry.effective_owner !== undefined && (
                      <p>
                        Project: {entry.effective_owner?.name || "Unassigned"}
                      </p>
                    )}
                    {entry.target_document_id && (
                      <p>
                        Connected file: {entry.target_document_id} ·{" "}
                        {entry.target_version || "Version not recorded"}
                      </p>
                    )}
                    <small>
                      {entry.actor || "Reviewer not recorded"} ·{" "}
                      {entry.timestamp || "Date not recorded"}
                    </small>
                  </li>
                ))}
              </ol>
              {page.limitations?.map((note) => (
                <p className="secondary" key={note}>
                  {note}
                </p>
              ))}
              {cursor && (
                <button onClick={() => setCursor(undefined)}>
                  First history page
                </button>
              )}
              {page.has_more && (
                <button
                  onClick={() => setCursor(page.next_cursor || undefined)}
                >
                  Next history page
                </button>
              )}
            </>
          )}
        </>
      )}
    </details>
  );
}
