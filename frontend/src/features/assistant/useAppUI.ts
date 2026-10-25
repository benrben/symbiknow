import { useEffect, useRef, useState } from "react";
import { api, type Doc } from "../../shared/api/client";
import type { BrowserCommand } from "./Assistant";

export type AppView = {
  selected?: Doc;
  selectedIds: string[];
  folder?: string;
  group?: string;
  project?: string;
  recent: boolean;
  inspectorVisible: boolean;
  readerExpanded: boolean;
  inspectorTab: string;
  query: string;
  submitted: string;
  mode: "semantic" | "grep";
  evaluate: boolean;
  view: "files" | "map";
  layout: "list" | "grid";
  sort: string;
  descending: boolean;
  searchOrder: { field: string; descending: boolean };
};
type SavedView = AppView & { agentOpened: string; agentMatch?: Doc };
type Props = {
  view: AppView;
  update: (next: AppView, action?: string) => void;
  documents: Doc[];
  folders: string[];
  groups: string[];
  ready: boolean;
  error: string;
  hasEvidence: boolean;
  highlight: (doc: Doc, evidence: string) => void;
};
const tabs: Record<string, string> = {
  document: "preview",
  evidence: "evidence",
  versions: "history",
  connections: "connections",
  details: "details",
};
function stamp(view: AppView) {
  return JSON.stringify([
    view.selected?.document_id,
    view.selected?.version,
    view.selectedIds,
    view.folder,
    view.group,
    view.project,
    view.recent,
    view.inspectorVisible,
    view.readerExpanded,
    view.inspectorTab,
    view.query,
    view.submitted,
    view.mode,
    view.evaluate,
    view.view,
    view.layout,
    view.sort,
    view.descending,
    view.searchOrder,
  ]);
}
function metadata(p: Props) {
  const v = p.view;
  const reader = v.selected && v.inspectorVisible && v.readerExpanded;
  const visible = reader ? [v.selected!] : p.ready ? p.documents : [];
  return {
    surface: reader ? "reader" : v.inspectorVisible ? "split" : "library",
    visible_documents_truncated: visible.length > 50,
    open_document:
      v.selected && v.inspectorVisible
        ? {
            document_id: v.selected.document_id,
            version: v.selected.version,
            title: v.selected.filename,
          }
        : undefined,
    selection: v.selectedIds,
    selection_documents: v.selectedIds.map((document_id) => {
      const doc =
        p.documents.find((document) => document.document_id === document_id) ||
        (v.selected?.document_id === document_id ? v.selected : undefined);
      return {
        document_id,
        ...(doc && { version: doc.version, title: doc.filename }),
      };
    }),
    scope: v.group
      ? "group"
      : v.recent
        ? "recent"
        : v.folder === ""
          ? "unfiled"
          : v.folder
            ? "folder"
            : "all",
    folder: v.folder || "",
    group: v.group || "",
    project: v.project || "",
    query: v.submitted,
    mode: v.mode,
    view: v.view === "map" ? "map" : v.layout,
    sort: v.submitted ? v.searchOrder.field : v.recent ? "date" : v.sort,
    descending: v.submitted
      ? v.searchOrder.descending
      : v.recent || v.descending,
    reader_tab:
      Object.keys(tabs).find((key) => tabs[key] === v.inspectorTab) ||
      "document",
    reader_expanded: v.inspectorVisible && v.readerExpanded,
    ready: p.ready,
    loaded_document_count: p.ready ? p.documents.length : 0,
    visible_documents: visible.slice(0, 50).map((d) => ({
      document_id: d.document_id,
      version: d.version,
      title: d.filename,
    })),
    folders: p.folders.slice(0, 200),
    groups: p.groups.slice(0, 200),
  };
}

