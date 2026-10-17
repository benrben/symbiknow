import { Search, X, Info, SlidersHorizontal, Upload } from "lucide-react";
import * as Switch from "@radix-ui/react-switch";
import * as Menu from "@radix-ui/react-dropdown-menu";
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
  return (
    <>
      <header className="topbar">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            p.onSubmit();
          }}
        >
          <Search size={16} />
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
        <select
          aria-label="Search mode"
          value={p.mode}
          onChange={(e) => p.onMode(e.target.value as Mode)}
        >
          <option value="hybrid">Hybrid</option>
          <option value="semantic">Semantic</option>
          <option value="keyword">Keyword</option>
        </select>
        <label className="jev-control">
          Check answers
          <Switch.Root
            aria-label="Check answers (Jev evaluation)"
            title="Check whether results answer the question"
            className="switch"
            checked={p.evaluate}
            onCheckedChange={p.onEvaluate}
          >
            <Switch.Thumb className="switch-thumb" />
          </Switch.Root>
        </label>
        <span
          tabIndex={0}
          className="tooltip-info"
          title="Check whether results answer the question. Selected text is sent to TypeSafe. Background organization is independent."
          aria-label="Selected text is sent to TypeSafe for answerability checking."
        >
          <Info size={15} />
        </span>
        <Menu.Root>
          <Menu.Trigger asChild>
            <button
              className="icon"
              aria-label="Search scope and filters"
              title="Scope and groups"
            >
              <SlidersHorizontal size={18} />
            </button>
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Content className="menu scope-menu" align="end">
              <Menu.Label>Folders</Menu.Label>
              <input
                className="folder-picker-search"
                aria-label="Find folder"
                placeholder="Find folder…"
                value={folderQuery}
                onChange={(e) => setFolderQuery(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
              />
              <Menu.Item onSelect={() => p.onFolder(undefined)}>
                All files
              </Menu.Item>
              <Menu.Item onSelect={() => p.onFolder("")}>Unfiled</Menu.Item>
              {Object.keys(folderCounts(p.folders))
                .filter(
                  (f) =>
                    !!f && f.toLowerCase().includes(folderQuery.toLowerCase()),
                )
                .sort()
                .map((f) => (
                  <Menu.Item
                    key={f}
                    title={f}
                    aria-label={f}
                    onSelect={() => p.onFolder(f)}
                  >
                    <span
                      style={{ paddingLeft: (f.split(" / ").length - 1) * 12 }}
                    >
                      {f.split(" / ").at(-1)}
                    </span>
                  </Menu.Item>
                ))}
              <Menu.Label>Groups</Menu.Label>
              <Menu.Item onSelect={() => p.onGroup(undefined)}>
                All groups
              </Menu.Item>
              {p.groups.map((g) => (
                <Menu.Item key={g} onSelect={() => p.onGroup(g)}>
                  {p.group === g ? "✓ " : ""}
                  {g}
                </Menu.Item>
              ))}
            </Menu.Content>
          </Menu.Portal>
        </Menu.Root>
        <button className="import-button primary" onClick={p.add}>
          <Upload size={15} />
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
              aria-label="Clear folder scope"
            >
              <span>{p.folder || "Unfiled"}</span>
              <X size={13} />
            </button>
          )}
          {p.group && (
            <button
              title={p.group}
              onClick={() => p.onGroup(undefined)}
              aria-label="Clear group filter"
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
