import { useState, type MouseEvent } from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { FileCheck2, CircleDashed, TriangleAlert, CircleHelp, Image as ImageIcon, MoreHorizontal, ArrowUp, ArrowDown, CheckSquare, Eye } from "lucide-react";
import { DocumentIcon as FileText } from "../../../shared/components/KnowledgeIcons";
import {
  title,
  kind,
  formatLabel,
  indexingLabel,
  fileUrl,
  type Doc,
} from "../../../shared/api/client";
import ContentCard from "./ContentCard";
export function Judgment({
  doc,
  evaluate,
  unavailable,
  onEvidence,
}: {
  doc: Doc;
  evaluate: boolean;
  unavailable?: boolean;
  onEvidence?: () => void;
}) {
  const j = doc.jev,
    visual = doc.evidence?.length && !doc.evidence.some((e) => e.text);
  if (visual)
    return (
      <span
        className="judgment muted"
        data-decision="visual_not_checked"
        role={onEvidence ? "button" : undefined}
        tabIndex={onEvidence ? 0 : undefined}
        aria-label={
          onEvidence ? `View evidence for ${doc.filename}` : undefined
        }
        onClick={
          onEvidence
            ? (e) => {
                e.stopPropagation();
                onEvidence();
              }
            : undefined
        }
        onKeyDown={
          onEvidence
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  onEvidence();
                }
              }
            : undefined
        }
      >
        <ImageIcon size={14} />
        <span className="judgment-label">Visual match · Not checked</span>
      </span>
    );
  const supported =
    !!j?.supporting_chunk_ids?.length &&
    doc.evidence?.some(
      (e) => j.supporting_chunk_ids?.includes(e.evidence_id) && e.text,
    );
  const label =
    evaluate &&
    j?.status === "evaluated" &&
    (!["direct", "partial"].includes(j.label || "") || supported)
      ? j.label
      : undefined;
  const labels: Record<string, string> = {
    direct: "Supports answer",
    partial: "Partially supports",
    related: "Related",
    uncertain: "Needs context",
    unrelated: "Not relevant",
  };
  const unknownCoverage =
    evaluate &&
    j?.status === "evaluated" &&
    supported &&
    j.coverage === "unknown";
  const possibleConflict =
    evaluate &&
    j?.status === "evaluated" &&
    !!j.possible_conflicting_chunk_ids?.length;
  const disagreement =
    evaluate &&
    j?.status === "evaluated" &&
    ["accepted", "possible"].includes(j.evidence_disagreement || "");
  const conflict =
    evaluate && j?.status === "evaluated" && !!j.conflicting_chunk_ids?.length;
  return (
    <span
      role={onEvidence ? "button" : undefined}
      tabIndex={onEvidence ? 0 : undefined}
      aria-label={onEvidence ? `View evidence for ${doc.filename}` : undefined}
      aria-description={j?.explanation}
      onClick={
        onEvidence
          ? (e) => {
              e.stopPropagation();
              onEvidence();
            }
          : undefined
      }
      onKeyDown={
        onEvidence
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                onEvidence();
              }
            }
          : undefined
      }
      title={j?.explanation}
      data-decision={
        disagreement
          ? "evidence_disagreement"
          : conflict
            ? "conflict"
            : possibleConflict
              ? "possible_conflict"
              : unknownCoverage
                ? "supported_unknown"
                : label || "not_checked"
      }
      className={
        "judgment " +
        (disagreement || conflict || possibleConflict
          ? "uncertain"
          : label || "muted")
      }
    >
      {evaluate && (j?.status === "unavailable" || (unavailable && !j?.status)) ? (
        <CircleDashed size={14} aria-hidden="true" />
      ) : disagreement || conflict || possibleConflict ? (
        <TriangleAlert size={14} aria-hidden="true" />
      ) : unknownCoverage ? (
        <CircleHelp size={14} aria-hidden="true" />
      ) : label === "direct" ? (
        <FileCheck2 size={14} aria-hidden="true" />
      ) : label ? (
        <CircleHelp size={14} aria-hidden="true" />
      ) : (
        <CircleDashed size={14} aria-hidden="true" />
      )}
      <span className="judgment-label">
        {evaluate &&
        (j?.status === "unavailable" || (unavailable && !j?.status))
          ? "Not checked · Provider unavailable"
          : disagreement
            ? "Evidence disagrees"
            : conflict
              ? "Conflicts with premise"
              : possibleConflict
                ? "Possible conflict"
                : unknownCoverage
                  ? "Supports · Coverage unknown"
                  : label
                    ? labels[label]
                    : "Not checked"}
        {Array.isArray(j?.basis) && j.basis.includes("ocr")
          ? " · OCR evidence"
          : ""}
      </span>
    </span>
  );
}
export type SelectionEvent = Pick<
  MouseEvent,
  "metaKey" | "ctrlKey" | "shiftKey"
