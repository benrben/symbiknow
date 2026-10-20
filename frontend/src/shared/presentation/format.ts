import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type SetStateAction,
} from "react";
export function readSaved<T>(key: string, fallback: T): T {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "null");
    return value ?? fallback;
  } catch {
    return fallback;
  }
}
export function save(key: string, value: unknown) {
  try {
    if (key.includes("|search:") && !localStorage.getItem(key)) {
      const prefix = key.slice(0, key.indexOf("canvas:")) + "canvas:";
      const searches = Array.from(
        { length: localStorage.length },
        (_, i) => localStorage.key(i) || "",
      ).filter((name) => name.startsWith(prefix) && name.includes("|search:"));
      searches
        .slice(0, Math.max(0, searches.length - 19))
        .forEach((name) => localStorage.removeItem(name));
    }
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Preferences are optional. */
  }
}
export const preferenceKey = (library: string, key: string) =>
  `symbiknow.v2.${library}.${key}`;
export function usePreference<T>(
  library: string | undefined,
  key: string,
  fallback: T,
  valid: (v: T) => boolean,
) {
  const [value, setValue] = useState(fallback);
  const [loaded, setLoaded] = useState("");
  const edited = useRef(false),
    previousLibrary = useRef("");
  const change = useCallback((next: SetStateAction<T>) => {
    edited.current = true;
    setValue(next);
  }, []);
  useEffect(() => {
    if (!library) return;
    if (previousLibrary.current && previousLibrary.current !== library)
      edited.current = false;
    previousLibrary.current = library;
    const stored = readSaved(preferenceKey(library, key), fallback);
    if (!edited.current) setValue(valid(stored) ? stored : fallback);
    setLoaded(library);
  }, [library, key]);
  useEffect(() => {
    if (library && loaded === library) save(preferenceKey(library, key), value);
  }, [library, loaded, key, value]);
  return [value, change] as const;
}
export function immediateFolders(
  leaves: Record<string, number>,
  scope?: string,
) {
  const counts: Record<string, number> = {};
  for (const [path, n] of Object.entries(leaves)) {
    if (
      !path ||
      (scope !== undefined && (!scope || !path.startsWith(scope + " / ")))
    )
      continue;
    const remainder = scope ? path.slice(scope.length + 3) : path;
    const child = (scope ? scope + " / " : "") + remainder.split(" / ")[0];
    counts[child] = (counts[child] || 0) + n;
  }
  return Object.entries(counts).sort(([a], [b]) => a.localeCompare(b));
}

