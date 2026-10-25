import { DefaultCard, items, label, record } from "../core/cards";
import type { ToolState } from "../core/state";
export type OpenDocument = (
  document: { document_id: string; version: string },
  evidence_id?: string,
) => void;

export function TransferReceipt({ result }: { result: unknown }) {
  const value = record(result);
  const searchStates: Record<string, string> = {
    pending: "Indexing queued",
    indexed: "Indexed; searchable content not confirmed",
    unsupported: "Unsupported format",
    failed: "Indexing failed",
    empty: "No searchable content",
    receiving: "Receiving bytes",
    committing: "Saving original",
    superseded: "Superseded version",
  };
  return (
    <section
      aria-label="Transfer receipt"
      className="assistant-transfer-receipt"
    >
      {value.job_id && !items(value.files).length ? (
        <p>
          Transfer {label(value.status) || "queued"} · Job{" "}
          <code>{label(value.job_id)}</code>. Original storage is not yet
          confirmed.
        </p>
      ) : null}
      {items(value.files).map((item, index) => {
        const file = record(item);
        return (
          <p key={index}>
            <strong>{label(file.filename) || "File"}</strong>
            <code className="assistant-file-identity">
              {label(file.document_id)} ·{" "}
              {label(file.version) || "Version unavailable"}
            </code>
            <span>
              {file.stored === true
                ? "Original saved"
                : file.stored === false
                  ? "Original not saved"
                  : "Original not confirmed saved"}{" "}
              · Search:{" "}
              {file.searchable === true
                ? "Ready"
                : searchStates[label(file.indexing_status)] ||
                  "Not yet confirmed searchable"}
            </span>
            {label(file.request_id) && (
              <small className="assistant-file-identity">
                Request: {label(file.request_id)}
              </small>
            )}
            {label(file.error) && (
              <span role="alert"> · {label(file.error)}</span>
            )}
          </p>
        );
      })}
      {value.complete === false && (
        <p>Some files need attention. Review each receipt before retrying.</p>
      )}
    </section>
  );
}
export function SearchCard({
  tool,
  open,
}: {
  tool: ToolState;
  open: OpenDocument;
}) {
  const result = record(tool.result),
    matches = items(result.matches),
    answer = record(result.answer),
    checked = tool.name === "ask" || Object.keys(answer).length > 0;
  const emptyMessage = !checked
    ? "No matching documents."
    : answer.status === "unavailable" ||
        record(result.evaluation).status === "unavailable"
      ? "Answer checking is unavailable."
      : answer.status === "no_candidates"
        ? "No candidates found for this question."
        : answer.status === "not_evaluated"
          ? "The retrieved passages were not checked."
          : answer.status === "needs_context"
            ? "The checked passages need more context to answer."
            : "No verified answer in the checked passages.";
  return (
    <DefaultCard tool={tool}>
      {matches.map((value, i) => {
        const doc = record(value),
          id = label(doc.document_id),
          version = label(doc.version);
        return (
          <div className="assistant-result" key={id || i}>
            <strong>{label(doc.filename)}</strong>
            <p>
              {label(doc.excerpt) ||
                label(record(items(doc.evidence)[0]).text).slice(0, 240)}
            </p>
            {id && version && (
              <button
                type="button"
                onClick={() => open({ document_id: id, version })}
              >
                Open
              </button>
            )}
          </div>
        );
      })}
      {tool.state === "done" && !matches.length && (
        <p>
          {emptyMessage}
          {checked && " This does not describe the whole library."}
        </p>
      )}
    </DefaultCard>
  );
}
export function JevCard({
  tool,
  open,
}: {
  tool: ToolState;
  open: OpenDocument;
}) {
  return (
    <DefaultCard tool={tool}>
      {items(record(tool.result).decisions).map((value, i) => {
        const p = record(value),
          id = label(p.document_id),
          version = label(p.version);
        return (
          <div className="assistant-result" key={label(p.id) || i}>
            <strong>{label(p.filename)}</strong>
            <p>{label(p.reason)}</p>
            <p>
              {label(p.current)} → {label(p.suggested)}
            </p>
            <blockquote>{label(p.excerpt)}</blockquote>
            {id && version && (
              <button
                type="button"
                onClick={() =>
                  open(
                    { document_id: id, version },
                    label(items(p.evidence_ids)[0]),
                  )
                }
              >
                Show evidence
              </button>
            )}
          </div>
        );
      })}
    </DefaultCard>
  );
}
export function ReadCard({
  tool,
  open,
}: {
  tool: ToolState;
  open: OpenDocument;
}) {
  const result = record(tool.result),
    doc = record(result.document),
    id = label(doc.document_id),
    version = label(doc.version);
  return (
    <DefaultCard tool={tool}>
      {tool.state === "done" && (
        <div className="assistant-result">
          <strong>{label(doc.filename)}</strong>
          <p>
            {result.status === "no_text"
              ? "No extracted text available for this read."
              : `${label(result.characters_read)} characters read${result.has_more ? " · More text available" : " · End of extracted text"}`}
          </p>
          {id && version && (
            <button
              type="button"
              onClick={() => open({ document_id: id, version })}
            >
              Open
            </button>
          )}
        </div>
      )}
    </DefaultCard>
  );
}
export function DocumentCard({
  tool,
  open,
}: {
  tool: ToolState;
  open: OpenDocument;
}) {
  const result = record(tool.result),
    reply = record(result.result),
    failed = result.ok === false || reply.ok === false,
    args = record(tool.args),
    id = label(args.document_id),
    version = label(args.version),
    reason = label(reply.reason) || label(result.reason);
  const explanation =
    label(reply.message) ||
    label(result.message) ||
    {
      user_busy: "Finish your unsent text or close the open dialog first.",
      view_changed: "Your view changed before the action finished.",
      cancelled: "The action was cancelled.",
      no_ui: "The app is not connected.",
    }[reason] ||
    reason;
  return (
    <DefaultCard tool={tool}>
      {tool.state === "done" && (
        <p>
          {failed
            ? `Action not completed: ${explanation}`
            : label(reply.message) ||
              (tool.name === "highlight_evidence"
                ? "Evidence highlighted"
                : "Browser view updated")}
        </p>
      )}
      {tool.state === "done" &&
        failed &&
        id &&
        version &&
        ["open_document", "highlight_evidence"].includes(tool.name) && (
          <button
            type="button"
            onClick={() =>
              open(
                { document_id: id, version },
                label(args.evidence_id) || undefined,
              )
            }
          >
            Open now
          </button>
        )}
    </DefaultCard>
  );
}
