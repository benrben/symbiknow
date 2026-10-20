import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { api, folderCounts, type Doc } from "../../../shared/api/client";
export type OrganizationTarget =
  | { action: "rename-folder" | "move-folder"; folder: string }
  | { action: "move-documents"; docs: Doc[] };
export default function OrganizationDialog(p: {
  target?: OrganizationTarget;
  folders: Record<string, number>;
  onClose: () => void;
  onDone: (result: {
    paths?: { from: string; to: string };
    folder: string;
  }) => Promise<void>;
}) {
  const [value, setValue] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setError("");
    setValue(
      p.target?.action === "rename-folder"
        ? p.target.folder.split(" / ").at(-1)!
        : "",
    );
  }, [p.target]);
  const rename = p.target?.action === "rename-folder";
  return (
    <Dialog.Root
      open={!!p.target}
      onOpenChange={(open) => {
        if (!open && !busy) p.onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content
          className="reset-dialog"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            input.current?.focus();
          }}
        >
          <Dialog.Title>
            {rename ? "Rename folder" : "Move to folder"}
          </Dialog.Title>
          <Dialog.Description>
            Logical folders only. Original files and version history stay
            intact.
          </Dialog.Description>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (!p.target) return;
              setBusy(true);
              setError("");
              try {
                const t = p.target;
                const body =
                  t.action === "move-documents"
                    ? {
                        folder: value,
                        documents: t.docs.map((d) => ({
                          document_id: d.document_id,
                          expected_version: d.version,
                        })),
                      }
                    : t.action === "rename-folder"
                      ? { folder: t.folder, name: value }
                      : { folder: t.folder, destination: value };
                await p.onDone(await api(t.action, body));
                p.onClose();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <label className="destination-label">
              {rename ? "Name" : "Existing folder or new path"}
              <input
                ref={input}
                aria-label={rename ? "Folder name" : "Destination folder"}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                list={rename ? undefined : "folder-destinations"}
                placeholder={
                  p.target?.action === "move-documents"
                    ? "Empty for Unfiled"
                    : "Empty for library root"
                }
              />
            </label>
            <datalist id="folder-destinations">
              {Object.keys(folderCounts(p.folders))
                .filter(Boolean)
                .map((f) => (
                  <option key={f} value={f} />
                ))}
            </datalist>
            {!rename && (
              <p className="secondary">Separate folder levels with /.</p>
            )}
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            <div className="dialog-actions">
              <button type="button" disabled={busy} onClick={p.onClose}>
                Cancel
              </button>
              <button
                className="primary"
                disabled={busy || (rename && !value.trim())}
              >
                {busy ? "Saving…" : rename ? "Rename" : "Move"}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
