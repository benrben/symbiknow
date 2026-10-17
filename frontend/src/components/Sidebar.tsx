import { useEffect, useRef, useState } from "react";
import {
  Folder,
  FileText,
  Clock3,
  HardDrive,
  MoreHorizontal,
  ChevronRight,
  ChevronDown,
  Inbox,
} from "lucide-react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { folderCounts } from "../api";
import { preferenceKey, readSaved, save } from "../presentation";
export function Logo() {
  return (
    <span className="logo">
      <span className="logo-symbol">
        <i />
        <i />
      </span>
      Symbiknow
    </span>
  );
}
export default function Sidebar(p: {
  folders: Record<string, number>;
  folder?: string;
  recent: boolean;
  libraryId?: string;
  total: number;
  status: string;
  busy: boolean;
  onChoose: (folder?: string, recent?: boolean) => void;
  onDelete: (folder: string, count: number) => void;
  onEdit: (action: "rename-folder" | "move-folder", folder: string) => void;
}) {
  const [expanded, setExpanded] = useState<string[]>([]),
    [focused, setFocused] = useState("");
  const refs = useRef(new Map<string, HTMLDivElement>());
  const counts = folderCounts(p.folders);
  useEffect(() => {
    if (p.libraryId) {
      const stored = readSaved<string[]>(
        preferenceKey(p.libraryId, "expanded"),
        [],
      );
      setExpanded(
        Array.isArray(stored)
          ? stored.filter((f) => typeof f === "string")
          : [],
      );
    }
  }, [p.libraryId]);
  useEffect(() => {
    if (!p.folder) return;
    const parts = p.folder.split(" / ");
    setExpanded((old) => [
      ...new Set([
        ...old,
        ...parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join(" / ")),
      ]),
    ]);
  }, [p.folder]);
  function toggle(f: string) {
    setExpanded((old) => {
      const next = old.includes(f) ? old.filter((x) => x !== f) : [...old, f];
      if (p.libraryId) save(preferenceKey(p.libraryId, "expanded"), next);
      return next;
    });
  }
  const paths = Object.keys(counts)
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  const visible = paths.filter((path) => {
    const parts = path.split(" / ");
    return parts
      .slice(0, -1)
      .every((_, i) => expanded.includes(parts.slice(0, i + 1).join(" / ")));
  });
  function focus(f: string) {
    setFocused(f);
    refs.current.get(f)?.focus();
  }
  return (
    <aside className="sidebar">
      <Logo />
      <nav aria-label="Library navigation">
        <button
          aria-label="All files"
          className={p.folder === undefined && !p.recent ? "active" : ""}
          onClick={() => p.onChoose()}
        >
          <FileText />
          <span>All files</span>
          <small>{p.total}</small>
        </button>
        <button
          className={p.recent ? "active" : ""}
          onClick={() => p.onChoose(undefined, true)}
        >
          <Clock3 />
          <span>Recent</span>
        </button>
        <button
          aria-label="Unfiled"
          className={p.folder === "" && !p.recent ? "active" : ""}
          onClick={() => p.onChoose("")}
        >
          <Inbox />
          <span>Unfiled</span>
          <small>{counts[""] || 0}</small>
        </button>
        <h2>Folders</h2>
        <div role="tree" aria-label="Folders">
          {visible.map((f) => {
            const depth = f.split(" / ").length,
              children = paths.some((path) => path.startsWith(f + " / "));
            return (
              <div
                key={f}
                role="treeitem"
                aria-level={depth}
                aria-selected={p.folder === f}
                aria-expanded={children ? expanded.includes(f) : undefined}
                tabIndex={(focused || visible[0]) === f ? 0 : -1}
                ref={(node) => {
                  if (node) refs.current.set(f, node);
                  else refs.current.delete(f);
                }}
                className={"folder-nav-row " + (p.folder === f ? "active" : "")}
                title={f}
                aria-label={`${f}, ${counts[f]} files`}
                style={{ paddingLeft: 8 + (depth - 1) * 12 }}
                onFocus={() => setFocused(f)}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget) return;
                  const i = visible.indexOf(f);
                  if (
                    [
                      "ArrowDown",
                      "ArrowUp",
                      "ArrowRight",
                      "ArrowLeft",
                      "Enter",
                    ].includes(e.key)
                  )
                    e.preventDefault();
                  if (e.key === "ArrowDown")
                    focus(visible[Math.min(i + 1, visible.length - 1)]);
                  if (e.key === "ArrowUp") focus(visible[Math.max(i - 1, 0)]);
                  if (e.key === "ArrowRight" && children) {
                    if (!expanded.includes(f)) toggle(f);
                    else focus(visible[i + 1]);
                  }
                  if (e.key === "ArrowLeft") {
                    if (children && expanded.includes(f)) toggle(f);
                    else if (depth > 1)
                      focus(f.split(" / ").slice(0, -1).join(" / "));
                  }
                  if (e.key === "Enter") p.onChoose(f);
                }}
              >
                <button
                  className="disclosure icon"
                  aria-label={
                    (expanded.includes(f) ? "Collapse " : "Expand ") + f
                  }
                  tabIndex={-1}
                  disabled={!children}
                  onClick={() => {
                    toggle(f);
                    focus(f);
                  }}
                >
                  {children &&
                    (expanded.includes(f) ? (
                      <ChevronDown size={14} />
                    ) : (
                      <ChevronRight size={14} />
                    ))}
                </button>
                <button
                  className="folder-label"
                  aria-label={f}
                  tabIndex={-1}
                  onClick={() => {
                    p.onChoose(f);
                    focus(f);
                  }}
                  title={f}
                >
                  <Folder size={18} />
                  <span>{f.split(" / ").at(-1)}</span>
                  <small>{counts[f]}</small>
                </button>
                <Menu.Root>
                  <Menu.Trigger asChild>
                    <button
                      className="icon folder-menu"
                      aria-label={"Folder actions for " + f}
                    >
                      <MoreHorizontal size={16} />
                    </button>
                  </Menu.Trigger>
                  <Menu.Portal>
                    <Menu.Content
                      className="menu"
                      align="end"
                      onCloseAutoFocus={(e) => {
                        e.preventDefault();
                        focus(f);
                      }}
                    >
                      <Menu.Item
                        disabled={p.busy}
                        onSelect={() => p.onEdit("rename-folder", f)}
                      >
                        Rename…
                      </Menu.Item>
                      <Menu.Item
                        disabled={p.busy}
                        onSelect={() => p.onEdit("move-folder", f)}
                      >
                        Move to…
                      </Menu.Item>
                      <Menu.Item
                        disabled={p.busy}
                        onSelect={() => p.onDelete(f, counts[f])}
                      >
                        Remove folder…
                      </Menu.Item>
                    </Menu.Content>
                  </Menu.Portal>
                </Menu.Root>
              </div>
            );
          })}
        </div>
      </nav>
      <div className="local-library">
        <HardDrive size={18} />
        <div>
          Local library
          <small>
            <span
              className={
                p.status === "Up to date" ? "status-dot" : "status-dot pending"
              }
            />
            {p.status}
          </small>
        </div>
      </div>
    </aside>
  );
}
