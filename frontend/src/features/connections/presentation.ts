import type { Doc, Link } from "../../shared/api/client";
import { overviewPath } from "../library/presentation";

export function mapGroup(doc: Doc, scope?: string) {
  const path = doc.folder || "";
  return scope !== undefined &&
    path !== scope &&
    (!scope || !path.startsWith(scope + " / "))
    ? overviewPath(path)
    : overviewPath(path, scope);
}

/** Never draw a relationship against a different version of either endpoint. */
export function currentMapLinks(docs: Doc[], links: Link[]) {
  const versions = new Map(docs.map((d) => [d.document_id, d.version]));
  const seen = new Set<string>();
  return links.filter((l) => {
    const key = [
      l.source_document_id,
      l.source_version,
      l.document_id,
      l.version,
      l.relation,
      l.source_chunk_id,
      l.target_chunk_id,
    ].join(":");
    if (
      seen.has(key) ||
      versions.get(l.source_document_id) !== l.source_version ||
      versions.get(l.document_id) !== l.version
    )
      return false;
    seen.add(key);
    return true;
  });
}

export function mapSample(
  docs: Doc[],
  count: number,
  selected?: string,
  link?: Link,
) {
  const important = new Set([
    selected,
    link?.source_document_id,
    link?.document_id,
  ]);
  return [
    ...docs.filter((d) => important.has(d.document_id)),
    ...docs.filter((d) => !important.has(d.document_id)),
  ].slice(0, count);
}

/** Keep returned relationships inspectable even when the other endpoint is outside the map. */
export function selectedMapLinks(selected: Doc, links: Link[]) {
  return links.filter(
    (l) =>
      (l.source_document_id === selected.document_id &&
        l.source_version === selected.version) ||
      (l.document_id === selected.document_id &&
        l.version === selected.version),
  );
}