/** Product UI actions use the same React state and widgets as the user's controls. */
export function useAppUI(props: Props) {
  const [agentOpened, setAgentOpened] = useState("");
  const [agentMatch, setAgentMatch] = useState<Doc>();
  const latest = useRef(props);
  latest.current = props;
  const views = useRef(new Map<string, SavedView>());
  const executing = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    function back(event: PopStateEvent) {
      const previous = views.current.get(event.state?.assistantView);
      setAgentOpened(previous?.agentOpened || "");
      setAgentMatch(previous?.agentMatch);
      if (previous) latest.current.update(previous);
    }
    window.addEventListener("popstate", back);
    return () => {
      mounted.current = false;
      window.removeEventListener("popstate", back);
    };
  }, []);
  useEffect(() => {
    if (
      agentMatch &&
      (props.view.selected?.document_id !== agentMatch.document_id ||
        props.view.selected.version !== agentMatch.version)
    ) {
      setAgentMatch(undefined);
      setAgentOpened("");
    }
  }, [
    props.view.selected?.document_id,
    props.view.selected?.version,
    agentMatch,
  ]);

  const command: BrowserCommand = async (
    name,
    args,
    manual = false,
    signal,
  ) => {
    const deadline = Math.min(
      Date.now() + 9000,
      typeof args._expires_at === "number" ? args._expires_at - 100 : Infinity,
    );
    const cancelled = () =>
      !mounted.current || signal?.aborted || Date.now() >= deadline;
    const userBusy = () => {
      const visible = (el: Element) =>
        el.getClientRects().length > 0 &&
        getComputedStyle(el).visibility !== "hidden";
      if (
        Array.from(
          document.querySelectorAll('[role="dialog"], [role="alertdialog"]'),
        ).some(visible)
      )
        return "Close the open dialog before changing the view.";
      if (manual) return "";
      const active = document.activeElement;
      if (!active || !visible(active)) return "";
      const editing =
        active instanceof HTMLTextAreaElement ||
        (active instanceof HTMLInputElement && active.selectionStart !== null);
      if (
        (editing && (active as HTMLInputElement).value.trim()) ||
        (active.matches('[contenteditable="true"]') &&
          active.textContent?.trim())
      )
        return "Finish your unsent text or leave the field before changing the view.";
      return "";
    };
    const fail = (reason: string) => ({ ok: false, reason });
    if (cancelled()) return fail("cancelled");
    const busy = userBusy();
    if (busy) return { ok: false, reason: "user_busy", message: busy };
    if (executing.current) return fail("ui_busy");
    executing.current = true;
    try {
      const p = latest.current;
      const before: SavedView = { ...p.view, agentOpened, agentMatch };
      const initialStamp = stamp(p.view);
      const next: SavedView = {
        ...before,
        agentOpened: `Updated by ${typeof args._agent === "string" ? args._agent : "agent"}`,
      };
      let message = "Browser view updated";
      let opened: Doc | undefined;
      if (name === "open_document" || name === "highlight_evidence") {
        if (
          typeof args.document_id !== "string" ||
          typeof args.version !== "string"
        )
          return fail("invalid_document");
        const params = new URLSearchParams({
          id: args.document_id,
          version: args.version,
        });
        if (name === "highlight_evidence") {
          if (typeof args.evidence_id !== "string")
            return fail("invalid_evidence");
          params.set("evidence", args.evidence_id);
        }
        try {
          opened = await api<Doc>(
            `agent-document?${params}`,
            undefined,
            signal,
          );
        } catch {
          return fail(
            cancelled() ? "cancelled" : "document_changed_or_deleted",
          );
        }
        Object.assign(next, {
          selected: opened,
          selectedIds: [opened.document_id],
          inspectorVisible: true,
          readerExpanded: false,
          inspectorTab: name === "highlight_evidence" ? "evidence" : "preview",
          agentMatch: opened,
          agentOpened: `Opened by ${typeof args._agent === "string" ? args._agent : "agent"}`,
        });
        message =
          name === "highlight_evidence"
            ? "Evidence highlighted"
            : `Opened ${opened.filename}`;
      } else if (name === "navigate") {
        const scope =
          args.scope ??
          (typeof args.folder === "string"
            ? args.folder
              ? "folder"
              : "all"
            : undefined);
        if (
          !["all", "recent", "unfiled", "folder", "group"].includes(
            String(scope),
          )
        )
          return fail("invalid_scope");
        if (
          scope === "folder" &&
          (typeof args.folder !== "string" || !p.folders.includes(args.folder))
        )
          return fail("folder_not_found");
        if (
          scope === "group" &&
          (typeof args.group !== "string" || !p.groups.includes(args.group))
        )
          return fail("group_not_found");
        Object.assign(next, {
          folder:
            scope === "folder"
              ? args.folder
              : scope === "unfiled"
                ? ""
                : undefined,
          group: scope === "group" ? args.group : undefined,
          recent: scope === "recent",
          query: "",
          submitted: "",
          selected: undefined,
          selectedIds: [],
          inspectorVisible: false,
          readerExpanded: false,
          agentMatch: undefined,
        });
        message = `Showing ${scope === "folder" ? args.folder : scope === "group" ? args.group : scope === "all" ? "all files" : scope}`;
      } else if (name === "show_search" || name === "clear_search") {
        const query =
          name === "clear_search"
            ? ""
            : typeof args.query === "string"
              ? args.query.trim()
              : "";
        if (name === "show_search" && (!query || query.length > 2000))
          return fail("invalid_query");
        if (
          args.mode !== undefined &&
          args.mode !== "semantic" &&
          args.mode !== "grep"
        )
          return fail("invalid_mode");
        Object.assign(next, {
          query,
          submitted: query,
          mode: args.mode || p.view.mode,
          evaluate: false,
          selected: undefined,
          selectedIds: [],
          inspectorVisible: false,
          readerExpanded: false,
          agentMatch: undefined,
          searchOrder: { field: "relevance", descending: false },
        });
        message = query ? `Showing results for “${query}”` : "Search cleared";
      } else if (name === "set_library_view") {
        if (
          args.view === undefined &&
          args.sort === undefined &&
          args.descending === undefined
        )
          return fail("missing_setting");
        if (args.view !== undefined) {
          if (!["list", "grid", "map"].includes(String(args.view)))
            return fail("invalid_view");
          next.view = args.view === "map" ? "map" : "files";
          if (args.view !== "map") next.layout = args.view as "list" | "grid";
        }
        if (
          args.sort !== undefined &&
          ![
            "filename",
            "type",
            "date",
            ...(next.submitted ? ["relevance"] : []),
          ].includes(String(args.sort))
        )
          return fail("invalid_sort");
        if (
          args.descending !== undefined &&
          typeof args.descending !== "boolean"
        )
          return fail("invalid_sort");
        if (next.submitted)
          next.searchOrder = {
            field:
              typeof args.sort === "string"
                ? args.sort
                : next.searchOrder.field,
            descending:
              typeof args.descending === "boolean"
                ? args.descending
                : next.searchOrder.descending,
          };
        else if (args.sort !== undefined || args.descending !== undefined) {
          next.sort =
            typeof args.sort === "string"
              ? args.sort
              : next.recent
                ? "date"
                : next.sort;
          next.descending =
            typeof args.descending === "boolean"
              ? args.descending
              : next.recent || next.descending;
          next.recent = false;
        }
        message = "Library view updated";
      } else if (name === "select_files") {
        if (!p.ready) return fail("view_loading");
        if (
          !Array.isArray(args.document_ids) ||
          args.document_ids.length > 100 ||
          !args.document_ids.every(
            (id) =>
              typeof id === "string" &&
              p.documents.some((d) => d.document_id === id),
          )
        )
          return fail("files_not_in_view");
        Object.assign(next, {
          selectedIds: [...new Set(args.document_ids)],
          selected: undefined,
          inspectorVisible: false,
          readerExpanded: false,
          agentMatch: undefined,
        });
        message = `Selected ${next.selectedIds.length} file${next.selectedIds.length === 1 ? "" : "s"}`;
      } else if (name === "set_reader_view") {
        if (!next.selected || !next.inspectorVisible)
          return fail("reader_not_open");
        if (args.tab === undefined && args.expanded === undefined)
          return fail("missing_setting");
        if (args.tab !== undefined) {
          if (typeof args.tab !== "string" || !Object.hasOwn(tabs, args.tab))
            return fail("invalid_tab");
          if (
            args.tab === "evidence" &&
            !p.hasEvidence &&
            !agentMatch?.evidence?.length
          )
            return fail("no_evidence");
          next.inspectorTab = tabs[args.tab];
        }
        if (args.expanded !== undefined) {
          if (typeof args.expanded !== "boolean")
            return fail("invalid_setting");
          next.readerExpanded = args.expanded;
        }
        message = "Reader view updated";
      } else if (name === "close_document") {
        next.inspectorVisible = false;
        next.readerExpanded = false;
        next.agentMatch = undefined;
        message = "Reader closed";
      } else if (name === "scroll_view") {
        if (
          !["library", "reader"].includes(String(args.target)) ||
          !["up", "down", "top", "bottom"].includes(String(args.direction))
        )
          return fail("invalid_scroll");
        if (args.target === "reader" && !p.view.inspectorVisible)
          return fail("reader_not_open");
        const target = document.querySelector<HTMLElement>(
          args.target === "reader" ? ".inspector-content" : "#main-content",
        );
        if (!target?.getClientRects().length) return fail("view_unavailable");
        const top =
          args.direction === "top"
            ? 0
            : args.direction === "bottom"
              ? target.scrollHeight
              : target.scrollTop +
                target.clientHeight * (args.direction === "up" ? -0.85 : 0.85);
        target.scrollTo({ top, behavior: "instant" });
        return {
          ok: true,
          completed: true,
          action: name,
          reveal: true,
          message: `Scrolled ${args.target} ${args.direction}`,
          position: target.scrollTop,
          state: metadata(latest.current),
        };
      } else return fail("unknown_view");
      if (cancelled()) return fail("cancelled");
      const busy = userBusy();
      if (busy) return { ok: false, reason: "user_busy", message: busy };
      if (stamp(latest.current.view) !== initialStamp)
        return fail("view_changed");
      const previousId = history.state?.assistantView || crypto.randomUUID();
      views.current.set(previousId, before);
      history.replaceState({ ...history.state, assistantView: previousId }, "");
      p.update(next, name);
      setAgentOpened(next.agentOpened);
      setAgentMatch(next.agentMatch);
      if (opened && name === "highlight_evidence")
        p.highlight(opened, String(args.evidence_id));
      const nextId = crypto.randomUUID();
      views.current.set(nextId, next);
      if (views.current.size > 50)
        views.current.delete(views.current.keys().next().value!);
      history.pushState({ ...history.state, assistantView: nextId }, "");
      const needsResults = [
        "show_search",
        "clear_search",
        "navigate",
        "set_library_view",
      ].includes(name);
      // Give React and the app's existing data loaders time to commit the requested view.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const expected = stamp(next);
      while (
        !cancelled() &&
        stamp(latest.current.view) === expected &&
        needsResults &&
        !latest.current.ready &&
        !latest.current.error
      )
        await new Promise((resolve) => setTimeout(resolve, 50));
      if (signal?.aborted || !mounted.current) return fail("cancelled");
      if (stamp(latest.current.view) !== expected) return fail("view_changed");
      if (needsResults && latest.current.error)
        return {
          ok: false,
          reason: "view_load_failed",
          message: latest.current.error.slice(0, 2000),
          state: metadata(latest.current),
        };
      const completed = !needsResults || latest.current.ready;
      return {
        ok: true,
        completed,
        action: name,
        reveal: true,
        message: completed
          ? message
          : "View changed; results are still loading",
        ...(opened
          ? { opened: true, highlighted: name === "highlight_evidence" ? 1 : 0 }
          : {}),
        state: metadata(latest.current),
      };
    } finally {
      executing.current = false;
    }
  };
  return {
    command,
    context: metadata(props),
    agentOpened,
    agentMatch,
    setAgentOpened,
    setAgentMatch,
  };
}
