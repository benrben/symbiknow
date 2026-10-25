import { useEffect, useRef, type ReactNode } from "react";
import type { ToolState } from "./state";
import {
  Check,
  CircleAlert,
  Clock3,
  LoaderCircle,
  ShieldCheck,
  X,
} from "lucide-react";

export const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export const label = (value: unknown): string =>
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean"
    ? String(value)
    : "";
export const items = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];
export const title = (name: string) => name.replaceAll("_", " ");
export function DefaultCard({
  tool,
  children,
}: {
  tool: ToolState;
  children?: ReactNode;
}) {
  const unsuccessful =
    tool.state === "done" && record(tool.result).ok === false;
  const summary = Object.entries(tool.args || {})
    .filter(([key]) => !/(^id$|_id$|_ids$)/.test(key))
    .slice(0, 3)
    .map(
      ([key, value]) =>
        `${title(key)}: ${Array.isArray(value) ? `${value.length} items` : label(value).slice(0, 100) || "details"}`,
    )
    .join(" · ");
  return (
    <article className="assistant-tool" data-tool-state={tool.state}>
      <header>
        <strong>{tool.label || title(tool.name)}</strong>
        <span className="assistant-tool-state">
          {unsuccessful ? (
            <CircleAlert size={12} />
          ) : tool.state === "done" ? (
            <Check size={12} />
          ) : tool.state === "error" ? (
            <CircleAlert size={12} />
          ) : tool.state === "denied" ? (
            <X size={12} />
          ) : tool.state === "awaiting_approval" ? (
            <ShieldCheck size={12} />
          ) : (
            <LoaderCircle size={12} className="assistant-spin" />
          )}
          {unsuccessful
            ? "Not completed"
            : tool.state === "done"
              ? "Done"
              : title(tool.state)}
        </span>
      </header>
      {summary && <p className="assistant-tool-summary">{summary}</p>}
      {tool.state === "denied" && <p>You denied this. The agent was told.</p>}
      {tool.message && (
        <p role={tool.state === "error" ? "alert" : undefined}>
          {tool.message}
        </p>
      )}
      {children}
      {tool.startedAt && tool.finishedAt && (
        <small className="assistant-tool-timing">
          <Clock3 size={10} />
          {Math.max(0.1, (tool.finishedAt - tool.startedAt) / 1000).toFixed(1)}s
        </small>
      )}
      <details>
        <summary>Details</summary>
        <pre>
          {JSON.stringify(
            { arguments: tool.args, result: tool.result },
            null,
            2,
          )}
        </pre>
      </details>
    </article>
  );
}
export function ApprovalCard({
  tool,
  decide,
  disabled,
  children,
}: {
  tool: ToolState;
  decide: (id: string, approved: boolean) => void;
  disabled: boolean;
  children?: ReactNode;
}) {
  const card = useRef<HTMLDivElement>(null);
  const pending = tool.state === "awaiting_approval";
  const preview = record(tool.preview);
  useEffect(() => {
    if (!pending) return;
    const active = document.activeElement;
    if (
      !active?.matches("input,textarea,[contenteditable=true]") &&
      !document.querySelector("[role=dialog]")
    )
      card.current?.focus();
  }, [pending]);
  return (
    <DefaultCard tool={tool}>
      <div
        ref={card}
        tabIndex={-1}
        className="assistant-approval"
        aria-label="Review proposed change"
      >
        <p>
          <strong>Review this change</strong>
        </p>
        {label(preview.warning) && <p>{label(preview.warning)}</p>}
        {label(tool.args?.document_id) && (
          <p className="assistant-file-identity">
            File ID: {label(tool.args?.document_id)} ·{" "}
            {label(tool.args?.expected_version) ||
              label(tool.args?.version) ||
              "Version in exact preview"}
          </p>
        )}
        {items(preview.files).map((value, i) => {
          const file = record(value);
          return (
            <p key={i}>
              {label(file.filename)} <small>{label(file.version)}</small>
              {label(file.document_id) && (
                <code className="assistant-file-identity">
                  {label(file.document_id)}
                </code>
              )}
            </p>
          );
        })}
        {items(preview.changes).map((value, i) => {
          const change = record(value);
          const before = record(change.before),
            after = record(change.after);
          return (
            <p key={i}>
              {label(change.filename) ||
                label(before.filename) ||
                label(after.filename)}
              :{" "}
              {typeof change.before === "string"
                ? change.before || "(empty)"
                : label(before.filename) || "New file"}{" "}
              →{" "}
              {typeof change.after === "string"
                ? change.after || "(empty)"
                : label(after.filename)}
              {after.size !== undefined && (
                <small> · {label(after.size)} bytes</small>
              )}
            </p>
          );
        })}
        {preview.proposal !== undefined && (
          <blockquote>{label(record(preview.proposal).excerpt)}</blockquote>
        )}
        {preview.finding !== undefined && (
          <p>{label(record(preview.finding).claim)}</p>
        )}
        <details>
          <summary>Preview exact changes</summary>
          <pre>{JSON.stringify(preview, null, 2)}</pre>
        </details>
        {pending && (
          <div className="assistant-approval-actions">
            <button
              type="button"
              disabled={disabled}
              onClick={() => decide(tool.id, false)}
            >
              Deny
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={() => decide(tool.id, true)}
            >
              Approve
            </button>
          </div>
        )}
        {children}
      </div>
    </DefaultCard>
  );
}