// Reconcile bounded presentation state from server-published reset/edit revisions.
// Partial resets remove only affected identities, including within an ancestor canvas.
export function reconcilePresentation(library: import("../api/client").Library) {
  const id = library.library_id;
  if (!id) return false;
  const revision = library.organization_revision || "";
  if (readSaved(preferenceKey(id, "organizationRevision"), "") === revision)
    return false;
  const reset = library.organization_reset;
  const resetChanged =
    !!reset?.revision &&
    readSaved(preferenceKey(id, "resetRevision"), "") !== reset.revision;
  const manualChanged =
    !!library.manual_revision &&
    readSaved(preferenceKey(id, "manualRevision"), "") !==
      library.manual_revision;
  const names: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const name = localStorage.key(i);
    if (name?.startsWith(preferenceKey(id, "canvas:"))) names.push(name);
  }
  const inside = (path: string, root: string) =>
    path === root || (!!root && path.startsWith(root + " / "));
  for (const name of names) {
    const suffix = name.slice(preferenceKey(id, "canvas:").length);
    const scope = suffix.split("|search:")[0];
    const searchSuffix = suffix.slice(scope.length);
    const raw = readSaved<Record<string, unknown>>(name, {});
    const state =
      raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const positions =
      state.positions && typeof state.positions === "object"
        ? (state.positions as Record<string, unknown>)
        : {};
    const overviewPositions =
      state.overviewPositions && typeof state.overviewPositions === "object"
        ? (state.overviewPositions as Record<string, unknown>)
        : {};
    const folderById =
      state.folderById && typeof state.folderById === "object"
        ? (state.folderById as Record<string, string>)
        : {};
    if (resetChanged && reset) {
      if (reset.scope === null || inside(scope, reset.scope)) {
        localStorage.removeItem(name);
        continue;
      }
      const removed = new Set<string>();
      for (const map of [positions, overviewPositions])
        for (const key of Object.keys(map))
          if (
            key.startsWith("folder:")
              ? inside(key.slice(7), reset.scope)
              : typeof folderById[key] === "string" &&
                inside(folderById[key], reset.scope)
          ) {
            delete map[key];
            removed.add(key);
          }
      for (const key of removed) {
        delete folderById[key];
        for (const field of ["positionOrigins", "overviewPositionOrigins"])
          if (state[field] && typeof state[field] === "object")
            delete (state[field] as Record<string, unknown>)[key];
      }
      if (Array.isArray(state.collapsed))
        state.collapsed = state.collapsed.filter(
          (f) => typeof f === "string" && !inside(f, reset.scope!),
        );
    }
    if (resetChanged || manualChanged) delete state.previous;
    const change = library.organization_change;
    if (manualChanged && change?.kind === "rename" && change.paths) {
      const { from, to } = change.paths;
      const migrate = (path: string) =>
        inside(path, from) ? to + path.slice(from.length) : path;
      const updated: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(positions))
        updated[
          key.startsWith("folder:") ? "folder:" + migrate(key.slice(7)) : key
        ] = value;
      for (const key of Object.keys(folderById))
        if (typeof folderById[key] === "string")
          folderById[key] = migrate(folderById[key]);
      const collapsed = Array.isArray(state.collapsed)
        ? state.collapsed.filter((f) => typeof f === "string").map(migrate)
        : [];
      if (state.overviewPositions)
        state.overviewPositions = Object.fromEntries(
          Object.entries(overviewPositions).map(([key, value]) => [
            key.startsWith("folder:") ? "folder:" + migrate(key.slice(7)) : key,
            value,
          ]),
        );
      for (const field of ["positionOrigins", "overviewPositionOrigins"])
        if (state[field] && typeof state[field] === "object")
          state[field] = Object.fromEntries(
            Object.entries(state[field]).map(([key, value]) => [
              key.startsWith("folder:")
                ? "folder:" + migrate(key.slice(7))
                : key,
              value,
            ]),
          );
      const nextName = preferenceKey(
        id,
        "canvas:" + migrate(scope) + searchSuffix,
      );
      save(nextName, { ...state, positions: updated, folderById, collapsed });
      if (nextName !== name) localStorage.removeItem(name);
    } else {
      if (manualChanged && change?.kind === "move")
        for (const identity of change.document_ids) {
          delete positions[identity];
          delete overviewPositions[identity];
          delete folderById[identity];
          for (const field of ["positionOrigins", "overviewPositionOrigins"])
            if (state[field] && typeof state[field] === "object")
              delete (state[field] as Record<string, unknown>)[identity];
        }
      save(name, { ...state, positions, folderById });
    }
  }
  if (manualChanged && library.organization_change?.paths) {
    const { from, to } = library.organization_change.paths;
    const expanded = readSaved<string[]>(preferenceKey(id, "expanded"), []);
    if (Array.isArray(expanded))
      save(
        preferenceKey(id, "expanded"),
        expanded
          .filter((f) => typeof f === "string")
          .map((f) => (inside(f, from) ? to + f.slice(from.length) : f)),
      );
  }
  // Reset revisions describe folder organization only (links-only preserves them).
  // Prune tree state alongside canvas state, including ancestors with no files.
  const expandedKey = preferenceKey(id, "expanded");
  const expanded = readSaved<string[]>(expandedKey, []);
  if (Array.isArray(expanded)) {
    const paths = Object.keys(library.folders);
    save(
      expandedKey,
      expanded.filter(
        (path) =>
          typeof path === "string" &&
          !(
            resetChanged &&
            reset &&
            (reset.scope === null || inside(path, reset.scope))
          ) &&
          paths.some((leaf) => inside(leaf, path)),
      ),
    );
  }
  save(preferenceKey(id, "organizationRevision"), revision);
  if (reset?.revision) save(preferenceKey(id, "resetRevision"), reset.revision);
  if (library.manual_revision)
    save(preferenceKey(id, "manualRevision"), library.manual_revision);
  return true;
}
