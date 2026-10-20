import { useEffect, useRef, useState } from "react";
import { ArrowRight, Folder } from "lucide-react";
import { DocumentIcon as FileText, UnfiledIcon as Inbox, MapIcon as Network, OverviewIcon as LayoutGrid } from "../../../shared/components/KnowledgeIcons";
import { api, title, type Doc, type Library } from "../../../shared/api/client";
import { overviewFolders, overviewPath } from "../presentation";

function FolderSummary(p: {
  path: string;
  count: number;
  scope?: string;
  group?: string;
  docs: Doc[];
  revision: string;
  onFolder: (path: string) => void;
  onOpen: (doc: Doc, origin?: HTMLElement) => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  const [extra, setExtra] = useState<Doc[]>([]);
  const [failed, setFailed] = useState(false);
  const loaded = p.docs
    .filter((d) => overviewPath(d.folder || "", p.scope) === p.path)
    .slice(0, 3);
  const hasLoaded = loaded.length > 0;
  useEffect(() => {
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    });
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setExtra([]);
    setFailed(false);
    if (!visible || hasLoaded) return;
    // Only request a small metadata sample for visible, otherwise-unloaded groups.
    // No document bodies, search, or AI evaluation is needed for this overview.
    const controller = new AbortController();
    const params = new URLSearchParams({
      folder: p.path,
      limit: "3",
      sort: "filename",
    });
    if (p.group) params.set("group", p.group);
    api<Library>("library?" + params, undefined, controller.signal)
      .then((r) => {
        if (!controller.signal.aborted)
          setExtra(
            r.documents
              .filter((d) => overviewPath(d.folder || "", p.scope) === p.path)
              .slice(0, 3),
          );
      })
      .catch((e) => {
        if (e.name !== "AbortError") setFailed(true);
      });
    return () => controller.abort();
  }, [visible, hasLoaded, p.path, p.scope, p.group, p.revision]);
  const docs = hasLoaded ? loaded : extra;
  const name = !p.path
    ? "Unfiled"
    : p.path === p.scope
      ? "Files in this folder"
      : p.path.split(" / ").at(-1);
  return (
    <section
      ref={ref}
      className="folder-summary"
      aria-label={`${name}, ${p.count} ${p.count === 1 ? "file" : "files"}`}
    >
      <div className="folder-summary-heading">
        {p.path ? (
          <Folder size={30} strokeWidth={1.5} />
        ) : (
          <Inbox size={30} strokeWidth={1.5} />
        )}
        <div>
          <h2 title={p.path || "Unfiled"}>{name}</h2>
          <span>
            {p.count} {p.count === 1 ? "file" : "files"}
          </span>
        </div>
        <button
          className="text-action"
          onClick={() => p.onFolder(p.path)}
          aria-label={`Open folder ${name}`}
        >
          Open folder <ArrowRight size={15} />
        </button>
      </div>
      <div className="folder-summary-files">
        {docs.map((d) => (
          <button
            key={d.document_id}
            className="overview-file"
            title={d.filename}
            aria-label={`Open ${title(d)}`}
            onClick={(event) => p.onOpen(d, event.currentTarget)}
          >
            <FileText size={18} />
            <span>
              {title(d).replace(
                new RegExp(
                  "^" +
                    (name || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
                    "\\s+",
                  "i",
                ),
                "",
              )}
            </span>
            <ArrowRight size={14} className="open-arrow" />
          </button>
        ))}
        {!docs.length && (
          <p className="overview-placeholder">
            {failed
              ? "Preview unavailable. Open the folder to browse."
              : "Open this folder to explore its files."}
          </p>
        )}
      </div>
      <button
        className="folder-summary-more text-action"
        onClick={() => p.onFolder(p.path)}
      >
        {p.count === 1
          ? "View file"
          : `View all ${p.count} ${p.count === 1 ? "file" : "files"}`}{" "}
        <ArrowRight size={15} />
      </button>
    </section>
  );
}

export default function FolderOverview(p: {
  folders: Record<string, number>;
  docs: Doc[];
  scope?: string;
  group?: string;
  total: number;
  revision: string;
  onFolder: (path: string) => void;
  onOpen: (doc: Doc, origin?: HTMLElement) => void;
  onMap: () => void;
}) {
  const groups = overviewFolders(p.folders, p.scope);
  return (
    <section className="folder-overview" aria-label="Folder overview">
      <div className="folder-overview-grid">
        {groups.map(([path, count]) => (
          <FolderSummary key={path} {...p} path={path} count={count} />
        ))}
      </div>
      <footer className="overview-footer">
        <span>
          All {p.total} files represented <span aria-hidden="true">·</span> Open
          a folder to explore documents
        </span>
        <div className="overview-controls">
          <span>
            <LayoutGrid size={16} /> Overview
          </span>
          <button onClick={p.onMap}>
            <Network size={16} /> Document map
          </button>
        </div>
      </footer>
    </section>
  );
}
