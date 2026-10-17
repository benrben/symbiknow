export type Evidence = {
  evidence_id: string;
  text: string;
  basis: string;
  provenance: {
    page?: number;
    pages?: { page_no?: number }[];
    headings?: string[];
  };
};
export type Link = {
  document_id: string;
  version: string;
  source_version: string;
  relation: string;
  source_chunk_id: string;
  target_chunk_id: string;
  source_document_id: string;
  source_filename: string;
  target_filename: string;
};
export type Doc = {
  document_id: string;
  version: string;
  filename: string;
  mime_type: string;
  folder?: string;
  groups?: string[];
  status?: string;
  organization_status?: string;
  size?: number;
  created_at?: string;
  index_error?: string;
  evidence?: Evidence[];
  excerpt?: string;
  links?: Link[];
  jev?: {
    status: string;
    label?: string;
    model_label?: string;
    model_confidence?: number;
    confidence_meaning?: string;
    policy_label?: string;
    decision_reason?: string;
    policy_version?: string;
    prompt_version?: string;
    basis?: string[] | string;
    supporting_chunk_ids?: string[];
    conflicting_chunk_ids?: string[];
    possible_conflicting_chunk_ids?: string[];
    coverage?: string;
    evidence_presence?: string;
    conflict_status?: string;
    premise_correction_status?: string;
    evidence_disagreement?: string;
    disagreement_chunk_ids?: string[];
    disagreement_scope?: string;
    cross_document_assessment_status?: string;
    possible_conflict_reasons?: Record<string, string>;
    evaluated_evidence?: {
      chunk_id: string;
      text: string;
      text_start?: number;
      text_end?: number;
      truncated?: boolean;
      location?: Evidence["provenance"];
    }[];
    explanation?: string;
  };
};
export type Library = {
  organization_reset?: { revision: string; scope: string | null };
  manual_revision?: string;
  library_id?: string;
  library_total?: number;
  unfiled_review_count?: number;
  processing_states?: Record<string, number>;
  organization_change?: {
    kind: string;
    paths?: { from: string; to: string };
    document_ids: string[];
  };
  organization_revision?: string;
  index_revision?: string;
  documents: Doc[];
  total: number;
  has_more: boolean;
  folders: Record<string, number>;
  scoped_folders?: Record<string, number>;
  groups: string[];
  processing: boolean;
  max_file_bytes: number;
  max_chunk_bytes: number;
};
export type Detail = {
  indexing_error?: string;
  organization_review?: Record<string, unknown> | null;
  document: Doc;
  current_version: string;
  organization: Doc | null;
  evidence: Evidence[];
  connections: Link[];
  versions: Doc[];
};
export type Rebuild = {
  mode?: "reset" | "unfiled" | "links";
  current_filename?: string;
  activity?: string;
  phase?: string;
  layout_revision?: string;
  layout_scope?: string | null;
  status: string;
  request_id: string;
  total: number;
  completed: number;
  failed: number;
  skipped: number;
  grouped?: number;
  unfiled?: number;
  links_added?: number;
  details: {
    document_id: string;
    filename: string;
    outcome: string;
    reason: string;
  }[];
  failures: Record<string, string>;
  folder: string | null;
  grouping: boolean;
  links: boolean;
};
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
export async function api<T>(
  action: string,
  args?: object,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch("/api/" + action, {
    signal,
    ...(args
      ? {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Symbiknow-UI": "1",
          },
          body: JSON.stringify(args),
        }
      : {}),
  });
  if (!response.ok) {
    const error = await response
      .json()
      .catch(() => ({ error: "Request failed" }));
    throw new Error(error.error);
  }
  return response.json();
}
export const title = (d: Doc) => d.filename.replace(/\.[^.]+$/, "");
export const formatLabel = (d: Doc) =>
  d.filename.split(".").length > 1
    ? d.filename.split(".").at(-1)!.toUpperCase().slice(0, 12)
    : kind(d);
export type CardPreview = { evidence: Evidence[]; table?: string[][] };
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
