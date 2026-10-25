import {
  Search,
  X,
  SlidersHorizontal,
  Upload,
  Sparkles,
} from "lucide-react";
import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useState, type RefObject, type ReactNode } from "react";
import { folderCounts } from "../../../shared/api/client";
export type Mode = "semantic" | "grep";
type SearchStyle = Mode | "exact";
export default function SearchBar(p: {
  inputRef: RefObject<HTMLInputElement | null>;
  query: string;
  onQuery: (q: string) => void;
  onSubmit: (query: string) => void;
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
  const [searchStyle, setSearchStyle] = useState<SearchStyle>(p.mode);
  const [matchCase, setMatchCase] = useState(true);
  const [wholeWord, setWholeWord] = useState(false);
  useEffect(() => {
    setSearchStyle((current) => p.mode === "semantic"
      ? "semantic"
      : current === "semantic" ? "grep" : current);
  }, [p.mode]);
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
            const rawQuery = p.query.trim();
            if (searchStyle === "exact" && rawQuery) {
              const flags = `${matchCase ? "" : "i"}${wholeWord ? "w" : ""}`;
              const escaped = rawQuery.replace(/'/g, "'\\''");
              p.onSubmit(`grep -F${flags} -e '${escaped}'`);
            } else {
              p.onSubmit(rawQuery);
            }
          }}
        >
          <div className="search-ask-switch" role="group" aria-label="Search or ask">
            <button type="button" aria-pressed={!p.evaluate} onClick={() => p.onEvaluate(false)}><Search size={14}/>Search</button>
            <button type="button" aria-pressed={p.evaluate} onClick={() => p.onEvaluate(true)}><Sparkles size={14}/>Ask</button>
          </div>
          <input
            ref={p.inputRef}
            aria-label="Search your knowledge"
            placeholder={p.evaluate ? "Ask a question about your files…" : searchStyle === "exact" ? "Search exact text…" : p.mode === "grep" ? 'grep -in "your pattern"' : p.folder ? "Search in " + p.folder.split(" / ").at(-1) : "Find an idea, a file, a connection…"}
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
          <button className="search-submit" type="submit" aria-label={p.evaluate ? "Ask Jev" : "Run search"}>↵</button>
        </form>
        {!p.evaluate ? <select className="search-method-select" aria-label="Search mode" title="Search mode" value={searchStyle} onChange={e => {
          const next = e.target.value as SearchStyle;
          setSearchStyle(next);
          p.onMode(next === "semantic" ? "semantic" : "grep");
        }}><option value="semantic">Semantic</option><option value="exact">Exact text</option><option value="grep">Advanced grep</option></select>
          : <span className="ask-method" role="status" title="Ask always uses semantic retrieval plus evidence checking. Selected passages are sent to the configured hosted judge. Switch to Search to change the mode.">Semantic + checking</span>}
        {!p.evaluate && searchStyle === "exact" && <div className="exact-search-options" role="group" aria-label="Exact text options">
          <label><input type="checkbox" checked={matchCase} onChange={e => setMatchCase(e.target.checked)} /> Match case</label>
          <label><input type="checkbox" checked={wholeWord} onChange={e => setWholeWord(e.target.checked)} /> Whole word</label>
        </div>}
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
                    Choose where to search and how to find relevant files. Use Browse all originals in Library actions to filter saved files by project or search status.
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
                Topics describe subjects across folders. A folder is placement, not project ownership.
              </p>
              <p className="field-help">Search finds passages by meaning, exact text, or advanced grep. Ask uses semantic search and sends selected passages to the configured hosted judge for answer checking.</p>
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
        <button className="import-button primary" aria-label="Import" title="Import files" onClick={p.add}>
          <Upload size={16} />
          <span className="import-label">Import</span>
        </button>
        {p.actions}
      </header>
      {(p.evaluate || searchStyle === "grep") && <div className="tool-explanation" role="note"><span>{p.evaluate
        ? "Ask checks up to 3 files by meaning. Selected passages are sent to the configured hosted judge."
        : 'Advanced grep searches extracted text in the current scope. Example: grep -in "cache" · Supports -i, -F, -E, -w, -x, -v, -n and -e. No file paths or shell operators.'}</span></div>}
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
