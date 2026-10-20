import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ReviewIcon, OrganizeIcon } from "../../../shared/components/KnowledgeIcons";
import { folderCounts } from "../../../shared/api/client";

export type ReviewMode = "unfiled" | "links";

export default function JevReviewDialog(p: {
  mode: ReviewMode;
  folder?: string;
  folders: Record<string, number>;
  unfiledCount: number;
  onClose: () => void;
  onStart: (args: { mode: ReviewMode; folder?: string }) => Promise<void>;
}) {
  const [scope, setScope] = useState(p.folder ?? "*"),
    [starting, setStarting] = useState(false),
    [error, setError] = useState("");
  const unfiled = p.mode === "unfiled";
  const total = Object.values(p.folders).reduce((a, b) => a + b, 0);
  const count = unfiled
    ? p.unfiledCount
    : scope === "*"
      ? total
      : folderCounts(p.folders)[scope] || 0;
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !starting) p.onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className="reset-dialog jev-review-dialog">
          {unfiled ? <OrganizeIcon size={24} /> : <ReviewIcon size={24} />}
          <Dialog.Title>
            {unfiled ? "Group unfiled files" : "Review links only"}
          </Dialog.Title>
          <Dialog.Description>
            {unfiled
              ? "Jev reviews unfiled documents, reuses existing project folders where supported, and adds evidence-backed links. Manual placements and already-filed documents stay in place."
              : "Jev checks relationships and adds evidence-backed links. Folders, groups and manual placements stay in place. Existing valid links are kept."}
          </Dialog.Description>
          {!unfiled && (
            <label className="scope-row">
              Review scope
              <select
                aria-label="Jev review scope"
                value={scope}
                onChange={(e) => setScope(e.target.value)}
                disabled={starting}
              >
                <option value="*">Entire library · {total} files</option>
                {Object.entries(folderCounts(p.folders)).map(([f, n]) => (
                  <option key={f} value={f}>
                    {f || "Unfiled"} · {n} files
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="jev-review-explanation">
            <strong>
              {count} {count === 1 ? "file" : "files"} to review
            </strong>
            <p>
              {unfiled
                ? "Uncertain files remain Unfiled. "
                : "Related documents may be found outside the selected folder. "}
              Files without searchable text are skipped. Your original files,
              versions and canvas layout are kept.
            </p>
          </div>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <Dialog.Close asChild>
              <button disabled={starting}>Cancel</button>
            </Dialog.Close>
            <button
              className="primary"
              disabled={starting || !count}
              onClick={async () => {
                setStarting(true);
                setError("");
                try {
                  await p.onStart({
                    mode: p.mode,
                    folder: unfiled ? "" : scope === "*" ? undefined : scope,
                  });
                  p.onClose();
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setStarting(false);
                }
              }}
            >
              {starting
                ? "Starting Jev…"
                : unfiled
                  ? "Group & link files"
                  : "Review links"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
