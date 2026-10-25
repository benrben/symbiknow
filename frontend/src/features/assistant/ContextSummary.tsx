import { useState } from "react";
import { items, label, record } from "./core/cards";
import { type ContextPolicy, defaultContextPolicy } from "./context";

function DocumentIdentity({ value }: { value: unknown }) {
  const document = record(value);
  return (
    <span>
      {label(document.title) || "File"} ·{" "}
      {label(document.version) || "Version not loaded"}
      <code>{label(document.document_id)}</code>
    </span>
  );
}

export function ContextSummary({
  context,
  policy,
  update,
  connected,
}: {
  context: Record<string, unknown>;
  policy: ContextPolicy;
  update: (policy: ContextPolicy) => void;
  connected: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const documents = items(context.visible_documents),
    selected = items(context.selection_documents);
  const included = Object.values(policy).some(Boolean);
  return (
    <details
      className="assistant-context-review"
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>
        Context for this chat · {included ? `${Object.values(policy).filter(Boolean).length} of 4 sources shared` : "Nothing shared"}
      </summary>
      <div className="assistant-context-body">
        <p role="status">
          {connected
            ? "Current context is sent to this session when it changes."
            : "This context will be sent when you connect."}
        </p>
        <p>
          Metadata only. No file contents or evidence passages are attached. The
          agent can request library content through its tools.
        </p>
        <p>
          <small>
            Changes apply to future context. They do not erase earlier context
            or restrict the agent’s library tools.
          </small>
        </p>
        <fieldset>
          <legend>Include with this chat</legend>
          {(
            [
              ["open_document", "Open file"],
              ["selection", "Selected files"],
              ["scope", "Folder, topic and project scope"],
              ["results", "Query and loaded results"],
            ] as const
          ).map(([key, name]) => (
            <label key={key}>
              <input
                type="checkbox"
                checked={policy[key]}
                onChange={(event) =>
                  update({ ...policy, [key]: event.target.checked })
                }
              />
              {name}
            </label>
          ))}
        </fieldset>
        {!included && (
          <p>
            No current view metadata is shared. Clearing does not erase context
            already sent or restrict the agent’s library tools.
          </p>
        )}
        {policy.open_document && (
          <p>
            <strong>Open file: </strong>
            {context.open_document ? (
              <DocumentIdentity value={context.open_document} />
            ) : (
              "None"
            )}
          </p>
        )}
        {policy.selection && (
          <div>
            <strong>Selected files: {items(context.selection).length}</strong>
            {selected.length > 0 && (
              <ul>
                {selected.map((value, index) => (
                  <li key={index}>
                    <DocumentIdentity value={value} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <details>
          <summary>Inspect context sent by this browser</summary>
          <pre>{JSON.stringify(context, null, 2)}</pre>
        </details>
        {policy.scope && (
          <p>
            <strong>Scope: </strong>
            {context.scope === "unfiled"
              ? "Unfiled"
              : label(context.folder) ||
                (context.scope === "recent" ? "Recent" : "All files")}
            {label(context.group) && (
              <span> · Topic: {label(context.group)}</span>
            )}
            {label(context.project) && (
              <span> · Project: {label(context.project)}</span>
            )}
            <small>Available folder/topic names are also included.</small>
          </p>
        )}
        {policy.results && (
          <div>
            <p>
              <strong>Query: </strong>
              {label(context.query) || "None · browsing"}
            </p>
            <p>
              {label(context.loaded_document_count) || "0"} files loaded ·{" "}
              {documents.length} file identities sent
              {context.visible_documents_truncated === true &&
                " · First 50 only"}
            </p>
            {context.ready === false && (
              <p>View is loading; results are not yet available.</p>
            )}
            {documents.length > 0 && (
              <details>
                <summary>Inspect sent file identities</summary>
                <ul>
                  {documents.map((value, index) => (
                    <li key={index}>
                      <DocumentIdentity value={value} />
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
        <div className="assistant-context-actions">
          <button
            type="button"
            onClick={() =>
              update({
                open_document: false,
                selection: false,
                scope: false,
                results: false,
              })
            }
          >
            Clear chat context
          </button>
          <button
            type="button"
            onClick={() => update({ ...defaultContextPolicy })}
          >
            Use current view
          </button>
        </div>
      </div>
    </details>
  );
}
