import { useEffect, useRef, useState } from "react";
import { api, indexingLabel, invalidateResponses, uploadFile, type Detail, type Doc,
  type Library, type UploadReceipt, type UploadWarning } from "../../shared/api/client";

export type Transfer = {
  file: File;
  id: string;
  percent: number;
  state: string;
  error?: string;
  actionError?: string;
  actionBusy?: boolean;
  options?: { id: string; expected: string };
  document?: UploadReceipt;
  historical?: boolean;
};

/** Owns upload receipts, stable retry identities and current-head indexing polls. */
export function useTransfers(options: {
  limits: Pick<Library, "max_file_bytes" | "max_chunk_bytes">;
  onStored: (doc: Doc, updating: boolean) => Promise<void>;
  onOpen: (doc: Doc) => void;
}) {
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const latest = useRef(options);
  latest.current = options;
  const queue = useRef(Promise.resolve());
  const actions = useRef(new Set<string>());
  const patch = (id: string, value: Partial<Transfer>) =>
    setTransfers(rows => rows.map(row => row.id === id ? { ...row, ...value } : row));

  async function transfer(item: Transfer) {
    patch(item.id, { error: undefined, actionError: undefined, state: "Uploading" });
    let doc: UploadReceipt;
    try {
      doc = await uploadFile(item.file, percent => patch(item.id, { percent }),
        { requestId: item.id, ...item.options }, latest.current.limits);
    } catch (error) {
      patch(item.id, { state: "Failed", error: (error as Error).message });
      return;
    }
    patch(item.id, { document: doc, percent: 100, state: indexingLabel(doc.status) });
    try {
      await latest.current.onStored(doc, !!item.options);
    } catch (error) {
      patch(item.id, { actionError: `File stored. Library refresh failed: ${(error as Error).message}` });
    }
  }
  function enqueue(items: Transfer[]) {
    queue.current = queue.current.then(async () => {
      for (const item of items) await transfer(item);
    });
  }
  function addFiles(files: File[], updating?: Doc) {
    const items: Transfer[] = files.map(file => ({
      file, id: crypto.randomUUID(), percent: 0, state: "Queued",
      options: updating ? { id: updating.document_id, expected: updating.version } : undefined,
    }));
    setTransfers(rows => [...rows, ...items]);
    enqueue(items);
  }
  function retry(item: Transfer) {
    patch(item.id, { state: "Queued", error: undefined });
    enqueue([item]);
  }
  async function existing(item: Transfer, warning: UploadWarning, updating: boolean) {
    if (actions.current.has(item.id)) return;
    actions.current.add(item.id);
    patch(item.id, { actionBusy: true, actionError: undefined });
    try {
      // Explicit update targets use fresh metadata, never the warning's old head.
      invalidateResponses();
      const { document: doc } = await api<Detail>(
        `document?id=${encodeURIComponent(warning.document_id)}&section=summary`);
      if (updating) addFiles([item.file], doc);
      else latest.current.onOpen(doc);
    } catch (error) {
      patch(item.id, { actionError: (error as Error).message });
    } finally {
      actions.current.delete(item.id);
      patch(item.id, { actionBusy: false });
    }
  }

  // Poll readiness data, never display copy. A stored receipt can precede its
  // first status record; unknown is not evidence that indexing has completed.
  const pendingIds = transfers.filter(t => t.document && !t.error && !t.historical &&
    !["indexed", "empty", "unsupported", "failed", "disabled"].includes(t.document.status || ""))
    .map(t => t.id).join(",");
  useEffect(() => {
    if (!pendingIds) return;
    const controller = new AbortController();
    const pending = transfers.filter(t => pendingIds.split(",").includes(t.id));
    let busy = false;
    const poll = async () => {
      if (busy || document.hidden) return;
      busy = true;
      try {
        const result = await api<{ documents: Record<string, Doc> }>("statuses", {
          document_ids: pending.map(t => t.document!.document_id),
        }, controller.signal);
        if (!controller.signal.aborted) setTransfers(rows => rows.map(item => {
          const row = item.document && result.documents[item.document.document_id];
          return row ? { ...item, document: { ...item.document!, status: row.status },
            historical: row.version !== item.document!.version,
            state: row.version === item.document!.version
            ? indexingLabel(row.status) : "Stored · Historical version" } : item;
        }));
      } catch { /* Keep the stored receipt; the next poll retries status. */ }
      finally { busy = false; }
    };
    void poll();
    const interval = setInterval(() => void poll(), 4000);
    return () => { controller.abort(); clearInterval(interval); };
  }, [pendingIds]);

  return { transfers, addFiles, retry,
    forgetDocument: (id: string) => setTransfers(rows => rows
      .filter(row => row.document?.document_id !== id)
      .map(row => row.document ? { ...row, document: { ...row.document,
        warnings: row.document.warnings?.filter(warning => warning.document_id !== id) } } : row)),
    dismiss: (id: string) => setTransfers(rows => rows.filter(row => row.id !== id)),
    openExisting: (item: Transfer, warning: UploadWarning) => existing(item, warning, false),
    updateExisting: (item: Transfer, warning: UploadWarning) => existing(item, warning, true),
  };
}
