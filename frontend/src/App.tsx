import { sameValue } from "./api";
import {
  useCallback,
  useEffect,
  useRef,
  useMemo,
  useState,
  lazy,
  Suspense,
  type CSSProperties,
} from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import {
  MoreHorizontal,
  Upload,
  Folder,
  ChevronRight,
  Download,
  X,
} from "lucide-react";
import {
  api,
  uploadFile,
  indexingLabel,
  folderCounts,
  type Doc,
  type Library,
  type Link,
  type Rebuild,
} from "./api";
import {
  usePreference,
  reconcilePresentation,
  immediateFolders,
} from "./presentation";
import Sidebar from "./components/Sidebar";
import AppearanceMenu from "./components/AppearanceMenu";
import SearchBar, { type Mode } from "./components/SearchBar";
import FileList, { type SelectionEvent } from "./components/FileList";
const LibraryCanvas = lazy(() => import("./components/LibraryCanvas"));
import DocumentInspector from "./components/DocumentInspector";
import ResetOrganizationDialog from "./components/ResetOrganizationDialog";
import JevReviewDialog, { type ReviewMode } from "./components/JevReviewDialog";
import JevProgress from "./components/JevProgress";
import DeleteDialog, { type DeleteTarget } from "./components/DeleteDialog";
import OrganizationDialog, {
  type OrganizationTarget,
} from "./components/OrganizationDialog";
const empty: Library = {
  documents: [],
  total: 0,
  has_more: false,
  folders: {},
  groups: [],
  processing: false,
  max_file_bytes: 268435456,
  max_chunk_bytes: 262144,
};
type Transfer = {
  file: File;
  id: string;
  percent: number;
  state: string;
  error?: string;
  options?: { id: string; expected: string };
  document?: Doc;
};
export default function App() {
  const [library, setLibrary] = useState<Library>(empty),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const [folder, setFolder] = useState<string>(),
    [group, setGroup] = useState<string>(),
    [recent, setRecent] = useState(false);
  const [scopeNotice, setScopeNotice] = useState("");
  const [view, setView] = usePreference<"map" | "files">(
    library.library_id,
    "view",
    localStorage.getItem("symbiknow.view") === "map" ? "map" : "files",
    (v) => ["map", "files"].includes(v),
  );
  const [layout, setLayout] = usePreference<"list" | "grid">(
    library.library_id,
    "fileLayout",
    "list",
    (v) => ["list", "grid"].includes(v),
  );
  const [sidebarWidth, setSidebarWidth] = usePreference(
    library.library_id,
    "sidebarWidth",
    224,
    (v) => Number.isFinite(v) && v >= 200 && v <= 320,
  );
  const [inspectorWidth, setInspectorWidth] = usePreference(
    library.library_id,
    "inspectorWidth",
    420,
    (v) => Number.isFinite(v) && v >= 340 && v <= 600,
  );
  const [density, setDensity] = usePreference<"compact" | "comfortable">(
    library.library_id,
    "density",
    "compact",
    (v) => ["compact", "comfortable"].includes(v),
  );
  const [readerExpanded, setReaderExpanded] = useState(false);
  const [searchSort, setSearchSort] = useState("relevance");
  const [mode, setMode] = usePreference<Mode>(
    library.library_id,
    "mode",
    "hybrid",
    (v) => ["hybrid", "semantic", "keyword"].includes(v),
  );
  const [evaluate, setEvaluate] = usePreference(
    library.library_id,
    "jev",
    localStorage.getItem("symbiknow.jev") === "true",
    (v) => typeof v === "boolean",
  );
  const [loadedScope, setLoadedScope] = useState("");
  const wantedScope = JSON.stringify([folder, group, recent]);
  const [sort, setSort] = useState("filename"),
    [descending, setDescending] = useState(false);
  const [query, setQuery] = useState(""),
    [submitted, setSubmitted] = useState(""),
    [searchNonce, setSearchNonce] = useState(0);
  const [rawMatches, setMatches] = useState<Doc[]>([]),
    [searching, setSearching] = useState(false),
    [searchError, setSearchError] = useState(""),
    [unavailable, setUnavailable] = useState(false),
    [answer, setAnswer] = useState<{
      status: string;
      candidate_count?: number;
      evaluated_count?: number;
    }>({ status: "not_requested" });
  const [inspectorVisible, setInspectorVisible] = useState(false);
  const [selected, setSelected] = useState<Doc>(),
    [selectedIds, setSelectedIds] = useState<string[]>([]),
    [inspectorTab, setInspectorTab] = useState("preview"),
    [links, setLinks] = useState<Link[]>([]),
    [neighbors, setNeighbors] = useState<Doc[]>([]),
    [chosenLink, setChosenLink] = useState<Link>(),
    [open, setOpen] = useState(false);
  const [evidenceNavigation, setEvidenceNavigation] = useState<{
    sequence: number;
    document_id: string;
    version: string;
  }>();
  const [layoutRevision, setLayoutRevision] = useState(0),
    [deleteTarget, setDeleteTarget] = useState<DeleteTarget>(),
    [organizationTarget, setOrganizationTarget] =
      useState<OrganizationTarget>();
  const [reviewMode, setReviewMode] = useState<ReviewMode>();
  const [resetOpen, setResetOpen] = useState(false),
    [rebuild, setRebuild] = useState<Rebuild | null>(null),
    [progressHidden, setProgressHidden] = useState(false),
    [transfers, setTransfers] = useState<Transfer[]>([]),
    [dragging, setDragging] = useState(false),
    [downloadBusy, setDownloadBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null),
    fileInput = useRef<HTMLInputElement>(null),
    updateInput = useRef<HTMLInputElement>(null),
    updateDoc = useRef<Doc | undefined>(undefined),
    lastFocus = useRef<HTMLElement | null>(null),
    anchor = useRef<string>("");
  const main = useRef<HTMLElement>(null),
    scrolls = useRef(new Map<string, number>());
  const libraryGeneration = useRef(0),
    searchGeneration = useRef(0),
    searchAbort = useRef<AbortController | undefined>(undefined);
  const showSearch = !!submitted,
    busy = !!rebuild && ["queued", "running"].includes(rebuild.status);
  const matches = useMemo(
    () =>
      rawMatches.flatMap((d) => {
        if (loadedScope !== wantedScope) return [d];
        const current = library.documents.find(
          (item) => item.document_id === d.document_id,
        );
        if (!current) return library.has_more ? [d] : [];
        if (
          current.version !== d.version ||
          (current.status && current.status !== "indexed") ||
          !(
            folder === undefined ||
            current.folder === folder ||
            (!!folder && current.folder?.startsWith(folder + " / "))
          ) ||
          (group && !current.groups?.includes(group))
        )
          return [];
        return [
          {
            ...d,
            folder: current.folder,
            groups: current.groups,
            organization_status: current.organization_status,
          },
        ];
      }),
    [
      rawMatches,
      loadedScope,
      wantedScope,
      library.documents,
      library.has_more,
      folder,
      group,
    ],
  );
  const checked = matches.filter((d) => d.jev?.status === "evaluated").length;
  const searchIntent = JSON.stringify([
    submitted,
    mode,
    evaluate,
    folder,
    group,
    searchNonce,
  ]);
  const [resultIntent, setResultIntent] = useState("");
  const hasSearchResults = resultIntent === searchIntent;
  const activeSearch = useRef<
    | { intent: string; revision: string; controller: AbortController }
    | undefined
  >(undefined);
  const wantedSearch = useRef({ intent: "", revision: "" });
  const [searchCompletion, setSearchCompletion] = useState(0);
  const activeLibrary = useRef<
    { scope: string; generation: number } | undefined
  >(undefined);
  const visibleDocs = useMemo(() => {
    if (!showSearch || searchSort === "relevance")
      return showSearch ? matches : library.documents;
    return [...matches].sort((a, b) => {
      const field =
        searchSort === "date"
          ? "created_at"
          : searchSort === "type"
            ? "mime_type"
            : "filename";
      return String(a[field] || "").localeCompare(
        String(b[field] || ""),
        undefined,
        { numeric: true },
      );
    });
  }, [showSearch, matches, library.documents, searchSort]);
  useEffect(() => setSearchSort("relevance"), [submitted]);
  const libraryVersions = library.documents
    .map((d) => d.document_id + ":" + d.version)
    .join(",");
  const contextKey = `${folder ?? "*"}:${group || ""}:${recent}:${submitted}:${view}:${layout}`;
  const selection = visibleDocs.filter((d) =>
    selectedIds.includes(d.document_id),
  );
  function applyPresentationChange(r: Library) {
    if (reconcilePresentation(r)) setLayoutRevision((n) => n + 1);
  }
  const load = useCallback(
    async (more = false, quiet = false) => {
      const requestScope = JSON.stringify([
        folder,
        group,
        recent,
        sort,
        descending,
      ]);
      if (quiet && activeLibrary.current?.scope === requestScope) return;
      const generation = ++libraryGeneration.current;
      activeLibrary.current = { scope: requestScope, generation };
      if (!quiet) setLoading(true);
      try {
        const p = new URLSearchParams({
          offset: String(more ? library.documents.length : 0),
          limit: String(
            more ? 60 : Math.min(100, Math.max(60, library.documents.length)),
          ),
          recent: String(recent),
          sort,
          descending: String(descending),
        });
        if (folder !== undefined) p.set("folder", folder);
        if (group) p.set("group", group);
        const r = await api<Library>("library?" + p);
        // Poll every loaded page without exceeding the API's 100-row bound.
        if (!more && quiet) {
          while (r.has_more && r.documents.length < library.documents.length) {
            p.set("offset", String(r.documents.length));
            p.set(
              "limit",
              String(
                Math.min(100, library.documents.length - r.documents.length),
              ),
            );
            const next = await api<Library>("library?" + p);
            r.documents.push(...next.documents);
            r.has_more = next.has_more;
          }
        }
        if (generation !== libraryGeneration.current) return;
        applyPresentationChange(r);
        setLibrary((old) => {
          const byId = new Map(old.documents.map((d) => [d.document_id, d]));
          const next = {
            ...r,
            documents: more
              ? [...old.documents, ...r.documents]
              : r.documents.map((d) => {
                  const existing = byId.get(d.document_id);
                  return existing && sameValue(existing, d) ? existing : d;
                }),
          };
          return sameValue(old, next) ? old : next;
        });
        setLoadedScope(JSON.stringify([folder, group, recent]));
        setError("");
        if (folder && !(folder in folderCounts(r.folders))) {
          const parts = folder.split(" / ");
          let next: string | undefined;
          while (parts.length > 1) {
            parts.pop();
            if (parts.join(" / ") in folderCounts(r.folders)) {
              next = parts.join(" / ");
              break;
            }
          }
          setScopeNotice(
            `The folder ${folder} is no longer available. Showing ${next || "All files"}.`,
          );
          setFolder(next);
        }
        if (group && !r.groups.includes(group)) setGroup(undefined);
      } catch (e) {
        if (generation === libraryGeneration.current)
          setError((e as Error).message);
      } finally {
        if (generation === libraryGeneration.current) setLoading(false);
        if (activeLibrary.current?.generation === generation)
          activeLibrary.current = undefined;
      }
    },
    [folder, group, recent, sort, descending, library.documents.length],
  );
  useEffect(() => {
    void load();
  }, [folder, group, recent, sort, descending]);
  useEffect(() => {
    let busy = false;
    let canceled = false;
    const poll = async () => {
      if (busy || document.hidden) return;
      busy = true;
      try {
        const next =
          await api<
            Pick<
              Library,
              "index_revision" | "organization_revision" | "processing"
            >
          >("progress");
        if (canceled) return;
        if (
          next.index_revision !== library.index_revision ||
          next.organization_revision !== library.organization_revision
        )
          await load(false, true);
        else
          setLibrary((old) =>
            old.processing === next.processing
              ? old
              : { ...old, processing: next.processing },
          );
        const job = await api<Rebuild | null>("rebuild");
        if (!canceled) setRebuild((old) => (sameValue(old, job) ? old : job));
      } catch {
        /* Next visible poll retries. */
      } finally {
        busy = false;
      }
    };
    const interval = setInterval(() => void poll(), 4000);
    document.addEventListener("visibilitychange", poll);
    void api<Rebuild | null>("rebuild")
      .then(setRebuild)
      .catch(() => {});
    return () => {
      canceled = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [load, library.index_revision, library.organization_revision]);
  useEffect(() => {
    if (rebuild) void load(false, true);
  }, [rebuild?.request_id, rebuild?.status, rebuild?.phase]);
  useEffect(() => {
    const revision = JSON.stringify([
      libraryVersions,
      library.organization_revision,
      library.index_revision,
    ]);
    wantedSearch.current = { intent: searchIntent, revision };
    if (!submitted || loadedScope !== wantedScope) {
      activeSearch.current?.controller.abort();
      activeSearch.current = undefined;
      ++searchGeneration.current;
      return;
    }
    // Publications queue one latest revision; they do not cancel useful work.
    if (activeSearch.current?.intent === searchIntent) return;
    activeSearch.current?.controller.abort();
    const c = new AbortController(),
      n = ++searchGeneration.current;
    const request = { intent: searchIntent, revision, controller: c };
    activeSearch.current = request;
    searchAbort.current = c;
    setSearching(true);
    setSearchError("");
    let succeeded = false;
    api<{
      matches: Doc[];
      evaluation: { status: string };
      status: string;
      answer?: {
        status: string;
        candidate_count?: number;
        evaluated_count?: number;
      };
    }>(
      "search",
      { query: submitted, mode, evaluate, folder, group, limit: 40 },
      c.signal,
    )
      .then((r) => {
        if (n !== searchGeneration.current) return;
        succeeded = true;
        setMatches(r.matches);
        setResultIntent(searchIntent);
        setUnavailable(
          r.evaluation.status === "unavailable" ||
            r.answer?.status === "unavailable",
        );
        setAnswer(r.answer || { status: "not_requested" });
        if (r.status === "indexing_disabled")
          setSearchError(
            "Indexing is disabled. Stored files remain available in All files.",
          );
      })
      .catch((e) => {
        if (e.name !== "AbortError" && n === searchGeneration.current)
          setSearchError(e.message);
      })
      .finally(() => {
        if (n !== searchGeneration.current) return;
        activeSearch.current = undefined;
        setSearching(false);
        if (
          succeeded &&
          wantedSearch.current.intent === request.intent &&
          wantedSearch.current.revision !== request.revision
        )
          setSearchCompletion((value) => value + 1);
      });
  }, [
    searchIntent,
    submitted,
    mode,
    evaluate,
    folder,
    group,
    searchNonce,
    libraryVersions,
    library.organization_revision,
    library.index_revision,
    loadedScope,
    searchCompletion,
  ]);
  useEffect(
    () => () => {
      activeSearch.current?.controller.abort();
    },
    [],
  );
  useEffect(() => {
    // Scope/query changes invalidate selection only after the new visible set is available.
    if (loading || searching || open || chosenLink) return;
    const ids = new Set(visibleDocs.map((d) => d.document_id));
    setSelectedIds((old) => old.filter((id) => ids.has(id)));
    if (selected && !ids.has(selected.document_id)) setSelected(undefined);
  }, [
    folder,
    group,
    recent,
    submitted,
    libraryVersions,
    matches,
    loading,
    searching,
  ]);
  useEffect(() => {
    const c = new AbortController();
    setLinks([]);
    setNeighbors([]);
    if (!selected) return;
    api<{ documents: Doc[]; links: Link[] }>(
      `neighborhood?id=${selected.document_id}&version=${selected.version}`,
      undefined,
      c.signal,
    )
      .then((r) => {
        if (!c.signal.aborted) {
          setLinks(r.links);
          setNeighbors(r.documents);
        }
      })
      .catch(() => {});
    return () => c.abort();
  }, [
    selected?.document_id,
    selected?.version,
    rebuild?.completed,
    library.organization_revision,
    libraryVersions,
  ]);
  const select = useCallback(
    (d: Doc, e?: SelectionEvent) => {
      lastFocus.current = document.activeElement as HTMLElement;
      setChosenLink(undefined);
      if (selected?.document_id !== d.document_id) setInspectorTab("preview");
      if (e?.shiftKey && anchor.current) {
        const first = visibleDocs.findIndex(
            (x) => x.document_id === anchor.current,
          ),
          last = visibleDocs.findIndex((x) => x.document_id === d.document_id);
        setSelectedIds(
          visibleDocs
            .slice(Math.min(first, last), Math.max(first, last) + 1)
            .map((x) => x.document_id),
        );
        setSelected(undefined);
      } else if (e?.metaKey || e?.ctrlKey) {
        setSelectedIds((old) =>
          old.includes(d.document_id)
            ? old.filter((id) => id !== d.document_id)
            : [...old, d.document_id],
        );
        setSelected(undefined);
        anchor.current = d.document_id;
      } else {
        setSelected((old) => (old?.document_id === d.document_id ? old : d));
        setSelectedIds([d.document_id]);
        anchor.current = d.document_id;
      }
    },
    [visibleDocs, selected?.document_id],
  );
  const openDoc = useCallback(
    (d: Doc) => {
      select(d);
      setInspectorVisible(true);
    },
    [select],
  );
  const evidenceDoc = useCallback(
    (d: Doc) => {
      select(d);
      setSelected(d);
      setInspectorTab("evidence");
      setEvidenceNavigation((old) => ({
        sequence: (old?.sequence || 0) + 1,
        document_id: d.document_id,
        version: d.version,
      }));
      setInspectorVisible(true);
    },
    [select],
  );
  const quickLookDoc = useCallback(
    (d: Doc) => {
      select(d);
      setInspectorVisible(true);
      setOpen(true);
    },
    [select],
  );
  function closeInspector() {
    setInspectorVisible(false);
    setReaderExpanded(false);
    setChosenLink(undefined);
    requestAnimationFrame(() => {
      const control = selected
        ? document.querySelector<HTMLButtonElement>(
            `[data-document-id="${selected.document_id}"] .file-select, [data-document-id="${selected.document_id}"] .canvas-title`,
          )
        : undefined;
      (
        (lastFocus.current?.isConnected ? lastFocus.current : undefined) ||
        control
      )?.focus();
    });
  }
  function clear() {
    searchAbort.current?.abort();
    ++searchGeneration.current;
    setSubmitted("");
    setQuery("");
    setMatches([]);
    setSearchError("");
    setSearching(false);
    setUnavailable(false);
    setSelected(undefined);
    setSelectedIds([]);
    setChosenLink(undefined);
  }
  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      if (
        e.defaultPrevented ||
        (e.target as HTMLElement)?.closest('[role="dialog"],[role="menu"]')
      )
        return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        input.current?.focus();
      }
      const typing = (e.target as HTMLElement)?.closest(
        "input,textarea,select,[contenteditable=true]",
      );
      if (
        e.key === "Escape" &&
        !resetOpen &&
        !reviewMode &&
        !organizationTarget &&
        !deleteTarget &&
        !open
      )
        closeInspector();
      if (
        !typing &&
        !open &&
        (e.target as HTMLElement)?.closest(".file-select,.canvas-title") &&
        ["ArrowUp", "ArrowDown"].includes(e.key)
      ) {
        e.preventDefault();
        const index = visibleDocs.findIndex(
          (d) => d.document_id === selected?.document_id,
        );
        const next =
          visibleDocs[
            Math.max(
              0,
              Math.min(
                visibleDocs.length - 1,
                index + (e.key === "ArrowDown" ? 1 : -1),
              ),
            )
          ];
        if (next) {
          select(next);
          requestAnimationFrame(() =>
            document
              .querySelector<HTMLButtonElement>(
                `[data-document-id="${next.document_id}"] .file-select, [data-document-id="${next.document_id}"] .canvas-title`,
              )
              ?.focus(),
          );
        }
      }
      if (
        !typing &&
        !open &&
        !resetOpen &&
        !reviewMode &&
        !organizationTarget &&
        (e.metaKey || e.ctrlKey) &&
        e.key.toLowerCase() === "a"
      ) {
        e.preventDefault();
        setSelectedIds(visibleDocs.map((d) => d.document_id));
        setSelected(undefined);
      }
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [
    selected,
    visibleDocs,
    open,
    resetOpen,
    reviewMode,
    organizationTarget,
    deleteTarget,
  ]);
  useEffect(() => {
    const node = main.current;
    if (!node) return;
    node.scrollTop = scrolls.current.get(contextKey) || 0;
  }, [contextKey]);
  const pending = transfers.filter(
    (t) =>
      t.document &&
      t.percent === 100 &&
      !t.error &&
      t.state === indexingLabel("pending"),
  );
  useEffect(() => {
    if (!pending.length) return;
    const c = new AbortController();
    let busy = false;
    const poll = async () => {
      if (busy || document.hidden) return;
      busy = true;
      try {
        const result = await api<{ documents: Record<string, Doc> }>(
          "statuses",
          {
            document_ids: pending.map((t) => t.document!.document_id),
          },
          c.signal,
        );
        if (!c.signal.aborted)
          setTransfers((ts) =>
            ts.map((item) => {
              const row =
                item.document && result.documents[item.document.document_id];
              return row
                ? {
                    ...item,
                    state:
                      row.version === item.document!.version
                        ? indexingLabel(row.status)
                        : "Stored · Historical version",
                  }
                : item;
            }),
          );
      } catch {
        /* Next status poll retries. */
      } finally {
        busy = false;
      }
    };
    void poll();
    const interval = setInterval(() => void poll(), 4000);
    return () => {
      c.abort();
      clearInterval(interval);
    };
  }, [pending.map((t) => t.id).join(",")]);
  async function transfer(item: Transfer) {
    setTransfers((ts) =>
      ts.map((t) =>
        t.id === item.id ? { ...t, error: undefined, state: "Uploading" } : t,
      ),
    );
    try {
      const d = await uploadFile(
        item.file,
        (n) =>
          setTransfers((ts) =>
            ts.map((t) => (t.id === item.id ? { ...t, percent: n } : t)),
          ),
        { requestId: item.id, ...item.options },
        library,
      );
      setTransfers((ts) =>
        ts.map((t) =>
          t.id === item.id
            ? {
                ...t,
                document: d,
                state: indexingLabel(d.status),
                percent: 100,
              }
            : t,
        ),
      );
      await load(false, true);
      if (item.options) {
        select(d);
        // An explicit successful update opens the newly stored version.
        setSelected(d);
      }
    } catch (e) {
      setTransfers((ts) =>
        ts.map((t) =>
          t.id === item.id
            ? { ...t, state: "Failed", error: (e as Error).message }
            : t,
        ),
      );
    }
  }
  const uploadQueue = useRef(Promise.resolve());
  function addFiles(files: File[], updating?: Doc) {
    const items: Transfer[] = files.map((file) => ({
      file,
      id: crypto.randomUUID(),
      percent: 0,
      state: "Queued",
      options: updating
        ? { id: updating.document_id, expected: updating.version }
        : undefined,
    }));
    setTransfers((ts) => [...ts, ...items]);
    uploadQueue.current = uploadQueue.current.then(async () => {
      for (const item of items) await transfer(item);
    });
  }
  function update(d: Doc) {
    updateDoc.current = d;
    updateInput.current?.click();
  }
  async function bulkDownload() {
    setDownloadBusy(true);
    setError("");
    try {
      const r = await fetch("/api/bulk-download", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Symbiknow-UI": "1" },
        body: JSON.stringify({
          prepare: true,
          documents: selection.map((d) => ({
            document_id: d.document_id,
            version: d.version,
          })),
        }),
      });
      if (!r.ok) {
        const e = await r.json();
        throw new Error(
          e.error +
            (e.failures
              ? " " +
                e.failures
                  .map(
                    (f: { document_id: string; error: string }) =>
                      (selection.find((d) => d.document_id === f.document_id)
                        ?.filename || f.document_id) +
                      ": " +
                      f.error,
                  )
                  .join("; ")
              : ""),
        );
      }
      const { url } = await r.json();
      const a = document.createElement("a");
      a.href = url;
      a.download = "Symbiknow files.zip";
      a.click();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDownloadBusy(false);
    }
  }
  function resize(
    side: "sidebar" | "inspector",
    e: React.PointerEvent<HTMLDivElement>,
  ) {
    e.currentTarget.setPointerCapture(e.pointerId);
    const start = e.clientX,
      width = side === "sidebar" ? sidebarWidth : inspectorWidth;
    const move = (event: PointerEvent) => {
      const next = Math.max(
        side === "sidebar" ? 200 : 340,
        Math.min(
          side === "sidebar" ? 320 : 600,
          width + (event.clientX - start) * (side === "sidebar" ? 1 : -1),
        ),
      );
      if (side === "sidebar") setSidebarWidth(next);
      else setInspectorWidth(next);
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  }
  const states = library.processing_states || {};
  const status =
    loading && !library.library_id
      ? "Connecting…"
      : error
        ? "Connection lost · Retry"
        : busy
          ? rebuild?.mode === "links"
            ? "Jev is reviewing links…"
            : rebuild?.mode === "unfiled"
              ? "Jev is grouping unfiled files…"
              : "Reset & rebuild running"
          : library.processing || states.pending
            ? "Processing files…"
            : states.organization_pending
              ? `${states.organization_pending} organization pending`
              : states.failed || states.disabled || states.organization_failed
                ? "Some files need attention"
                : "Up to date";
  const scopedFolders = library.scoped_folders ?? library.folders;
  const childFolders = immediateFolders(scopedFolders, folder);
  const mapDocs = [
    ...visibleDocs,
    ...neighbors.filter(
      (d) => !visibleDocs.some((item) => item.document_id === d.document_id),
    ),
  ].slice(0, 100);
  const canvas = (
    <Suspense
      fallback={
        <div className="loading" role="status">
          Loading canvas…
        </div>
      }
    >
      <LibraryCanvas
        key={JSON.stringify([
          layoutRevision,
          folder,
          group,
          showSearch,
          showSearch ? [submitted, mode, evaluate] : null,
        ])}
        docs={mapDocs}
        links={links}
        selected={selected?.document_id}
        selectedIds={selectedIds}
        onSelect={select}
        onOpen={openDoc}
        onEvidence={evidenceDoc}
        onQuickLook={quickLookDoc}
        onLink={(l) => {
          setInspectorVisible(true);
          if (!selected)
            select(
              mapDocs.find((d) => d.document_id === l.source_document_id)!,
            );
          setChosenLink(l);
        }}
        search={showSearch}
        query={submitted}
        evaluate={evaluate}
        unavailable={unavailable}
        matchedIds={matches.map((d) => d.document_id)}
        searchKey={JSON.stringify([submitted, mode, evaluate, group])}
        libraryId={library.library_id || "loading"}
        scope={folder}
        folders={scopedFolders}
        total={showSearch ? matches.length : library.total}
        onFolder={setFolder}
      />
    </Suspense>
  );
  const files = (
    <FileList
      docs={visibleDocs}
      selectedIds={selectedIds}
      onSelect={select}
      onOpen={openDoc}
      onEvidence={evidenceDoc}
      onQuickLook={quickLookDoc}
      search={showSearch}
      query={submitted}
      evaluate={evaluate}
      unavailable={unavailable}
      layout={layout}
      scope={folder}
      sort={showSearch ? searchSort : recent ? "date" : sort}
      descending={recent || descending}
      onSort={(s) => {
        if (showSearch) {
          setSearchSort(s);
          return;
        }
        if (recent) {
          setRecent(false);
          setSort(s);
          setDescending(false);
        } else if (sort === s) setDescending((v) => !v);
        else {
          setSort(s);
          setDescending(false);
        }
      }}
      onMove={(docs) =>
        setOrganizationTarget({ action: "move-documents", docs })
      }
      onUpdate={update}
      onVersions={(d) => {
        select(d);
        setInspectorVisible(true);
        setInspectorTab("history");
      }}
      onDelete={(doc) => setDeleteTarget({ kind: "document", doc })}
      busy={busy}
    />
  );
  return (
    <div
      data-density={density}
      className={
        "app " +
        (showSearch ? "searching " : "") +
        (inspectorVisible && selected ? "reader-open " : "") +
        (readerExpanded ? "reader-expanded" : "")
      }
      style={
        {
          "--sidebar-width": sidebarWidth + "px",
          "--inspector-width": inspectorWidth + "px",
        } as CSSProperties
      }
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node))
          setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        addFiles(Array.from(e.dataTransfer.files));
      }}
    >
      <Sidebar
        key={library.library_id + ":" + layoutRevision}
        folders={library.folders}
        folder={folder}
        recent={recent}
        libraryId={library.library_id}
        total={
          library.library_total ??
          Object.values(library.folders).reduce((a, b) => a + b, 0)
        }
        status={status}
        busy={busy}
        onDelete={(folder, count) =>
          setDeleteTarget({ kind: "folder", folder, count })
        }
        onEdit={(action, folder) => setOrganizationTarget({ action, folder })}
        onChoose={(f, r) => {
          setFolder(f);
          setRecent(!!r);
        }}
      />
      <div
        className="pane-resizer sidebar-resizer"
        role="separator"
        aria-label="Resize sidebar"
        aria-orientation="vertical"
        aria-valuenow={sidebarWidth}
        aria-valuemin={200}
        aria-valuemax={320}
        tabIndex={0}
        onPointerDown={(e) => resize("sidebar", e)}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            e.preventDefault();
            setSidebarWidth((w) =>
              Math.max(
                200,
                Math.min(320, w + (e.key === "ArrowRight" ? 10 : -10)),
              ),
            );
          }
        }}
      />
      <div className="workspace">
        <SearchBar
          inputRef={input}
          query={query}
          onQuery={setQuery}
          onSubmit={() => {
            if (query.trim()) {
              setSubmitted(query.trim());
              setSearchNonce((n) => n + 1);
            } else clear();
          }}
          onClear={clear}
          mode={mode}
          onMode={setMode}
          evaluate={evaluate}
          onEvaluate={setEvaluate}
          folder={folder}
          onFolder={setFolder}
          folders={library.folders}
          group={group}
          onGroup={setGroup}
          groups={library.groups}
          add={() => fileInput.current?.click()}
          submitted={showSearch}
          actions={
            <>
              <AppearanceMenu />
              <Menu.Root>
                <Menu.Trigger asChild>
                  <button
                    className="icon"
                    aria-label="Library actions"
                    title="Library actions"
                  >
                    <MoreHorizontal size={19} />
                  </button>
                </Menu.Trigger>
                <Menu.Portal>
                  <Menu.Content className="menu" align="end">
                    <Menu.Item
                      disabled={busy || !library.unfiled_review_count}
                      onSelect={() => setReviewMode("unfiled")}
                    >
                      Group unfiled files with Jev…
                    </Menu.Item>
                    <Menu.Item
                      disabled={busy || !library.library_total}
                      onSelect={() => setReviewMode("links")}
                    >
                      Review links only…
                    </Menu.Item>
                    <Menu.Separator className="menu-separator" />
                    <Menu.Item
                      disabled={busy}
                      onSelect={() => setResetOpen(true)}
                    >
                      Reset organization…
                    </Menu.Item>
                    <Menu.Item onSelect={() => void load()}>
                      Refresh library
                    </Menu.Item>
                    {rebuild && (
                      <Menu.Item onSelect={() => setProgressHidden(false)}>
                        Show Jev progress
                      </Menu.Item>
                    )}
                  </Menu.Content>
                </Menu.Portal>
              </Menu.Root>
            </>
          }
        />
        {transfers.length > 0 && (
          <div className="transfers" aria-live="polite">
            {transfers.map((t) => (
              <div key={t.id}>
                <Upload size={14} />
                <strong>{t.file.name}</strong>
                <span>
                  {t.state === "Uploading"
                    ? `Uploading ${t.percent}% · ${Math.round((t.file.size * t.percent) / 100).toLocaleString()} / ${t.file.size.toLocaleString()} bytes`
                    : t.state}
                </span>
                {t.error ? (
                  <>
                    <span className="error">{t.error}</span>
                    <button
                      onClick={() => {
                        uploadQueue.current = uploadQueue.current.then(() =>
                          transfer(t),
                        );
                      }}
                    >
                      Retry
                    </button>
                  </>
                ) : t.percent === 100 ? (
                  <button
                    onClick={() =>
                      setTransfers((ts) => ts.filter((x) => x.id !== t.id))
                    }
                  >
                    Dismiss
                  </button>
                ) : (
                  <progress max={100} value={t.percent} />
                )}
              </div>
            ))}
          </div>
        )}
        {rebuild && !progressHidden && (
          <JevProgress
            job={rebuild}
            onHide={() => setProgressHidden(true)}
            onRetry={() => {
              api<Rebuild>("rebuild", { retry: true })
                .then((job) => {
                  setRebuild(job);
                  setProgressHidden(false);
                })
                .catch((e) => setError(e.message));
            }}
          />
        )}
        <div
          className={
            "content " + (selected && inspectorVisible ? "has-inspector" : "")
          }
        >
          <main
            ref={main}
            onScroll={(e) =>
              scrolls.current.set(contextKey, e.currentTarget.scrollTop)
            }
            className={showSearch ? "search-main" : "library-main"}
          >
            {scopeNotice && (
              <div className="scope-notice" role="status">
                <span>{scopeNotice}</span>
                <button
                  className="icon"
                  aria-label="Dismiss folder notice"
                  onClick={() => setScopeNotice("")}
                >
                  <X size={14} />
                </button>
              </div>
            )}
            <div className="content-heading">
              <div className="location-heading">
                {folder && (
                  <div className="breadcrumbs">
                    <button onClick={() => setFolder(undefined)}>
                      Library
                    </button>
                    {folder.split(" / ").map((part, i) => (
                      <span key={i}>
                        <ChevronRight size={12} />
                        <button
                          title={folder
                            .split(" / ")
                            .slice(0, i + 1)
                            .join(" / ")}
                          onClick={() =>
                            setFolder(
                              folder
                                .split(" / ")
                                .slice(0, i + 1)
                                .join(" / "),
                            )
                          }
                        >
                          {part}
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <h1 title={folder}>
                  {showSearch
                    ? "Search results"
                    : recent
                      ? "Recent"
                      : folder === ""
                        ? "Unfiled"
                        : folder?.split(" / ").at(-1) || "All files"}
                </h1>
                <p className="secondary">
                  {showSearch
                    ? searching
                      ? hasSearchResults
                        ? `${matches.length} retrieved files · Refreshing…`
                        : "Searching…"
                      : `Showing ${matches.length} matches · ${evaluate ? `${answer.evaluated_count ?? checked} checked · ${matches.filter((d) => d.jev?.status === "evaluated" && d.evidence?.some((e) => !!e.text && d.jev?.supporting_chunk_ids?.includes(e.evidence_id))).length} supporting · ${matches.filter((d) => d.jev?.status === "evaluated" && d.jev?.possible_conflicting_chunk_ids?.length).length} possible conflict · ${Math.max(0, (answer.candidate_count ?? matches.length) - (answer.evaluated_count ?? checked))} not checked` : "Answer checking off"}${searchSort !== "relevance" ? " · Sorted loaded matches" : ""}`
                    : `${library.total} files${folder ? ` · ${childFolders.length} subfolders` : ""}${recent ? " · Latest version activity" : ""}`}
                </p>
              </div>
              <div className="library-actions">
                {folder === "" && !showSearch && (
                  <button
                    disabled={busy || !library.unfiled_review_count}
                    onClick={() => setReviewMode("unfiled")}
                    title="Review unfiled documents and add links without resetting"
                  >
                    Group with Jev
                  </button>
                )}
                <div className="segmented" aria-label="View">
                  {(["List", "Cards", "Canvas"] as const).map((name) => {
                    const active =
                      name === "Canvas"
                        ? view === "map"
                        : view === "files" &&
                          layout === (name === "List" ? "list" : "grid");
                    return (
                      <button
                        key={name}
                        aria-pressed={active}
                        className={active ? "active" : ""}
                        onClick={() => {
                          setView(name === "Canvas" ? "map" : "files");
                          if (name !== "Canvas")
                            setLayout(name === "List" ? "list" : "grid");
                        }}
                      >
                        {name}
                      </button>
                    );
                  })}
                </div>
                <select
                  aria-label="Display density"
                  value={density}
                  onChange={(e) =>
                    setDensity(e.target.value as "compact" | "comfortable")
                  }
                >
                  <option value="compact">Compact</option>
                  <option value="comfortable">Comfortable</option>
                </select>
              </div>
            </div>
            {error && (
              <div className="notice error" role="alert">
                {error}
                <button onClick={() => void load()}>Retry</button>
              </div>
            )}
            {selection.length > 1 && (
              <div className="bulk-toolbar">
                <strong>{selection.length} selected</strong>
                <span>Loaded files only</span>
                <button
                  disabled={downloadBusy}
                  onClick={() => void bulkDownload()}
                >
                  <Download size={15} />
                  {downloadBusy ? "Preparing…" : "Download selected"}
                </button>
                <button
                  disabled={busy}
                  title={
                    busy ? "Wait for Jev to finish" : "Move selected files"
                  }
                  onClick={() =>
                    setOrganizationTarget({
                      action: "move-documents",
                      docs: selection,
                    })
                  }
                >
                  Move to…
                </button>
                <button onClick={() => setSelectedIds([])}>
                  Clear selection
                </button>
              </div>
            )}
            {showSearch ? (
              <>
                {searchError && (
                  <p className="notice error" role="alert">
                    {searchError}
                    <button onClick={() => setSearchNonce((n) => n + 1)}>
                      Retry search
                    </button>
                  </p>
                )}
                {unavailable && (
                  <p className="notice">
                    {matches.some((m) => m.jev?.status === "evaluated")
                      ? "Some answer checks are unavailable. Only previously accepted answers are shown."
                      : "Answer checking is unavailable. Retry, or turn off Check answers to browse related files."}
                  </p>
                )}
                {!searching &&
                  evaluate &&
                  !unavailable &&
                  matches.length > 0 &&
                  answer.status === "partial" && (
                    <p className="notice">
                      These files answer only part of your question.
                    </p>
                  )}
                {searching && (
                  <div
                    className={hasSearchResults ? "notice" : "loading"}
                    role="status"
                  >
                    {hasSearchResults
                      ? "Refreshing search results…"
                      : "Finding useful evidence…"}
                  </div>
                )}
                {(hasSearchResults || !searching) &&
                  (matches.length
                    ? view === "map"
                      ? canvas
                      : files
                    : !searchError && (
                        <div className="empty">
                          <h2>
                            {evaluate
                              ? unavailable
                                ? "Answer checking unavailable"
                                : answer.status === "needs_context"
                                  ? "More context needed"
                                  : "No supported answer found"
                              : "No matching files"}
                          </h2>
                          <p>
                            {evaluate
                              ? unavailable
                                ? "This is not a no-answer judgment. Retry the check or browse related files."
                                : `Checked ${answer.evaluated_count ?? 0} of ${answer.candidate_count ?? 0} candidates in this scope. ${answer.status === "needs_context" ? "The evidence is ambiguous or conflicting." : "No answer was established in the checked passages."}`
                              : "Try different words, another mode, or a broader scope."}
                          </p>
                          {evaluate && (
                            <button onClick={() => setEvaluate(false)}>
                              Show related files
                            </button>
                          )}
                          <button onClick={clear}>Back to browsing</button>
                          {(folder !== undefined || group) && (
                            <button
                              onClick={() => {
                                setFolder(undefined);
                                setGroup(undefined);
                              }}
                            >
                              Clear scope
                            </button>
                          )}
                        </div>
                      ))}
              </>
            ) : (
              <>
                {folder &&
                  childFolders.length > 0 &&
                  view === "files" &&
                  layout === "grid" && (
                    <section className="subfolder-section">
                      <h3>Folders</h3>
                      <div className="subfolder-grid">
                        {childFolders.map(([path, count]) => (
                          <button
                            key={path}
                            title={path}
                            onClick={() => setFolder(path)}
                          >
                            <Folder size={24} />
                            <span>
                              <strong>{path.split(" / ").at(-1)}</strong>
                              <small>{count} files</small>
                            </span>
                            <ChevronRight size={16} />
                          </button>
                        ))}
                      </div>
                    </section>
                  )}
                {folder && view === "files" && layout === "grid" && (
                  <div className="folder-content-label">
                    <h3>Files in this folder</h3>
                    <span>Including subfolders</span>
                  </div>
                )}
                {loading && !library.documents.length ? (
                  <div className="loading" role="status">
                    Loading your library…
                  </div>
                ) : library.documents.length ? (
                  view === "map" ? (
                    canvas
                  ) : (
                    files
                  )
                ) : (
                  <div className="empty">
                    <Upload size={28} />
                    <h2>
                      {group
                        ? "No files match these filters"
                        : folder !== undefined
                          ? "This folder is empty"
                          : "Your knowledge, in one place"}
                    </h2>
                    <p>
                      {group
                        ? "Clear the group filter to see files in this scope."
                        : "Import documents to keep their originals, versions and useful connections."}
                    </p>
                    {group ? (
                      <button onClick={() => setGroup(undefined)}>
                        Clear filters
                      </button>
                    ) : (
                      <button onClick={() => fileInput.current?.click()}>
                        Import files
                      </button>
                    )}
                  </div>
                )}
                {library.documents.length > 0 && (
                  <div className="browse-footer">
                    <span>
                      Loaded {library.documents.length} · {library.total} files
                    </span>
                    {library.has_more && (
                      <button
                        disabled={
                          loading ||
                          (view === "map" && library.documents.length >= 100)
                        }
                        onClick={() => void load(true)}
                      >
                        Load more files
                      </button>
                    )}
                    {view === "map" &&
                      library.has_more &&
                      library.documents.length >= 100 && (
                        <span>
                          Canvas is limited to 100 cards. Choose a folder or use
                          Files.
                        </span>
                      )}
                  </div>
                )}
              </>
            )}
          </main>
          {selected && (
            <>
              {inspectorVisible && (
                <div
                  className="pane-resizer inspector-resizer"
                  role="separator"
                  aria-label="Resize inspector"
                  aria-orientation="vertical"
                  aria-valuenow={inspectorWidth}
                  aria-valuemin={340}
                  aria-valuemax={600}
                  tabIndex={0}
                  onPointerDown={(e) => resize("inspector", e)}
                  onKeyDown={(e) => {
                    if (["ArrowLeft", "ArrowRight"].includes(e.key)) {
                      e.preventDefault();
                      setInspectorWidth((w) =>
                        Math.max(
                          340,
                          Math.min(600, w + (e.key === "ArrowLeft" ? 10 : -10)),
                        ),
                      );
                    }
                  }}
                />
              )}
              <DocumentInspector
                hidden={!inspectorVisible}
                expanded={readerExpanded}
                onExpand={() => setReaderExpanded((v) => !v)}
                doc={selected}
                visibleIds={visibleDocs.map((d) => d.document_id)}
                initialTab={inspectorTab}
                evidenceNavigation={evidenceNavigation}
                onVersion={(version) =>
                  setSelected((d) => (d ? { ...d, version } : d))
                }
                onMove={(doc) =>
                  setOrganizationTarget({
                    action: "move-documents",
                    docs: [doc],
                  })
                }
                busy={busy}
                refreshKey={
                  libraryVersions +
                  ":" +
                  (rebuild?.completed || 0) +
                  ":" +
                  library.organization_revision
                }
                match={
                  hasSearchResults
                    ? matches.find(
                        (m) => m.document_id === selected.document_id,
                      )
                    : undefined
                }
                evaluate={evaluate}
                unavailable={unavailable}
                onClose={closeInspector}
                onSelect={select}
                onUpdate={update}
                onDelete={(doc) => setDeleteTarget({ kind: "document", doc })}
                open={open}
                onOpen={setOpen}
                link={chosenLink}
                onLink={setChosenLink}
              />
            </>
          )}
        </div>
      </div>
      <input
        className="sr-only"
        type="file"
        ref={fileInput}
        multiple
        aria-label="Upload files"
        onChange={(e) => {
          addFiles(Array.from(e.target.files || []));
          e.target.value = "";
        }}
      />
      <input
        className="sr-only"
        type="file"
        ref={updateInput}
        aria-label="Update selected file"
        onChange={(e) => {
          if (e.target.files?.[0] && updateDoc.current)
            addFiles([e.target.files[0]], updateDoc.current);
          e.target.value = "";
        }}
      />
      {reviewMode && (
        <JevReviewDialog
          key={reviewMode}
          mode={reviewMode}
          folder={folder}
          folders={library.folders}
          unfiledCount={library.unfiled_review_count || 0}
          onClose={() => setReviewMode(undefined)}
          onStart={async (args) => {
            const job = await api<Rebuild>("rebuild", args);
            setRebuild(job);
            setProgressHidden(false);
            await load(false, true);
          }}
        />
      )}
      <ResetOrganizationDialog
        open={resetOpen}
        setOpen={setResetOpen}
        folders={library.folders}
        folder={folder}
        onReset={async (args) => {
          const r = await api<Rebuild>("rebuild", args);
          setRebuild(r);
          setProgressHidden(false);
          await load(false, true);
        }}
      />
      <OrganizationDialog
        target={organizationTarget}
        folders={library.folders}
        onClose={() => setOrganizationTarget(undefined)}
        onDone={async (result) => {
          if (
            result.paths &&
            folder &&
            (folder === result.paths.from ||
              folder.startsWith(result.paths.from + " / "))
          )
            setFolder(result.paths.to + folder.slice(result.paths.from.length));
          await load(false, true);
          setSearchNonce((n) => n + 1);
        }}
      />
      <DeleteDialog
        target={deleteTarget}
        onClose={() => setDeleteTarget(undefined)}
        onDelete={async (target) => {
          if (target.kind === "document") {
            await api("delete-document", {
              document_id: target.doc.document_id,
              expected_version: target.doc.version,
            });
            setMatches((ms) =>
              ms.filter((d) => d.document_id !== target.doc.document_id),
            );
            closeInspector();
            setSelected(undefined);
            setSelectedIds([]);
            setOpen(false);
            setTransfers((ts) =>
              ts.filter(
                (t) => t.document?.document_id !== target.doc.document_id,
              ),
            );
          } else await api("delete-folder", { folder: target.folder });
          setSearchNonce((n) => n + 1);
          await load(false, true);
        }}
      />
      {dragging && (
        <div className="drop-overlay">
          <Upload size={36} />
          <h2>Drop files to import</h2>
        </div>
      )}
    </div>
  );
}
