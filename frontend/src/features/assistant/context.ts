export type ContextPolicy = {
  open_document: boolean;
  selection: boolean;
  scope: boolean;
  results: boolean;
};

export const defaultContextPolicy: ContextPolicy = {
  open_document: true,
  selection: true,
  scope: true,
  results: true,
};

const fields: Record<keyof ContextPolicy, string[]> = {
  open_document: ["open_document", "reader_tab", "reader_expanded"],
  selection: ["selection", "selection_documents"],
  scope: ["scope", "folder", "group", "project", "folders", "groups"],
  results: [
    "query",
    "mode",
    "view",
    "sort",
    "descending",
    "ready",
    "surface",
    "visible_documents",
    "visible_documents_truncated",
    "loaded_document_count",
  ],
};

/** One policy applies to connection, messages, reconnects and browser replies. */
export function filterContext(
  value: Record<string, unknown>,
  policy: ContextPolicy,
) {
  const result: Record<string, unknown> = { context_policy: { ...policy } };
  for (const category of Object.keys(fields) as (keyof ContextPolicy)[])
    if (policy[category])
      for (const key of fields[category])
        if (value[key] !== undefined) result[key] = value[key];
  return result;
}

export function filterCommandResult(
  value: Record<string, unknown>,
  policy: ContextPolicy,
) {
  if (
    !value.state ||
    typeof value.state !== "object" ||
    Array.isArray(value.state)
  )
    return value;
  return {
    ...value,
    state: filterContext(value.state as Record<string, unknown>, policy),
  };
}
