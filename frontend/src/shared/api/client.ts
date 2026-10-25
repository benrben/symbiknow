import type { JobResponse } from "./contracts.generated";
import { useSyncExternalStore } from "react";
import type { Doc, Evidence, Link, Library, CardPreview } from "./contracts.generated.ts";
export type {
  OrganizationDecision, JevDecisionQueue, DocumentReference, EvidenceReference, ProcessingDescriptor, RevisionToken,
  Evidence, SearchAnswer, Link, Doc, Library, Detail, Rebuild, CardPreview,
  SearchResponse, VersionsPage, LinkEvidence,
  InventoryDocument, InventoryPage, TaxonomyFacet, TaxonomyPage, OrganizationHistoryPage,
} from "./contracts.generated.ts";

export function folderCounts(leaves: Record<string, number>) {
  const counts: Record<string, number> = {};
  for (const [path, count] of Object.entries(leaves)) {
    const parts = path.split(" / ");
    for (let i = 1; i <= parts.length; i++) {
      const parent = parts.slice(0, i).join(" / ");
      counts[parent] = (counts[parent] || 0) + count;
    }
  }
  return counts;
}
export function linkKey(link: Link) {
  const endpoints = [
    [link.source_document_id, link.source_version],
    [link.document_id, link.version],
  ];
  if (["related", "duplicate"].includes(link.relation))
    endpoints.sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b)),
    );
  return JSON.stringify([link.relation, endpoints]);
}
export function uniqueLinks(links: Link[]) {
  return [...new Map(links.map((link) => [linkKey(link), link])).values()];
}
export function indexingLabel(status?: string) {
  return (
    (
      {
        indexed: "Stored · Searchable",
        pending: "Stored · Indexing queued",
        queued: "Stored · Indexing queued",
        indexing: "Stored · Indexing in progress",
        unregistered: "Stored · Not yet registered for search",
        empty: "Stored · Empty / no extracted content",
        unsupported: "Stored · Unsupported format · Download available",
        failed: "Stored · Indexing failed",
        disabled: "Stored · Indexing disabled",
      } as Record<string, string>
    )[status || ""] || "Stored · Search status not reported"
  );
}
// One bounded data owner for all component reads. Revisions include same-head
// extraction changes; response text stays in memory and never localStorage.
let readRevision = "";
let readEpoch = 0;
const revisionListeners = new Set<() => void>();
export function useDataRevision() {
  return useSyncExternalStore(
    (listener) => { revisionListeners.add(listener); return () => revisionListeners.delete(listener); },
    () => readRevision,
  );
}
const responses = new Map<string, { value: unknown; bytes: number; until: number }>();
type SharedRequest = { promise: Promise<unknown>; controller: AbortController; consumers: number; settled: boolean };
const inFlight = new Map<string, SharedRequest>();
let retainedBytes = 0;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const librarySnapshots = new Map<string, { value: Library; bytes: number }>();
let librarySnapshotBytes = 0;
const MAX_LIBRARY_SNAPSHOT_BYTES = 4 * 1024 * 1024;
function librarySnapshotKey(action: string) {
  const [operation, query = ""] = action.split("?", 2);
  if (operation !== "library") return undefined;
  const parameters = new URLSearchParams(query);
  parameters.sort();
  return JSON.stringify([readRevision, parameters.toString()]);
}
/** A revision-bound display snapshot only. Call api() to refresh every visit. */
export function peekCachedLibrary(action: string): Library | undefined {
  const key = librarySnapshotKey(action);
  const snapshot = key && librarySnapshots.get(key);
  if (!snapshot) return undefined;
  librarySnapshots.delete(key!);
  librarySnapshots.set(key!, snapshot);
  return structuredClone(snapshot.value);
}
function retainLibrary(action: string, value: Library) {
  if (!value.library_id || value.index_revision === undefined
      || value.organization_revision === undefined || value.manual_revision === undefined) return;
  const key = librarySnapshotKey(action);
  if (!key) return;
  const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (bytes > MAX_LIBRARY_SNAPSHOT_BYTES / 4) return;
  const previous = librarySnapshots.get(key);
  if (previous) librarySnapshotBytes -= previous.bytes;
  librarySnapshots.delete(key);
  librarySnapshots.set(key, { value: structuredClone(value), bytes });
  librarySnapshotBytes += bytes;
  while (librarySnapshots.size > 16 || librarySnapshotBytes > MAX_LIBRARY_SNAPSHOT_BYTES) {
    const oldest = librarySnapshots.keys().next().value!;
    librarySnapshotBytes -= librarySnapshots.get(oldest)!.bytes;
    librarySnapshots.delete(oldest);
  }
}
export function invalidateResponses(revision: string = crypto.randomUUID()) {
  if (revision === readRevision) return;
  readRevision = revision;
  readEpoch += 1;
  responses.clear();
  retainedBytes = 0;
  librarySnapshots.clear();
  librarySnapshotBytes = 0;
  revisionListeners.forEach((listener) => listener());
}
function observeRevision(value: unknown, epoch: number) {
  const result = value as Partial<Library>;
  if (result?.library_id && result.index_revision !== undefined) {
    const revision = JSON.stringify([
      result.library_id, result.index_revision,
      result.organization_revision, result.manual_revision,
    ]);
    if (epoch !== readEpoch && revision !== readRevision)
      throw new DOMException("Library revision changed", "AbortError");
    invalidateResponses(revision);
  }
}
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
function consume<T>(request: SharedRequest, signal?: AbortSignal): Promise<T> {
  request.consumers++;
  return abortable(request.promise as Promise<T>, signal).then(value => structuredClone(value)).finally(() => {
    request.consumers--;
    if (!request.consumers && !request.settled) request.controller.abort();
  });
}
export type Job<T> = Omit<JobResponse, "result"> & { result?: T };
export async function waitForJob<T>(job: Job<T>, signal?: AbortSignal, progress?: (value: T) => void): Promise<T> {
  let delay = 25;
  for (;;) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (job.status === "completed" && job.result === undefined) {
      job = await api<Job<T>>("job?id=" + encodeURIComponent(job.job_id), undefined, signal);
      continue;
    }
    if (job.result) progress?.(job.result);
    if (job.status === "completed") return job.result as T;
    if (job.status === "failed") throw new Error(job.error || "Job failed");
    await abortable(new Promise(resolve => setTimeout(resolve, delay)), signal);
    delay = Math.min(3000, delay * 2);
    job = await api<Job<T>>("job?id=" + encodeURIComponent(job.job_id), undefined, signal);
  }
}
function canonicalRequest(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalRequest);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonicalRequest(item)]));
  return value;
}
export async function api<T>(
  action: string,
  args?: object,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const operation = action.split("?")[0];
  const post = args !== undefined;
  const read = !post || ["search", "ask", "statuses"].includes(operation);
  const files = (args as { files?: { final?: boolean; total_size?: number }[] } | undefined)?.files;
  const mayPublish = post && !["search", "statuses", "bulk-download", "rebuild", "agent-models", "agent-sessions"].includes(operation)
    && (operation !== "upload" || !!files?.some((file) => file.total_size === undefined || file.final === true));
  if (mayPublish) invalidateResponses();
  const key = JSON.stringify([readRevision, action, canonicalRequest(args)]);
  const cacheable = !post && /^(card|document)\?/.test(action);
  const retained = cacheable && responses.get(key);
  if (retained && retained.until > Date.now()) return abortable(Promise.resolve(structuredClone(retained.value) as T), signal);
  const existing = read && inFlight.get(key);
  if (existing && !existing.controller.signal.aborted) return consume<T>(existing, signal);
  if (read && inFlight.size >= 128) throw new Error("Too many pending library reads; retry shortly");
  const revision = readRevision;
  const epoch = readEpoch;
  const controller = new AbortController();
  const shared: SharedRequest = { controller, consumers: 0, settled: false, promise: Promise.resolve() };
  const work = (async () => {
    const response = await fetch("/api/" + action, {
      signal: read ? controller.signal : signal,
      ...(args ? {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Symbiknow-UI": "1" },
        body: JSON.stringify(args),
      } : {}),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: "Request failed" }));
      throw new Error(error.error);
    }
    let value = await response.json();
    // Search displays retrieval progress explicitly. Mutations retain their
    // existing result contract while the server performs them as durable jobs.
    if (value?.job_id && operation !== "job" && !["search", "ask"].includes(operation))
      value = await waitForJob(value, read ? controller.signal : signal);
    if (read && controller.signal.aborted)
      throw new DOMException("Aborted", "AbortError");
    if (cacheable && revision !== readRevision)
      throw new DOMException("Library revision changed", "AbortError");
    if (read) observeRevision(value, epoch);
    // observeRevision may have advanced the epoch: retain under the response's
    // observed revision, never the request's older namespace.
    if (!post && operation === "library") retainLibrary(action, value);
    if (cacheable && revision === readRevision) {
      const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
      if (bytes <= MAX_RESPONSE_BYTES / 4) {
        const old = responses.get(key);
        if (old) retainedBytes -= old.bytes;
        responses.delete(key);
        responses.set(key, { value, bytes, until: Date.now() + 1000 });
        retainedBytes += bytes;
        while (responses.size > 128 || retainedBytes > MAX_RESPONSE_BYTES) {
          const oldest = responses.keys().next().value!;
          retainedBytes -= responses.get(oldest)!.bytes;
          responses.delete(oldest);
        }
      }
    }
    return value as T;
  })();
  if (read) {
    shared.promise = work;
    inFlight.set(key, shared);
    const finish = () => { shared.settled = true; if (inFlight.get(key) === shared) inFlight.delete(key); };
    work.then(finish, finish);
  }
  if (mayPublish) work.then(() => invalidateResponses(), () => invalidateResponses());
  return read ? consume<T>(shared, signal) : abortable(work, signal).then((value) => structuredClone(value));
}
export const title = (d: Doc) => d.filename.replace(/\.[^.]+$/, "");
export const formatLabel = (d: Doc) =>
  d.filename.split(".").length > 1
    ? d.filename.split(".").at(-1)!.toUpperCase().slice(0, 12)
    : kind(d);