>;
export default function FileList(p: {
  docs: Doc[];
  selectedIds: string[];
  onSelect: (d: Doc, e?: SelectionEvent) => void;
  onOpen: (d: Doc, origin?: HTMLElement) => void;
  onEvidence: (d: Doc) => void;
  onQuickLook?: (d: Doc) => void;
  search?: boolean;
  query?: string;
  evaluate?: boolean;
  unavailable?: boolean;
  layout: "list" | "grid";
  scope?: string;
  sort: string;
  descending: boolean;
  onSort: (s: string) => void;
  onMove: (d: Doc[]) => void;
  onUpdate: (d: Doc) => void;
  onVersions: (d: Doc) => void;
  onDelete: (d: Doc) => void;
  busy: boolean;
}) {
  const [context, setContext] = useState("");
  const actions = (d: Doc) => (
    <Menu.Root
      open={context === d.document_id}
      onOpenChange={(o) => setContext(o ? d.document_id : "")}
    >
      <Menu.Trigger asChild>
        <button
          className="icon row-menu"
          aria-label={"File actions for " + d.filename}
          title="File actions"
        >
          <MoreHorizontal size={16} />
        </button>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content className="menu" align="end">
          <Menu.Item asChild>
            <a href={fileUrl(d, true)}>Download</a>
          </Menu.Item>
          <Menu.Item onSelect={() => p.onUpdate(d)}>Update version…</Menu.Item>
          <Menu.Item disabled={p.busy} onSelect={() => p.onMove([d])}>
            Move to…
          </Menu.Item>
          <Menu.Item onSelect={() => p.onVersions(d)}>View versions</Menu.Item>
          <Menu.Item disabled={p.busy} onSelect={() => p.onDelete(d)}>
            Delete document…
          </Menu.Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
  const table = p.layout === "list";
  const checkedSearch = !!p.search && !!p.evaluate;
  const folderLabel = (d: Doc) => {
    const path = d.folder || "";
    if (!path) return "Unfiled";
    if (p.scope && path.startsWith(p.scope + " / "))
      return path.slice(p.scope.length + 3).split(" / ")[0];
    if (path === p.scope) return "This folder";
    return path;
  };
  const state = (d: Doc) =>
    d.status && d.status !== "indexed"
      ? indexingLabel(d.status)
      : d.organization_status && d.organization_status !== "evaluated"
        ? d.organization_status === "not_evaluated"
          ? "Jev needs extracted text"
          : `Organization ${d.organization_status}`
        : "";
  const fileButton = (d: Doc) => (
    <button
      className="file-select"
      aria-label={"Select " + (table ? d.filename : title(d))}
      aria-description={d.filename}
      title={d.filename}
      aria-pressed={p.selectedIds.includes(d.document_id)}
      onClick={(e) => p.onSelect(d, e)}
      onDoubleClick={(event) => p.onOpen(d, event.currentTarget)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          p.onOpen(d, e.currentTarget);
        }
        if (e.key === " ") {
          e.preventDefault();
          p.onSelect(d);
          (p.onQuickLook || p.onOpen)(d);
        }
      }}
    >
      {!table ? null : p.selectedIds.includes(d.document_id) ? (
        <CheckSquare size={15} className="type-icon" />
      ) : kind(d) === "Image" ? (
        <ImageIcon size={15} className="type-icon image" />
      ) : (
        <FileText size={16} className={"type-icon " + kind(d).toLowerCase()} />
      )}
      <span className="file-description">
        <strong title={d.filename}>{table ? d.filename : title(d)}</strong>
        {!!d.freshness_labels?.length && <small className="freshness-badge" title="Open the file and choose Review freshness to inspect saved suggestions">{d.freshness_labels.join(" · ")}</small>}
        {state(d) && (
          <span className="file-status" title={state(d)} aria-label={state(d)}>
            ●<span className="sr-only">{state(d)}</span>
          </span>
        )}
      </span>
    </button>
  );
  const date = (d: Doc) => (
    <time
      dateTime={d.created_at || undefined}
      title={
        d.created_at
          ? "Latest saved version: " + new Date(d.created_at).toLocaleString()
          : "Timestamp unavailable"
      }
    >
      {d.created_at
        ? new Date(d.created_at).toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
          })
        : "—"}
    </time>
  );
  const rowEvents = (d: Doc) => ({
    onClick: (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest("button,a")) p.onSelect(d, e);
    },
    onDoubleClick: (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest("button,a")) p.onOpen(d);
    },
    onContextMenu: (e: MouseEvent) => {
      e.preventDefault();
      setContext(d.document_id);
    },
  });
  if (table)
    return (
      <table
        className={
          "file-list file-table " +
          (p.search ? "results-list search-table " : "") +
          (checkedSearch ? "checked-search" : "")
        }
        aria-label={p.search ? "Search results" : "Files"}
      >
        <colgroup>
          <col className="name-column" />
          <col className="folder-column" />
          <col className="type-column" />
          <col className="version-column" />
          {checkedSearch && <col className="evidence-column" />}
          <col className="date-column" />
          <col className="actions-column" />
        </colgroup>
        <thead>
          <tr className="file-columns">
            {[
              ["filename", "Name"],
              ["folder", "Folder"],
              ["type", "Type"],
              ["version", "Version"],
              ...(checkedSearch ? [["evidence", "Evidence"]] : []),
              ["date", "Modified"],
            ].map(([field, name]) => {
              const sortable = ["filename", "type", "date"].includes(field);
              return (
                <th
                  key={field}
                  className={field + "-cell"}
                  scope="col"
                  aria-sort={
                    sortable
                      ? p.sort === field
                        ? p.descending
                          ? "descending"
                          : "ascending"
                        : "none"
                      : undefined
                  }
                >
                  {sortable ? (
                    <button
                      onClick={() => p.onSort(field)}
                      aria-label={"Sort by " + name}
                    >
                      {name}
                      {p.sort === field &&
                        (p.descending ? (
                          <ArrowDown size={12} />
                        ) : (
                          <ArrowUp size={12} />
                        ))}
                    </button>
                  ) : (
                    name
                  )}
                </th>
              );
            })}
            <th scope="col">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {p.docs.map((d) => (
            <tr
              key={d.document_id}
              data-document-id={d.document_id}
              className={
                "file-row " +
                (p.selectedIds.includes(d.document_id) ? "selected" : "")
              }
              aria-selected={p.selectedIds.includes(d.document_id)}
              {...rowEvents(d)}
            >
              <td>{fileButton(d)}{p.search && <div className="search-row-excerpt"><ContentCard doc={d} search evaluate={p.evaluate} query={p.query} compactPreview /></div>}</td>
              <td className="folder-cell">
                <span className="file-folder" title={d.folder}>
                  {folderLabel(d)}
                </span>
              </td>
              <td className="type-cell">
                {kind(d) === "Markdown" ? "MD" : kind(d)}
              </td>
              <td className="version-cell">{d.version}</td>
              {checkedSearch && (
                <td className="evidence-cell">
                  <Judgment
                    doc={d}
                    evaluate
                    unavailable={p.unavailable}
                    onEvidence={() => p.onEvidence(d)}
                  />
                </td>
              )}
              <td className="date-cell">{date(d)}</td>
              <td>{actions(d)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  return (
    <div
      className={"file-grid " + (p.search ? "results-list" : "")}
      aria-label={p.search ? "Search results" : "Files"}
    >
      {p.docs.map((d) => (
        <div
          key={d.document_id}
          data-document-id={d.document_id}
          className={
            "file-row grid-file " +
            (p.selectedIds.includes(d.document_id) ? "selected" : "")
          }
          {...rowEvents(d)}
        >
          {fileButton(d)}
          <>
            <ContentCard
              doc={d}
              search={!!p.search}
              evaluate={p.evaluate}
              query={p.query}
              compactPreview
            />
            <span className="file-card-meta">
              <span title={d.folder || "Unfiled"}>
                {formatLabel(d)} · {folderLabel(d)}
              </span>
              <span>{d.version}</span>
            </span>
          </>
          {p.search && (
            <Judgment
              doc={d}
              evaluate={!!p.evaluate}
              unavailable={p.unavailable}
              onEvidence={() => p.onEvidence(d)}
            />
          )}
          <button
            className="card-preview-action"
            aria-label={`Preview ${title(d)}`}
            onClick={(event) => p.onOpen(d, event.currentTarget)}
          >
            <Eye size={14} />
            Preview
          </button>
          {actions(d)}
        </div>
      ))}
    </div>
  );
}
