import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import type { Doc } from "../api";

export type DeleteTarget =
  | { kind: "document"; doc: Doc }
  | { kind: "folder"; folder: string; count: number };
export default function DeleteDialog({
  target,
  onClose,
  onDelete,
}: {
  target?: DeleteTarget;
  onClose: () => void;
  onDelete: (target: DeleteTarget) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => setError(""), [target]);
  const name =
    target?.kind === "document" ? target.doc.filename : target?.folder;
  return (
    <Dialog.Root
      open={!!target}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
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
          <Dialog.Title>
            {target?.kind === "document"
              ? "Delete document?"
              : "Remove folder?"}
          </Dialog.Title>
          <Dialog.Description>
            {target?.kind === "document"
              ? `Permanently delete “${name}” and all its versions, search entries and document links. This cannot be undone.`
              : `Remove “${name}” and its subfolders. Move ${target?.count || 0} documents to Unfiled. Original files, version history and document links stay available.`}
          </Dialog.Description>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <button ref={cancel} disabled={busy} onClick={onClose}>
              Cancel
            </button>
            <button
              className="danger-button"
              disabled={busy}
              onClick={async () => {
                if (!target) return;
                setBusy(true);
                setError("");
                try {
                  await onDelete(target);
                  onClose();
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy
                ? "Deleting…"
                : target?.kind === "document"
                  ? "Delete document"
                  : "Remove folder"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