export function kind(d: Doc) {
  if (d.mime_type === "application/pdf") return "PDF";
  if (d.mime_type.startsWith("image/")) return "Image";
  if (/\.md$|markdown/.test(d.filename + " " + d.mime_type)) return "Markdown";
  if (/html/.test(d.mime_type)) return "HTML";
  if (/\.csv$/i.test(d.filename) || d.mime_type === "text/csv") return "CSV";
  if (/\.(docx?|odt|rtf)$/i.test(d.filename)) return "Word";
  return d.mime_type.startsWith("text/") ? "Text" : "File";
}
export const fileUrl = (d: Doc, download = false) =>
  `/api/${download ? "download" : "original"}?id=${encodeURIComponent(d.document_id)}&version=${encodeURIComponent(d.version)}`;
export function location(e: Evidence) {
  const page = e.provenance.page ?? e.provenance.pages?.[0]?.page_no;
  return page
    ? `Page ${page}`
    : e.provenance.headings?.join(" › ") || "Passage";
}
export function hashFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./hash.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = ({ data }) => {
      worker.terminate();
      if (data.error) reject(new Error(data.error));
      else resolve(data.digest);
    };
    worker.onerror = () => {
      worker.terminate();
      reject(new Error("File hashing failed"));
    };
    worker.postMessage(file);
  });
}

