import {
  Search,
  X,
  SlidersHorizontal,
  Upload,
  ChevronDown,
  Sparkles,
} from "lucide-react";
import * as Switch from "@radix-ui/react-switch";
import * as Dialog from "@radix-ui/react-dialog";
import { useState, type RefObject, type ReactNode } from "react";
import { folderCounts } from "../api";
export type Mode = "hybrid" | "semantic" | "keyword";
export default function SearchBar(p: {
  inputRef: RefObject<HTMLInputElement | null>;
  query: string;
  onQuery: (q: string) => void;
  onSubmit: () => void;
  onClear: () => void;
  mode: Mode;
  onMode: (m: Mode) => void;
  evaluate: boolean;
  onEvaluate: (v: boolean) => void;
  folder?: string;
  onFolder: (f?: string) => void;
  folders: Record<string, number>;
  group?: string;
  onGroup: (g?: string) => void;
  groups: string[];
  add: () => void;
  submitted: boolean;
  actions: ReactNode;
}) {
  const [folderQuery, setFolderQuery] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const paths = Object.keys(folderCounts(p.folders))
    .filter((f) => !!f && f.toLowerCase().includes(folderQuery.toLowerCase()))
    .sort();
  const filterCount = Number(p.folder !== undefined) + Number(!!p.group);
  return (
    <>
      <header className="topbar">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            p.onSubmit();
          }}
        >
          <Search size={18} />
          <input
            ref={p.inputRef}
            aria-label="Search your knowledge"
            placeholder={
              p.folder
                ? "Search in " + p.folder.split(" / ").at(-1)
                : p.folder === ""
                  ? "Search in Unfiled"
                  : "Search your library"
            }
            value={p.query}
            onChange={(e) => p.onQuery(e.target.value)}
          />
          {p.query || p.submitted ? (
            <button
              type="button"
              title="Clear search"
              aria-label="Clear search"
              className="icon"
              onClick={p.onClear}
            >
              <X size={16} />
            </button>
          ) : (
            <kbd>⌘ K</kbd>
          )}
        </form>
        <Switch.Root
          aria-label="Check answers (Jev evaluation)"
          aria-describedby="jev-quick-help"
          className="jev-quick-toggle"
          checked={p.evaluate}
          onCheckedChange={p.onEvaluate}
          title="Check whether files answer your question. Sends selected text to TypeSafe when on."
        >
          <Sparkles size={15} aria-hidden="true" />
          <span>Jev<span className="jev-quick-label"> answers</span></span>
          <span className="jev-quick-state" aria-hidden="true">{p.evaluate ? "On" : "Off"}</span>
          <span className="jev-quick-track" aria-hidden="true">
            <Switch.Thumb className="jev-quick-thumb" />
          </span>
        </Switch.Root>
        <span id="jev-quick-help" className="sr-only">
          Checks whether retrieved passages answer your question. When on, selected
          text is sent to TypeSafe. This does not control background organization.
        </span>
        <Dialog.Root open={filtersOpen} onOpenChange={setFiltersOpen}>
          <Dialog.Trigger asChild>
            <button
              className="filters-button"
              aria-label={`Search scope and filters${filterCount ? ` ${filterCount}` : ""}`}
            >
              <SlidersHorizontal size={16} />
              <span className="filters-label">Filters</span>
              {filterCount > 0 && (
                <span className="filter-count"> {filterCount}</span>
              )}
            </button>
          </Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Overlay className="overlay" />
            <Dialog.Content className="reset-dialog search-options-dialog">
              <div className="search-options-heading">
                <div>
                  <Dialog.Title>Search filters</Dialog.Title>
                  <Dialog.Description>
                    Choose where to search and how to find relevant files.
                  </Dialog.Description>
                </div>
                <Dialog.Close asChild>
                  <button className="icon" aria-label="Close search filters">
                    <X size={18} />
                  </button>
                </Dialog.Close>
              </div>
              <label className="field-label" htmlFor="find-folder">
                Folder
              </label>
              <input
                id="find-folder"
                className="folder-picker-search"
                placeholder="Find folder…"
                value={folderQuery}
                onChange={(e) => setFolderQuery(e.target.value)}
              />
              <div
                className="folder-options"
                role="group"
                aria-label="Search folder"
              >
                <button
                  aria-pressed={p.folder === undefined}
                  onClick={() => p.onFolder(undefined)}
                >
                  All files
                </button>
                <button
                  aria-pressed={p.folder === ""}
                  onClick={() => p.onFolder("")}
                >
                  Unfiled
                </button>
                {paths.map((f) => (
                  <button
                    key={f}
                    title={f}
                    aria-label={f}
                    aria-pressed={p.folder === f}
                    onClick={() => p.onFolder(f)}
                    style={{
                      paddingLeft: 12 + (f.split(" / ").length - 1) * 14,
                    }}
                  >
                    {f.split(" / ").at(-1)}
                  </button>
                ))}
                {folderQuery && !paths.length && (
                  <p className="secondary">No matching folders.</p>
                )}
              </div>
              <label className="field-label" htmlFor="search-group">
                Topic group
              </label>
              <select
                id="search-group"
                aria-label="Topic group"
                value={p.group || ""}
                onChange={(e) => p.onGroup(e.target.value || undefined)}
              >
                <option value="">All groups</option>
                {p.groups.map((g) => (
                  <option key={g}>{g}</option>
                ))}
              </select>
              <p className="field-help">
                Groups connect related topics across folders.
              </p>
              <details className="advanced-search">
                <summary>
                  Search options <ChevronDown size={16} />
                </summary>
                <label className="field-label" htmlFor="search-mode">
                  Search method
                </label>
                <select
                  id="search-mode"
                  aria-label="Search mode"
                  value={p.mode}
                  onChange={(e) => p.onMode(e.target.value as Mode)}
                >
                  <option value="hybrid">Hybrid · meaning and keywords</option>
                  <option value="semantic">Semantic · meaning</option>
                  <option value="keyword">Keyword · exact terms</option>
                </select>
                <p className="field-help">
                  Use Jev answers beside the search box to check whether results
                  answer your question. When on, selected text is sent to TypeSafe.
                </p>
              </details>
              <div className="search-options-footer">
                <button
                  onClick={() => {
                    p.onFolder(undefined);
                    p.onGroup(undefined);
                    setFolderQuery("");
                  }}
                >
                  Clear filters
                </button>
                <Dialog.Close asChild>
                  <button className="primary">Done</button>
                </Dialog.Close>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
        <button className="import-button primary" onClick={p.add}>
          <Upload size={16} />
          Import
        </button>
        {p.actions}
      </header>
      {(p.folder !== undefined || p.group) && (
        <div className="scope-chips" aria-label="Current search scope">
          {p.folder !== undefined && (
            <button
              title={p.folder || "Unfiled"}
              onClick={() => p.onFolder(undefined)}
              aria-label={`Clear folder scope: ${p.folder || "Unfiled"}`}
            >
              <span>{p.folder || "Unfiled"}</span>
              <X size={13} />
            </button>
          )}
          {p.group && (
            <button
              title={p.group}
              onClick={() => p.onGroup(undefined)}
              aria-label={`Clear group filter: Group: ${p.group}`}
            >
              <span>Group: {p.group}</span>
              <X size={13} />
            </button>
          )}
        </div>
      )}
    </>
  );
}
