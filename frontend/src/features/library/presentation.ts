import type { Evidence } from "../../shared/api/client";

/** Folder totals come from the scope aggregate, never the loaded document page. */
export function overviewPath(path: string, scope?: string): string {
  if (scope === undefined) return path.split(" / ")[0];
  if (!scope || path === scope) return scope;
  return scope + " / " + path.slice(scope.length + 3).split(" / ")[0];
}

export function overviewFolders(
  leaves: Record<string, number>,
  scope?: string,
) {
  const groups = new Map<string, number>();
  for (const [path, count] of Object.entries(leaves)) {
    if (
      count <= 0 ||
      (scope !== undefined &&
        path !== scope &&
        (!scope || !path.startsWith(scope + " / ")))
    )
      continue;
    const key = overviewPath(path, scope);
    groups.set(key, (groups.get(key) || 0) + count);
  }
  return [...groups].sort(([a], [b]) =>
    !a ? 1 : !b ? -1 : a.localeCompare(b),
  );
}

/** Remove known introductory metadata, preserving actual source prose verbatim. */
export function browseExcerpt(evidence: Evidence[]) {
  const candidates = evidence
    .filter((e) => e.text)
    .map((e) => {
      const headings = e.provenance?.headings || [];
      const heading = headings.at(-1) || "";
      const text = e.text
        .split("\n")
        .filter((line) => {
          const plain = line.replace(/^#+\s*/, "").trim();
          return (
            !headings.includes(plain) &&
            !/^(Knowledge-base entry\.?\s*(Snapshot:.*)?|Snapshot:.*|Tags:.*|Last updated:.*|Newest first\.?)$/i.test(
              plain,
            )
          );
        })
        .join("\n")
        .trim();
      return { text, heading };
    });
  // A meaningful second passage is more useful than a metadata-only introduction.
  return (
    candidates.find((c) => c.text.length >= 60) ||
    candidates.find((c) => c.text.length > 0) || { text: "", heading: "" }
  );
}

export function reviewMetrics(job: {
  completed: number;
  failed: number;
  skipped: number;
  grouping: boolean;
  grouped?: number | null;
  unfiled?: number | null;
  links_added?: number | null;
}) {
  const parts = [`${job.completed} reviewed`];
  const known = (n: unknown): n is number =>
    typeof n === "number" && Number.isFinite(n);
  if (job.grouping && known(job.grouped)) parts.push(`${job.grouped} grouped`);
  if (known(job.unfiled) && job.unfiled > 0)
    parts.push(`${job.unfiled} need a folder`);
  if (known(job.links_added)) parts.push(`${job.links_added} links added`);
  if (job.skipped > 0) parts.push(`${job.skipped} skipped`);
  if (job.failed > 0) parts.push(`${job.failed} failed`);
  return parts.join(" · ");
}

/** Omit a repeated project prefix in UI titles when the folder already supplies it. */
export function contextualTitle(filename: string, folder?: string) {
  const name = filename.replace(/\.[^.]+$/, "");
  const prefix = (folder || "").split(" / ")[0];
  return prefix && name.toLowerCase().startsWith(prefix.toLowerCase() + " ")
    ? name.slice(prefix.length + 1)
    : name;
}