export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const left = Object.entries(a),
    right = Object.entries(b);
  return (
    left.length === right.length &&
    left.every(
      ([key, value]) =>
        Object.prototype.hasOwnProperty.call(b, key) &&
        sameValue(value, (b as Record<string, unknown>)[key]),
    )
  );
}

export type UploadWarning = {
  code: string;
  document_id: string;
  version: string;
  filename: string;
  reason: string;
  message?: string;
};
export type UploadReceipt = Doc & { stored: boolean; warnings?: UploadWarning[]; error?: string };

export async function uploadFile(
  file: File,
  onProgress: (n: number) => void,
  options: { id?: string; expected?: string; requestId?: string } = {},
  limits = { max_file_bytes: 268435456, max_chunk_bytes: 262144 },
) {
  if (file.size > limits.max_file_bytes)
    throw new Error(
      `File exceeds ${limits.max_file_bytes / 1048576} MiB limit`,
    );
  const hash = await hashFile(file);
  const request_id = options.requestId || crypto.randomUUID();
  let result: UploadReceipt | undefined;
  for (
    let offset = 0;
    offset < file.size || offset === 0;
    offset += limits.max_chunk_bytes
  ) {
    const bytes = new Uint8Array(
      await file.slice(offset, offset + limits.max_chunk_bytes).arrayBuffer(),
    );
    let raw = "";
    for (let i = 0; i < bytes.length; i += 8192)
      raw += String.fromCharCode(...bytes.subarray(i, i + 8192));
    const args = {
      filename: file.name,
      mime_type: file.type || undefined,
      request_id,
      document_id: options.id,
      expected_version: options.expected,
      content_base64: btoa(raw),
      offset,
      total_size: file.size,
      sha256: hash,
      final: offset + bytes.length === file.size,
    };
    // Retry the identical chunk/request receipt after a transient lost response.
    let reply:
      { files: UploadReceipt[] } | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        reply = await api("upload", { files: [args] });
        break;
      } catch (e) {
        if (attempt) throw e;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
    let item = reply!.files[0];
    if ((item as unknown as Job<Doc>).job_id) item = await waitForJob(item as unknown as Job<typeof item>);
    if (item.error) throw new Error(item.error);
    if (item.stored) result = item;
    onProgress(
      Math.round(((offset + bytes.length) / Math.max(file.size, 1)) * 100),
    );
    if (!file.size) break;
  }
  if (!result) throw new Error("Upload finished without a stored receipt; retry to check the same upload.");
  return result;
}

