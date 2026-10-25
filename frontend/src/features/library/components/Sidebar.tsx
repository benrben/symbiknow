import { useEffect, useRef, useState, useId } from "react";
import { Folder, Clock3, HardDrive, MoreHorizontal, ChevronRight, ChevronDown, Pencil, FolderInput, Trash2 } from "lucide-react";
import { LibraryIcon as FileText, UnfiledIcon as Inbox } from "../../../shared/components/KnowledgeIcons";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { folderCounts } from "../../../shared/api/client";
import { preferenceKey, readSaved, save } from "../../../shared/presentation/format";
export function Logo() {
  return (
    <span className="logo">
      <img
        className="logo-symbol"
        src="/icons/symbiknow.svg"
        alt=""
        width={32}
        height={32}
      />
      Symbiknow
    </span>
  );
}
export default function Sidebar(p: {
  folders: Record<string, number>;
  onNextTaxonomy?: () => void;
  onFirstTaxonomy?: () => void;
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
  const [folderQuery, setFolderQuery] = useState("");
  const [navigationOpen, setNavigationOpen] = useState(false);
  const navigationId = useId();
  const menuButton = useRef<HTMLButtonElement>(null);
  function choose(folder?: string, recent?: boolean) {
    p.onChoose(folder, recent);
    setNavigationOpen(false);
    if (window.matchMedia("(max-width: 760px)").matches)
      menuButton.current?.focus();
  }
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
    if (folderQuery.trim())
      return path
        .toLocaleLowerCase()
        .includes(folderQuery.trim().toLocaleLowerCase());
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
    <aside
      className={"sidebar" + (navigationOpen ? " navigation-open" : "")}
      onKeyDown={(event) => {
        if (
          event.key === "Escape" &&
          navigationOpen &&
          window.matchMedia("(max-width: 760px)").matches
        ) {
          event.preventDefault();
          event.stopPropagation();
          setNavigationOpen(false);
          menuButton.current?.focus();
        }
      }}
    >
      <div className="sidebar-brand">
        <Logo />
        <button
          ref={menuButton}
          className="mobile-navigation-toggle"
          aria-label="Folders — toggle library navigation"
          aria-expanded={navigationOpen}
          aria-controls={navigationId}
          onClick={() => setNavigationOpen((v) => !v)}
        >
          <Folder size={16} />
          Folders
          <ChevronDown size={14} />
        </button>
      </div>
      <nav id={navigationId} aria-label="Library navigation">
        <button
          aria-label={`All files ${p.total}`}
          aria-description={`${p.total} files`}
          aria-current={
            p.folder === undefined && !p.recent ? "page" : undefined
          }
          className={p.folder === undefined && !p.recent ? "active" : ""}
          onClick={() => choose()}
        >
          <FileText size={16} />
          <span>All files</span>
          <small aria-hidden="true"> {p.total}</small>
        </button>
        <button
          className={p.recent ? "active" : ""}
          aria-current={p.recent ? "page" : undefined}
          onClick={() => choose(undefined, true)}
        >
          <Clock3 />
          <span>Recent</span>
        </button>
        <button
          aria-label={`Unfiled ${counts[""] || 0}`}
          aria-description={`${counts[""] || 0} files`}
          aria-current={p.folder === "" && !p.recent ? "page" : undefined}
          className={p.folder === "" && !p.recent ? "active" : ""}
          onClick={() => choose("")}
        >
          <Inbox size={16} />
          <span>Unfiled</span>
          <small aria-hidden="true"> {counts[""] || 0}</small>
        </button>
        <h2>Folders</h2>
        {(p.onNextTaxonomy || p.onFirstTaxonomy) && <div>
          {p.onFirstTaxonomy && <button onClick={p.onFirstTaxonomy}>First folders</button>}
          {p.onNextTaxonomy && <button onClick={p.onNextTaxonomy}>Next folders and groups</button>}
        </div>}
        <input
          className="sidebar-folder-search"
          type="search"
          aria-label="Find a folder"
          placeholder="Find a folder…"
          value={folderQuery}
          onChange={(e) => {
            setFolderQuery(e.target.value);
            setFocused("");
          }}
        />
        {folderQuery && !visible.length && (
          <p role="status">No matching folders.</p>
        )}
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
                aria-label={`${f}, ${counts[f]} ${counts[f] === 1 ? "file" : "files"}`}
                style={{ paddingLeft: 8 + Math.min(depth - 1, 5) * 12 }}
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
                      " ",
                      "Home",
                      "End",
                    ].includes(e.key)
                  )
                    e.preventDefault();
                  if (e.key === "ArrowDown")
                    focus(visible[Math.min(i + 1, visible.length - 1)]);
                  if (e.key === "ArrowUp") focus(visible[Math.max(i - 1, 0)]);
                  if (e.key === "ArrowRight" && children) {
                    if (!expanded.includes(f)) toggle(f);
                    else if (visible[i + 1]) focus(visible[i + 1]);
                  }
                  if (e.key === "ArrowLeft") {
                    if (children && expanded.includes(f)) toggle(f);
                    else if (
                      depth > 1 &&
                      visible.includes(f.split(" / ").slice(0, -1).join(" / "))
                    )
                      focus(f.split(" / ").slice(0, -1).join(" / "));
                  }
                  if (e.key === "Home") focus(visible[0]);
                  if (e.key === "End") focus(visible[visible.length - 1]);
                  if (e.key === "Enter" || e.key === " ") choose(f);
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
                  aria-label={`${f} ${counts[f]}`}
                  tabIndex={-1}
                  onClick={() => {
                    choose(f);
                    focus(f);
                  }}
                  title={f}
                >
                  <Folder size={18} />
                  <span>{f.split(" / ").at(-1)}</span>
                  <small aria-hidden="true"> {counts[f]}</small>
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
                        <Pencil size={14} aria-hidden="true" /> Rename…
                      </Menu.Item>
                      <Menu.Item
                        disabled={p.busy}
                        onSelect={() => p.onEdit("move-folder", f)}
                      >
                        <FolderInput size={14} aria-hidden="true" /> Move to…
                      </Menu.Item>
                      <Menu.Separator className="menu-separator" />
                      <Menu.Item
                        className="menu-danger"
                        disabled={p.busy}
                        onSelect={() => p.onDelete(f, counts[f])}
                      >
                        <Trash2 size={14} aria-hidden="true" /> Remove folder…
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
          {p.status !== "Your library" && <small>
            <span
              className={
                p.status === "Up to date" ? "status-dot" : "status-dot pending"
              }
            />
            {p.status}
          </small>}
        </div>
      </div>
    </aside>
  );
}
