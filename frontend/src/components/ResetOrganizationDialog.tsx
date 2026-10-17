import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ShieldCheck } from "lucide-react";
import { Logo } from "./Sidebar";
import { folderCounts } from "../api";
export default function ResetOrganizationDialog(p: {
  open: boolean;
  setOpen: (v: boolean) => void;
  folders: Record<string, number>;
  folder?: string;
  onReset: (args: {
    folder?: string;
    grouping: boolean;
    links: boolean;
  }) => Promise<void>;
}) {
  const [scope, setScope] = useState("*"),
    [grouping, setGrouping] = useState(true),
    [links, setLinks] = useState(true),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (p.open) {
      setScope("*");
      setGrouping(true);
      setLinks(true);
      setError("");
    }
  }, [p.open, p.folder]);
  const total = Object.values(p.folders).reduce((a, b) => a + b, 0),
    count = scope === "*" ? total : folderCounts(p.folders)[scope] || 0;
  return (
    <Dialog.Root
      open={p.open}
      onOpenChange={(v) => {
        if (!busy) p.setOpen(v);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content
          className="reset-dialog"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            cancel.current?.focus();
          }}
        >
          <Logo />
          <Dialog.Title>Reset organization</Dialog.Title>
          <Dialog.Description>
            {grouping && links
              ? `Clear and rebuild folders, subfolders, groups, manual placements and links for ${count} ${count === 1 ? "file" : "files"} ${scope === "*" ? "in the entire library" : `in ${scope || "Unfiled"} and its subfolders`}.`
              : grouping
                ? `Clear and rebuild folders, subfolders, groups and manual placements for ${count} ${count === 1 ? "file" : "files"} ${scope === "*" ? "in the entire library" : `in ${scope || "Unfiled"} and its subfolders`}. Document links remain.`
                : links
                  ? `Rebuild links for ${count} ${count === 1 ? "file" : "files"} ${scope === "*" ? "in the entire library" : `in ${scope || "Unfiled"} and its subfolders`}. Folders, groups and manual placements remain.`
                  : "Choose at least one type of organization to rebuild."}
            {links &&
              " Existing incoming links into this scope are also cleared."}{" "}
            Files and version history stay intact.
          </Dialog.Description>
          <label className="scope-row">
            Scope
            <select
              aria-label="Reset scope"
              value={scope}
              onChange={(e) => setScope(e.target.value)}
            >
              <option value="*">Entire library · {total} files</option>
              {Object.entries(folderCounts(p.folders)).map(([f, n]) => (
                <option key={f} value={f}>
                  {f || "Unfiled"} · {n} files
                </option>
              ))}
            </select>
          </label>
          <div className="reset-options">
            <label>
              <input
                type="checkbox"
                checked={grouping}
                onChange={(e) => setGrouping(e.target.checked)}
              />
              Folders &amp; groups
            </label>
            <label>
              <input
                type="checkbox"
                checked={links}
                onChange={(e) => setLinks(e.target.checked)}
              />
              Document links
            </label>
            <p>Replaces only the selected organization data.</p>
          </div>
          <div className="reset-assurance">
            <ShieldCheck size={22} />
            <div>
              Your files and version history stay intact.
              <p>
                Checks Jev availability before clearing. Failed or skipped items
                stay Unfiled when folders are reset. Retry failed items after
                processing finishes.
              </p>
            </div>
          </div>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <Dialog.Close asChild>
              <button ref={cancel} disabled={busy}>
                Cancel
              </button>
            </Dialog.Close>
            <button
              className="primary"
              disabled={busy || !count || (!grouping && !links)}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  await p.onReset({
                    folder: scope === "*" ? undefined : scope,
                    grouping,
                    links,
                  });
                  p.setOpen(false);
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Starting…" : "Reset & rebuild"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