/** Tokens stay in memory and WebSocket subprotocol headers, never in URLs. */
export function assistantSocket(session: { session_id: string; token: string }): WebSocket {
  const url = new URL(`/api/agent-chat/${encodeURIComponent(session.session_id)}`, window.location.href);
  url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return new WebSocket(url, ["symbiknow-assistant", `token.${session.token}`]);
}

export async function prepareOriginal(doc: Doc, signal?: AbortSignal) {
  await api("original-ready?id=" + encodeURIComponent(doc.document_id) + "&version=" + encodeURIComponent(doc.version), undefined, signal);
}
/** Read ready originals in one round trip; prepare only when the server asks. */
export async function readOriginalText(doc: Doc, signal?: AbortSignal) {
  const limit = 2 * 1024 * 1024;
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(fileUrl(doc), { signal });
    if (response.status === 202) {
      await waitForJob(await response.json() as Job<unknown>, signal);
      continue;
    }
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.error || "Preview unavailable");
    }
    if (Number(response.headers.get("Content-Length")) > limit) {
      await response.body?.cancel();
      throw new Error("This text file is too large for an inline preview. Download the original to read it.");
    }
    // Enforce the preview bound even when the server streams without a length.
    const reader = response.body?.getReader();
    if (!reader) return "";
    const decoder = new TextDecoder();
    const parts: string[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return parts.join("") + decoder.decode();
        bytes += chunk.value.byteLength;
        if (bytes > limit) {
          await reader.cancel();
          throw new Error("This text file is too large for an inline preview. Download the original to read it.");
        }
        parts.push(decoder.decode(chunk.value, { stream: true }));
      }
    } finally { reader.releaseLock(); }
  }
  throw new Error("Original preparation did not finish. Retry the preview or download the original.");
}
export async function downloadOriginal(doc: Doc) {
  await prepareOriginal(doc);
  window.location.assign(fileUrl(doc, true));
}
