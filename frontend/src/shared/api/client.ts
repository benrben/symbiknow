import { useSyncExternalStore } from "react";
import type { Doc, Evidence, Link, Library, CardPreview } from "./contracts.generated.ts";
export type {
  OrganizationDecision, JevDecisionQueue, DocumentReference, EvidenceReference, ProcessingDescriptor, RevisionToken,
  Evidence, SearchAnswer, Link, Doc, Library, Detail, Rebuild, CardPreview,
  SearchResponse, VersionsPage, LinkEvidence,
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
        empty: "Stored · Empty / no extracted content",
        unsupported: "Stored · Unsupported format · Download available",
        failed: "Stored · Indexing failed",
        disabled: "Stored · Indexing disabled",
      } as Record<string, string>
    )[status || "pending"] || "Stored"
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
const inFlight = new Map<string, Promise<unknown>>();
let retainedBytes = 0;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export function invalidateResponses(revision: string = crypto.randomUUID()) {
  if (revision === readRevision) return;
  readRevision = revision;
  readEpoch += 1;
  responses.clear();
  retainedBytes = 0;
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
  const operation = action.split("?")[0];
  const post = args !== undefined;
  const read = !post || ["search", "ask", "statuses"].includes(operation);
  const files = (args as { files?: { final?: boolean; total_size?: number }[] } | undefined)?.files;
  const mayPublish = post && !["search", "statuses", "bulk-download", "rebuild"].includes(operation)
    && (operation !== "upload" || !!files?.some((file) => file.total_size === undefined || file.final === true));
  if (mayPublish) invalidateResponses();
  const key = JSON.stringify([readRevision, action, canonicalRequest(args)]);
  const cacheable = !post && /^(card|document)\?/.test(action);
  const retained = cacheable && responses.get(key);
  if (retained && retained.until > Date.now()) return abortable(Promise.resolve(structuredClone(retained.value) as T), signal);
  const existing = read && inFlight.get(key);
  if (existing) return abortable(existing as Promise<T>, signal).then((value) => structuredClone(value));
  if (read && inFlight.size >= 128) throw new Error("Too many pending library reads; retry shortly");
  const revision = readRevision;
  const epoch = readEpoch;
  const work = (async () => {
    const response = await fetch("/api/" + action, {
      // Coalesced consumers cancel their own wait; the shared request completes.
      ...(!read ? { signal } : {}),
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
    const value = await response.json();
    if (cacheable && revision !== readRevision)
      throw new DOMException("Library revision changed", "AbortError");
    if (read) observeRevision(value, epoch);
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
    inFlight.set(key, work);
    work.then(() => inFlight.delete(key), () => inFlight.delete(key));
  }
  if (mayPublish) work.then(() => invalidateResponses(), () => invalidateResponses());
  return abortable(work, signal).then((value) => structuredClone(value));
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
  let result: Doc | undefined;
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
      { files: (Doc & { error?: string; stored: boolean })[] } | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        reply = await api("upload", { files: [args] });
        break;
      } catch (e) {
        if (attempt) throw e;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
    const item = reply!.files[0];
    if (item.error) throw new Error(item.error);
    if (item.stored) result = item;
    onProgress(
      Math.round(((offset + bytes.length) / Math.max(file.size, 1)) * 100),
    );
    if (!file.size) break;
  }
  return result!;
}
