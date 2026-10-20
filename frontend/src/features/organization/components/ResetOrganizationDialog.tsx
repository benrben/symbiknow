import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ShieldCheck } from "lucide-react";
import { Logo } from "../../library/components/Sidebar";
import { folderCounts } from "../../../shared/api/client";
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
              ? `Move ${count} ${count === 1 ? "file" : "files"} ${scope === "*" ? "in the entire library" : `in ${scope || "Unfiled"} and its subfolders`} to New. Clear their folders, subfolders, groups, manual placements and links, then rebuild them from scratch.`
              : grouping
                ? `Move ${count} ${count === 1 ? "file" : "files"} ${scope === "*" ? "in the entire library" : `in ${scope || "Unfiled"} and its subfolders`} to New. Clear their folders, subfolders, groups and manual placements, then rebuild them from scratch. Document links remain.`
                : links
                  ? `Clear and rebuild links for ${count} ${count === 1 ? "file" : "files"} ${scope === "*" ? "in the entire library" : `in ${scope || "Unfiled"} and its subfolders`}. Folders, groups and manual placements remain.`
                  : "Choose at least one type of organization to rebuild."}
            {links &&
              " Existing incoming links into this scope are also cleared at the start."}{" "}
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
                {grouping
                  ? "After Jev is available, selected files move to New before scanning starts. Folders and groups appear as each file is reviewed."
                  : "After Jev is available, selected links are cleared. Rebuilt links appear as each file is reviewed."}
                {" "}Files without an accepted project become Unfiled when folders
                are reset. Retry failed items after processing finishes.
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
