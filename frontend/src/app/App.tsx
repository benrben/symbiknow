import { OrganizeIcon, ReviewIcon } from "../shared/components/KnowledgeIcons";
import { sameValue } from "../shared/api/client";
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
import OriginalInventory from "../features/library/components/OriginalInventory";
import {
  MoreHorizontal,
  MessageCircle,
  Upload,
  ChevronRight,
  Download,
  X,
  Archive,
  History,
  RefreshCw,
  RotateCcw,
  Sparkles,
} from "lucide-react";
import {
  api,
  peekCachedLibrary,
  waitForJob,
  type Job,
  type SearchResponse,
  folderCounts,
  type Doc,
  type Library,
  type Link,
  type Rebuild,
  type SearchAnswer,
} from "../shared/api/client";
import {
  usePreference,
  reconcilePresentation,
  immediateFolders,
} from "../shared/presentation/format";
const Assistant = lazy(() => import("../features/assistant/Assistant"));
import { useAppUI } from "../features/assistant/useAppUI";
import Sidebar from "../features/library/components/Sidebar";
import AppearanceMenu from "../features/appearance/components/AppearanceMenu";
import SearchBar, { type Mode } from "../features/search/components/SearchBar";
import FileList, { type SelectionEvent } from "../features/library/components/FileList";
const LibraryCanvas = lazy(() => import("../features/library/components/LibraryCanvas"));
const DocumentInspector = lazy(() => import("../features/reader/components/DocumentInspector"));
import ResetOrganizationDialog from "../features/organization/components/ResetOrganizationDialog";
import JevReviewDialog, { type ReviewMode } from "../features/organization/components/JevReviewDialog";
import ReviewHistory from "../features/organization/components/ReviewHistory";
import FreshnessReview from "../features/freshness/components/FreshnessReview";
import JevProgress from "../features/organization/components/JevProgress";
import JevDecisions from "../features/organization/components/JevDecisions";
import { useTransfers } from "../features/transfers/useTransfers";
import TransferPanel, { ImportFormats } from "../features/transfers/TransferPanel";
import { ConnectedWorkspace } from "../features/library/components/ConnectedWorkspace";
import ConnectionMap from "../features/connections/components/ConnectionMap";
import ReaderNavigator from "../features/reader/components/ReaderNavigator";
import { emptySearchMessage, hasNoStrongMatch, reconcileSearchMatches, sortSearchMatches } from "../features/search/presentation";
import DeleteDialog, { type DeleteTarget } from "../features/library/components/DeleteDialog";
import OrganizationDialog, {
  type OrganizationTarget,
} from "../features/organization/components/OrganizationDialog";
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
export default function App() {
  const [assistantLauncher, setAssistantLauncher] = useState<HTMLButtonElement | null>(null);
  const [assistantVisible, setAssistantVisible] = useState(false);
  const [library, setLibrary] = useState<Library>(empty),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const [folder, setFolder] = useState<string>(),
    [group, setGroup] = useState<string>(),
    [recent, setRecent] = useState(false);
  const [scopeNotice, setScopeNotice] = useState("");
  const pageCursors = useRef<(string | undefined)[]>([undefined]);
  const pageIndex = useRef(0);
  const libraryAbort = useRef<AbortController | undefined>(undefined);
  const taxonomyCursor = useRef("");
  const [view, setView] = usePreference<"map" | "files">(
    library.library_id,
    "connectedView",
    "files",
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
  const [freeformMap, setFreeformMap] = usePreference(
    library.library_id,
    "freeformMap",
    false,
    (v) => typeof v === "boolean",
  );
  const [linksLoading, setLinksLoading] = useState(false);
  const [linksError, setLinksError] = useState("");
  const [linksRetry, setLinksRetry] = useState(0);
  const restoringReader = useRef(false);
  useEffect(() => {
    if (restoringReader.current) { restoringReader.current = false; return; }
    setReaderExpanded(false);
    setInspectorVisible(false);
  }, [folder, group, recent]);
  const [searchOrder, setSearchOrder] = useState({ field: "relevance", descending: false });
  const { field: searchSort, descending: searchDescending } = searchOrder;
  const [mode, setMode] = usePreference<Mode>(
    library.library_id,
    "searchToolMode",
    "semantic",
    (v) => ["semantic", "grep"].includes(v),
  );
  const [evaluate, setEvaluate] = usePreference(
    library.library_id,
    "jev",
    localStorage.getItem("symbiknow.jev") === "true",
    (v) => typeof v === "boolean",
  );
  const [loadedScope, setLoadedScope] = useState("");
  const [sort, setSort] = useState("filename"),
    [descending, setDescending] = useState(false);
  const wantedScope = JSON.stringify([folder, group, recent, sort, descending]);
  const [query, setQuery] = useState(""),
    [submitted, setSubmitted] = useState(""),
    [searchNonce, setSearchNonce] = useState(0);
  const [rawMatches, setMatches] = useState<Doc[]>([]),
    [searching, setSearching] = useState(false),
    [searchError, setSearchError] = useState(""),
    [unavailable, setUnavailable] = useState(false),
    [answer, setAnswer] = useState<SearchAnswer>({ status: "not_requested" });
  const [inspectorVisible, setInspectorVisible] = useState(false);
  const [inventoryOpen, setInventoryOpen] = useState(false);
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
    evidence_id?: string;
    agent?: boolean;
  }>();
  const [layoutRevision, setLayoutRevision] = useState(0),
    [deleteTarget, setDeleteTarget] = useState<DeleteTarget>(),
    [organizationTarget, setOrganizationTarget] =
      useState<OrganizationTarget>();
  const [reviewMode, setReviewMode] = useState<ReviewMode>();
  const [reviewHistoryOpen, setReviewHistoryOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false),
    [rebuild, setRebuild] = useState<Rebuild | null>(null),
    [progressHidden, setProgressHidden] = useState(true),
    [dragging, setDragging] = useState(false),
    [downloadBusy, setDownloadBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null),
    fileInput = useRef<HTMLInputElement>(null),
    updateInput = useRef<HTMLInputElement>(null),
    updateDoc = useRef<Doc | undefined>(undefined),
    lastFocus = useRef<HTMLElement | null>(null),
    readerOrigin = useRef<HTMLElement | null>(null),
    previewOrigin = useRef<HTMLElement | null>(null),
    anchor = useRef<string>("");
  const main = useRef<HTMLElement>(null),
    scrolls = useRef(new Map<string, number>());
  const libraryGeneration = useRef(0),
    searchGeneration = useRef(0),
    searchAbort = useRef<AbortController | undefined>(undefined);
  const showSearch = !!submitted,
    busy = !!rebuild && ["queued", "running"].includes(rebuild.status);
  const scopeLabel = [folder === "" ? "Unfiled" : folder || "All files", group && `topic ${group}`].filter(Boolean).join(" · ");
  const matches = useMemo(
    () =>
      reconcileSearchMatches(rawMatches, library.documents, loadedScope === wantedScope, folder, group),
    [
      rawMatches,
      loadedScope,
      wantedScope,
      library.documents,
      folder,
      group,
    ],
  );
  const checked = matches.filter((d) => d.jev?.status === "evaluated").length;
  const emptySearch = emptySearchMessage(answer, evaluate, unavailable);
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
    return sortSearchMatches(matches, searchSort, searchDescending);
  }, [showSearch, matches, library.documents, searchSort, searchDescending]);
  const restoringSearchOrder = useRef(false);
  useEffect(() => {
    if (restoringSearchOrder.current) { restoringSearchOrder.current = false; return; }
    setSearchOrder({ field: "relevance", descending: false });
  }, [submitted]);
  const libraryVersions = library.documents
    .map((d) => d.document_id + ":" + d.version)
    .join(",");
  const contextKey = `${folder ?? "*"}:${group || ""}:${recent}:${submitted}:${view}:${layout}`;
  const featured = useMemo(() => [...visibleDocs].sort((a, b) =>
    (b.created_at || "").localeCompare(a.created_at || "") || a.filename.localeCompare(b.filename))[0], [visibleDocs]);
  const focusDoc = selected || (!showSearch && loadedScope === wantedScope ? featured : undefined);
  const selection = visibleDocs.filter((d) =>
    selectedIds.includes(d.document_id),
  );
  function applyPresentationChange(r: Library) {
    if (reconcilePresentation(r)) setLayoutRevision((n) => n + 1);
  }
  const load = useCallback(
    async (more = false, quiet = false, previous = false, taxonomy = false) => {
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
      libraryAbort.current?.abort();
      const controller = new AbortController();
      libraryAbort.current = controller;
      try {
        const p = new URLSearchParams({
          limit: "60",
          recent: String(recent),
          sort,
          descending: String(descending),
        });
        let cursor: string | undefined;
        if (previous) cursor = pageCursors.current[Math.max(0, pageIndex.current - 1)];
        else if (more) cursor = library.next_cursor || undefined;
        else if (taxonomy) cursor = pageCursors.current[pageIndex.current];
        if (cursor) p.set("cursor", cursor);
        if (taxonomyCursor.current) p.set("taxonomy_after", taxonomyCursor.current);
        if (folder !== undefined) p.set("folder", folder);
        if (group) p.set("group", group);
        const action = "library?" + p;
        const targetPage = previous ? Math.max(0, pageIndex.current - 1)
          : more ? pageIndex.current + 1 : taxonomy ? pageIndex.current : 0;
        const targetCursors = more
          ? [...pageCursors.current.slice(0, pageIndex.current + 1), cursor]
          : !previous && !taxonomy ? [undefined] : pageCursors.current;
        const applyPage = (r: Library) => {
          pageIndex.current = targetPage;
          pageCursors.current = targetCursors;
          applyPresentationChange(r);
          setLibrary((old) => {
            const byId = new Map(old.documents.map((d) => [d.document_id, d]));
            const next = {
              ...r,
              documents: r.documents.map((d) => {
                  const existing = byId.get(d.document_id);
                  return existing && sameValue(existing, d) ? existing : d;
                }),
            };
            return sameValue(old, next) ? old : next;
          });
          setLoadedScope(requestScope);
          setError("");
        };
        const cached = !quiet && peekCachedLibrary(action);
        if (cached) { applyPage(cached); setLoading(false); }
        else if (!quiet) setLoading(true);
        const r = await api<Library>(action, undefined, controller.signal);
        if (generation !== libraryGeneration.current || controller.signal.aborted) return;
        applyPage(r);
        if (folder && !taxonomyCursor.current && !r.taxonomy_has_more && !(folder in folderCounts(r.folders))) {
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
        if (group && !taxonomyCursor.current && !r.taxonomy_has_more && !r.groups.includes(group)) setGroup(undefined);
      } catch (e) {
        if (generation === libraryGeneration.current && (e as Error).name !== "AbortError")
          setError((e as Error).message);
      } finally {
        if (generation === libraryGeneration.current) setLoading(false);
        if (activeLibrary.current?.generation === generation)
          activeLibrary.current = undefined;
      }
    },
    [folder, group, recent, sort, descending, library.next_cursor],
  );
  useEffect(() => {
    taxonomyCursor.current = "";
    void load();
    return () => libraryAbort.current?.abort();
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
              "library_id" | "index_revision" | "organization_revision" | "manual_revision" | "processing"
            >
          >("progress");
        if (canceled) return;
        if (
          next.index_revision !== library.index_revision ||
          next.organization_revision !== library.organization_revision ||
          next.manual_revision !== library.manual_revision ||
          next.library_id !== library.library_id
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
  }, [load, library.library_id, library.index_revision, library.organization_revision, library.manual_revision]);
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
    api<SearchResponse | Job<SearchResponse>>(
      evaluate ? "ask" : "search",
      evaluate ? { query: submitted, folder, group, limit: 3 } : { query: submitted, mode, folder, group, limit: 40 },
      c.signal,
    )
      .then(async (reply) => {
        const present = (r: SearchResponse) => {
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
        };
        if ("job_id" in reply) await waitForJob(reply, c.signal, present);
        else present(reply);
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
    setLinksError("");
    setLinksLoading(false);
    // Neighborhoods feed the map; Files and the reader have their own bounded reads.
    if (!focusDoc || view !== "map") return;
    setLinksLoading(true);
    api<{ documents: Doc[]; links: Link[] }>(
      `neighborhood?id=${encodeURIComponent(focusDoc.document_id)}&version=${encodeURIComponent(focusDoc.version)}`,
      undefined,
      c.signal,
    )
      .then((r) => {
        if (!c.signal.aborted) {
          setLinks(r.links);
          setNeighbors(r.documents);
        }
      })
      .catch((e) => {
        if (!c.signal.aborted) setLinksError(e.message);
      })
      .finally(() => {
        if (!c.signal.aborted) setLinksLoading(false);
      });
    return () => c.abort();
  }, [
    linksRetry,
    view,
    focusDoc?.document_id,
    focusDoc?.version,
    rebuild?.completed,
    library.organization_revision,
    library.index_revision,
    libraryVersions,
  ]);
  const select = useCallback(
    (d: Doc, e?: SelectionEvent) => {
      setAgentOpened("");
      setAgentMatch(undefined);
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
    (d: Doc, origin?: HTMLElement) => {
      if (!readerExpanded)
        readerOrigin.current =
          origin || (document.activeElement as HTMLElement);
      select(d);
      setInspectorVisible(true);
      setReaderExpanded(true);
    },
    [select, readerExpanded],
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
  const { command: agentCommand, context: assistantContext, agentOpened, agentMatch,
    setAgentOpened, setAgentMatch } = useAppUI({
    view: { selected, selectedIds, folder, group, recent, inspectorVisible, readerExpanded,
      inspectorTab, query, submitted, mode, evaluate, view, layout, sort, descending, searchOrder },
    documents: visibleDocs,
    folders: Object.keys(folderCounts(library.folders)), groups: library.groups,
    ready: showSearch ? hasSearchResults && !searching : loadedScope === wantedScope && !loading,
    error: showSearch ? searchError : error,
    hasEvidence: !!(hasSearchResults && matches.find(d => d.document_id === selected?.document_id)?.evidence?.length),
    update: (next, action) => {
      if (next.inspectorVisible && (next.folder !== folder || next.group !== group || next.recent !== recent))
        restoringReader.current = true;
      setSelected(next.selected); setSelectedIds(next.selectedIds);
      setFolder(next.folder); setGroup(next.group); setRecent(next.recent);
      setInspectorVisible(next.inspectorVisible); setReaderExpanded(next.readerExpanded);
      setInspectorTab(next.inspectorTab); setChosenLink(undefined);
      if (next.submitted !== submitted) restoringSearchOrder.current = true;
      setQuery(next.query); setSubmitted(next.submitted); setMode(next.mode); setEvaluate(next.evaluate);
      if (action !== "highlight_evidence") setEvidenceNavigation(undefined);
      setView(next.view); setLayout(next.layout); setSort(next.sort); setDescending(next.descending);
      setSearchOrder(next.searchOrder);
      if (action === "show_search") setSearchNonce(n => n + 1);
    },
    highlight: (doc, evidence) => setEvidenceNavigation(old => ({
      sequence: (old?.sequence || 0) + 1, document_id: doc.document_id, version: doc.version,
      evidence_id: evidence, agent: true,
    })),
  });
  const quickLookDoc = useCallback(
    (d: Doc) => {
      previewOrigin.current = document.activeElement as HTMLElement;
      select(d);
      setInspectorVisible(true);
      setOpen(true);
    },
    [select],
  );
  function closeInspector() {
    setAgentOpened("");
    setAgentMatch(undefined);
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
        (readerOrigin.current?.isConnected
          ? readerOrigin.current
          : undefined) ||
        (lastFocus.current?.isConnected ? lastFocus.current : undefined) ||
        control ||
        main.current?.querySelector<HTMLButtonElement>(".workspace-map-toggle")
      )?.focus();
      readerOrigin.current = null;
    });
  }
  function clear() {
    setInspectorVisible(false);
    setReaderExpanded(false);
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
  const transfers = useTransfers({
    limits: library,
    onStored: async (doc, updating) => {
      await load(false, true);
      if (updating) {
        select(doc);
        // An explicit successful update opens the newly stored version.
        setSelected(doc);
      }
    },
    onOpen: (doc) => { openDoc(doc); setSelected(doc); },
  });
  const { addFiles } = transfers;
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
      const submitted = await r.json();
      const { url } = submitted.job_id ? await waitForJob<{url: string}>(submitted) : submitted;
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
        : states.failed || states.disabled
          ? "Some files need attention"
          : "Your library";
  const scopedFolders = library.scoped_folders ?? library.folders;
  const childFolders = immediateFolders(scopedFolders, folder);
  const mapDocs = [
    ...visibleDocs,
    ...neighbors.filter(
      (d) => !visibleDocs.some((item) => item.document_id === d.document_id),
    ),
  ].slice(0, 100);
  const reviewStatus =
    rebuild && !progressHidden ? (
      <JevProgress
        key={rebuild.request_id}
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
    ) : null;
  const canvas = !freeformMap ? (
    <ConnectionMap
      key={JSON.stringify([folder, group, submitted])}
      docs={[
        ...visibleDocs,
        ...neighbors.filter(
          (d) => !visibleDocs.some((v) => v.document_id === d.document_id),
        ),
      ]}
      links={links}
      selected={selected?.document_id}
      selectedLink={chosenLink}
      folders={showSearch ? {} : scopedFolders}
      scope={folder}
      total={showSearch ? matches.length : library.total}
      loaded={visibleDocs.length}
      hasMore={!showSearch && library.has_more}
      loading={loading}
      linksLoading={linksLoading}
      linksError={linksError}
      onRetryLinks={() => setLinksRetry((n) => n + 1)}
      onLoadMore={() => void load(true)}
      onSelect={(d) => {
        select(d);
        setInspectorVisible(false);
        setReaderExpanded(false);
      }}
      onOpen={openDoc}
      onLink={setChosenLink}
      onClear={() => {
        setSelected(undefined);
        setSelectedIds([]);
        setChosenLink(undefined);
      }}
      onFolder={(path) => {
        setFolder(path);
        setView("files");
        setLayout("list");
      }}
      onFreeform={() => setFreeformMap(true)}
      search={showSearch}
    />
  ) : (
    <div className="document-map-surface">
      <button
        className="back-to-overview"
        onClick={() => setFreeformMap(false)}
      >
        ← Readable map
      </button>
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
    </div>
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
      descending={showSearch ? searchDescending : recent || descending}
      onSort={(s) => {
        if (showSearch) {
          setSearchOrder((old) => ({
            field: s,
            descending: old.field === s ? !old.descending : false,
          }));
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
        "app connected-app " +
        (showSearch ? "searching " : "") +
        (inspectorVisible && selected ? "reader-open " : "") +
        (readerExpanded ? "reader-expanded " : "") +
        (view === "map" ? "map-view" : "")
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
      <a
        className="skip-content"
        tabIndex={0}
        href="#main-content"
        onClick={(e) => {
          e.preventDefault();
          if (readerExpanded)
            document.querySelector<HTMLElement>(".inspector")?.focus();
          else main.current?.focus();
        }}
      >
        Skip to content
      </a>
      <Sidebar
        key={library.library_id + ":" + layoutRevision}
        folders={library.folders}
        onNextTaxonomy={library.taxonomy_has_more ? () => { taxonomyCursor.current = library.taxonomy_next_after || ""; void load(false, false, false, true); } : undefined}
        onFirstTaxonomy={taxonomyCursor.current ? () => { taxonomyCursor.current = ""; void load(false, false, false, true); } : undefined}
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
          setView("files");
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
          onSubmit={(searchQuery) => {
            if (searchQuery.trim()) {
              setSubmitted(searchQuery.trim());
              setSearchNonce((n) => n + 1);
            } else clear();
          }}
          onClear={clear}
          mode={mode}
          onMode={(value) => { setMode(value); setSubmitted(""); }}
          evaluate={evaluate}
          onEvaluate={(value) => { setEvaluate(value); setSubmitted(""); if (value) setMode("semantic"); }}
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
              <div className="header-assistants" role="group" aria-label="Library assistants">
                <JevDecisions onResolved={() => { void load(false, true); setSearchNonce(n => n + 1); }} />
                <button ref={setAssistantLauncher} className="assistant-launch" type="button"
                  aria-label="Ask an agent" title="Ask an agent" aria-expanded={assistantVisible}
                  aria-controls="assistant-panel" onClick={() => setAssistantVisible(value => !value)}>
                  <MessageCircle size={17} aria-hidden="true" /><span>Ask an agent</span>
                </button>
              </div>
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
                    <Menu.Label className="menu-label">Browse</Menu.Label>
                    <Menu.Item onSelect={() => setInventoryOpen(true)}>
                      <Archive size={14} aria-hidden="true" /> Browse all originals
                    </Menu.Item>
                    <Menu.Item onSelect={() => setReviewHistoryOpen(true)}>
                      <History size={14} aria-hidden="true" /> Review history
                    </Menu.Item>
                    <Menu.Item onSelect={() => void load()}>
                      <RefreshCw size={14} aria-hidden="true" /> Refresh library
                    </Menu.Item>
                    {rebuild && (
                      <Menu.Item onSelect={() => setProgressHidden(false)}>
                        <Sparkles size={14} aria-hidden="true" /> Show review status
                      </Menu.Item>
                    )}
                    <Menu.Separator className="menu-separator" />
                    <Menu.Label className="menu-label">Organize with Jev</Menu.Label>
                    <Menu.Item
                      disabled={busy || !library.unfiled_review_count}
                      onSelect={() => setReviewMode("unfiled")}
                    >
                      <OrganizeIcon size={16} /> Organize unfiled files…
                    </Menu.Item>
                    <Menu.Item
                      disabled={busy || !library.library_total}
                      onSelect={() => setReviewMode("links")}
                    >
                      <ReviewIcon size={16} /> Review connections…
                    </Menu.Item>
                    <Menu.Separator className="menu-separator" />
                    <Menu.Item
                      className="menu-danger"
                      disabled={busy}
                      onSelect={() => setResetOpen(true)}
                    >
                      <RotateCcw size={14} aria-hidden="true" /> Reset organization…
                    </Menu.Item>
                  </Menu.Content>
                </Menu.Portal>
              </Menu.Root>
            </>
          }
        />
        <ImportFormats maxFileBytes={library.max_file_bytes} />
        <TransferPanel {...transfers} />
        {busy && reviewStatus}
        <div
          className={
            "content " + (selected && inspectorVisible ? "has-inspector" : "")
          }
        >
          <main
            id="main-content"
            tabIndex={-1}
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
                    : view === "map"
                      ? "Connections"
                      : recent
                        ? "Recent"
                        : folder === ""
                          ? "Unfiled"
                          : folder?.split(" / ").at(-1) || "Your knowledge"}
                </h1>
                <p className="secondary" role="status" aria-live="polite">
                  {showSearch
                    ? searching || (!hasSearchResults && !searchError)
                      ? hasSearchResults
                        ? `${matches.length} loaded matches in ${scopeLabel} · Refreshing…`
                        : `Searching in ${scopeLabel}…`
                      : hasSearchResults ? `Showing ${matches.length} loaded matches in ${scopeLabel} · ${evaluate ? `${answer.evaluated_count ?? checked} checked · ${matches.filter((d) => d.jev?.status === "evaluated" && d.evidence?.some((e) => !!e.text && d.jev?.supporting_chunk_ids?.includes(e.evidence_id))).length} supporting · ${matches.filter((d) => d.jev?.status === "evaluated" && d.jev?.possible_conflicting_chunk_ids?.length).length} possible conflict · ${Math.max(0, (answer.candidate_count ?? matches.length) - (answer.evaluated_count ?? checked))} not checked` : "Answer checking off"}${searchSort !== "relevance" ? " · Sorted loaded matches" : ""}` : `Search unavailable in ${scopeLabel}`
                    : `${library.total} files${folder ? ` · ${childFolders.length} subfolders` : ""}${recent ? " · Latest version activity" : ""}`}
                </p>
                {showSearch && <div className="search-inventory-context">
                  <p className="secondary">Current search request: <q>{submitted}</q></p>
                  {loadedScope === wantedScope && <p>
                    {library.total} files total in {scopeLabel}. Search returns a limited set of matching files.
                    {" "}<button className="link-button" onClick={clear}>Show all {library.total} files in this scope</button>
                  </p>}
                </div>}
              </div>
              <div className="heading-tools">
                {!busy && !readerExpanded && reviewStatus}
                <div className="library-actions">
                  {view !== "map" && <select aria-label="File layout" title="File layout" value={layout}
                    onChange={(event) => setLayout(event.target.value as "list" | "grid")}>
                    <option value="list">List</option>
                    <option value="grid">Cards</option>
                  </select>}
                  <select aria-label="Display density" title="Row density" value={density}
                    onChange={(event) => setDensity(event.target.value as "compact" | "comfortable")}>
                    <option value="compact">Compact</option>
                    <option value="comfortable">Comfortable</option>
                  </select>
                  {view !== "map" && <FreshnessReview onOpen={openDoc} onUpdate={update} />}
                  {folder === "" && !showSearch && (
                    <button
                      disabled={busy || !library.unfiled_review_count}
                      onClick={() => setReviewMode("unfiled")}
                      title="Review unfiled documents and add links without resetting"
                    >
                      <OrganizeIcon size={16} /> Organize files
                    </button>
                  )}
                  <button className="workspace-map-toggle" onClick={() => {
                    setView(view === "map" ? "files" : "map"); setFreeformMap(false);
                  }}>{view === "map" ? "← Back to workspace" : "Explore map"}</button>
                </div>
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
                <div className="search-method-note">
                  <strong>{evaluate ? "Ask · Semantic + checking" : mode === "grep" ? "Search · Grep" : "Search · Semantic"}</strong>
                  <span>
                    {evaluate
                      ? "Answer checks use the returned passages. Open Evidence to inspect the source and explanation."
                      : mode === "grep" ? "These files contain matching extracted lines. Open Evidence to inspect the source passages. Results are not checked answers." : "Results are retrieved by meaning. Open Evidence to inspect matching passages; relevance is not a factual verification."}
                  </span>
                </div>
                {!searching && !searchError && hasNoStrongMatch(rawMatches, mode, evaluate) && (
                  <p className="notice" role="status">
                    No strong match for this search. These are the closest files, but they may not be relevant. Try different words, or use Exact text.
                  </p>
                )}
                {searchError && (
                  <p className="notice error" role="alert">
                    {searchError}
                    <button onClick={() => setSearchNonce((n) => n + 1)}>
                      Retry search
                    </button>
                  </p>
                )}
                {!searching && evaluate && !unavailable &&
                  answer.status === "answered" &&
                  answer.values?.map((value) => (
                    <p className="notice" key={value.source.chunk_id}>
                      <strong>{value.display}</strong>
                      {value.calculation && <> · Source value: {value.source.quote}</>}
                      {" · Checked against the returned source passages."}
                      <button
                        onClick={() => {
                          const doc = matches.find(
                            (m) => m.document_id === value.source.document_id,
                          );
                          if (doc) evidenceDoc(doc);
                        }}
                      >
                        View source
                      </button>
                    </p>
                  ))}
                {unavailable && (
                  <p className="notice">
                    {matches.some((m) => m.jev?.status === "evaluated")
                      ? "Some answer checks are unavailable. Only previously accepted answers are shown."
                      : "Answer checking is unavailable. Retry, or switch to Search to browse related files."}
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
                          <h2>{emptySearch.title}</h2>
                          <p>{emptySearch.body}</p>
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
                {loadedScope !== wantedScope ||
                (loading && !library.documents.length) ? (
                  <div className="loading" role="status">
                    {error
                      ? "This folder could not be loaded. Use Retry above."
                      : "Loading your library…"}
                  </div>
                ) : library.documents.length ? (
                  view === "map" ? (
                    canvas
                  ) : (
                    <ConnectedWorkspace featured={focusDoc} selected={selected} folders={recent ? [] : childFolders}
                      files={files} group={group} onOpen={openDoc} onFolder={setFolder}
                      onMap={() => { if (focusDoc) setSelectedIds([focusDoc.document_id]); setView("map"); setFreeformMap(false); }} />
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
                {library.documents.length > 0 &&
                  (view !== "map" || freeformMap) && (
                    <div className="browse-footer">
                      <span>
                        Showing {library.documents.length} of {library.total}{" "}
                        files
                      </span>
                      {pageIndex.current > 0 && <button disabled={loading} onClick={() => void load(false, false, true)}>Previous page</button>}
                      {library.has_more && (
                        <button
                          disabled={
                            loading ||
                            (view === "map" && library.documents.length >= 100)
                          }
                          onClick={() => void load(true)}
                        >
                          Next page
                        </button>
                      )}
                      {view === "map" &&
                        library.has_more &&
                        library.documents.length >= 100 && (
                          <span>
                            Canvas is limited to 100 cards. Choose a folder or
                            use Files.
                          </span>
                        )}
                    </div>
                  )}
              </>
            )}
          </main>
          {selected && inspectorVisible && readerExpanded && (
            <ReaderNavigator
              doc={selected}
              docs={visibleDocs}
              search={showSearch}
              group={group}
              revision={JSON.stringify([
                library.organization_revision,
                library.index_revision,
                library.manual_revision,
              ])}
              onOpen={openDoc}
            />
          )}
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
              <Suspense
                fallback={inspectorVisible ? <div role="status" className="inspector">Loading reader…</div> : null}
              >
                <DocumentInspector
                  libraryId={library.library_id}
                  hidden={!inspectorVisible}
                  expanded={readerExpanded}
                  onExpand={() => setReaderExpanded((v) => !v)}
                  doc={selected}
                  visibleIds={visibleDocs.map((d) => d.document_id)}
                  initialTab={inspectorTab}
                  onTabChange={setInspectorTab}
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
                    agentMatch?.document_id === selected.document_id && agentMatch.version === selected.version ? agentMatch : hasSearchResults
                      ? matches.find(
                          (m) => m.document_id === selected.document_id,
                        )
                      : undefined
                  }
                  evaluate={evaluate}
                  unavailable={unavailable}
                  onClose={closeInspector}
                  onSelect={openDoc}
                  onUpdate={update}
                  onDelete={(doc) => setDeleteTarget({ kind: "document", doc })}
                  open={open}
                  onOpen={(value) => {
                    if (value) previewOrigin.current = document.activeElement as HTMLElement;
                    setOpen(value);
                  }}
                  onPreviewClose={() => {
                    const opener = previewOrigin.current;
                    if (opener?.isConnected && opener.getClientRects().length) opener.focus();
                    else {
                      const fallback = document.querySelector<HTMLButtonElement>(".inspector .open-file");
                      if (fallback?.getClientRects().length) fallback.focus();
                      else input.current?.focus();
                    }
                  }}
                  link={chosenLink}
                  onLink={setChosenLink}
                />
              </Suspense>
            </>
          )}
        </div>
      </div>
      <input
        className="sr-only"
        type="file"
        ref={fileInput}
        tabIndex={-1}
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
        tabIndex={-1}
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
            transfers.forgetDocument(target.doc.document_id);
          } else await api("delete-folder", { folder: target.folder });
          setSearchNonce((n) => n + 1);
          await load(false, true);
        }}
      />
      <ReviewHistory job={rebuild} libraryId={library.library_id} open={reviewHistoryOpen} onOpenChange={setReviewHistoryOpen} onShowCurrent={() => setProgressHidden(false)} />
      <OriginalInventory open={inventoryOpen} onOpenChange={setInventoryOpen} onOpen={openDoc} />
      <Suspense fallback={assistantVisible ? <div className="assistant-loading" role="status">Loading chat…<button type="button" aria-label="Close agent chat" onClick={() => { setAssistantVisible(false); assistantLauncher?.focus(); }}><X size={18} /></button></div> : null}><Assistant launcher={assistantLauncher} visible={assistantVisible} setVisible={setAssistantVisible} context={assistantContext} command={agentCommand} changed={() => { void load(false, true); setSearchNonce(n => n + 1); }} /></Suspense>
      {agentOpened && <div className="assistant-opened">{agentOpened}<button type="button" onClick={() => history.back()}>Back</button></div>}
      {dragging && (
        <div className="drop-overlay">
          <Upload size={36} />
          <h2>Drop files to import</h2>
        </div>
      )}
    </div>
  );
}
