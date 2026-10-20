import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { FileSearch, X } from "lucide-react";
import { api, type Doc, type Library } from "../../../shared/api/client";
import type { FreshnessEvidence, FreshnessFinding, FreshnessPage, FreshnessScan } from "../../../shared/api/contracts.generated.ts";

const active = (s?: string) => ["queued", "reading", "matching", "comparing"].includes(s || "");
const labels: Record<string, string> = {
  possibly_outdated: "Possibly outdated", possibly_replaced: "Possibly replaced",
  possibly_deprecated: "Possibly deprecated", conflicting: "Conflicting",
};
const gaps: Record<string, string> = {
  unreadable_or_changed_documents: "Files unreadable or changed",
  passages_without_text: "Passages without readable text",
  bounded_candidate_windows: "Comparison searches with limited coverage",
  context_limit_pairs: "Pairs needing more context than could be checked",
  changed_evidence_pairs: "Comparisons affected by changed evidence",
  uncertain_comparisons: "Comparisons without enough certainty for a label",
};
const document = (e: FreshnessEvidence): Doc => ({
  document_id: e.document_id, version: e.version, filename: e.filename, mime_type: "text/plain",
});
const noteKey = (f: FreshnessFinding) => `${f.scan_id}:${f.finding_id}`;

export default function FreshnessReview(p: {
  doc?: Doc;
  onOpen: (doc: Doc) => void;
  onUpdate: (doc: Doc) => void;
}) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<FreshnessPage>();
  const [scanId, setScanId] = useState("");
  const [after, setAfter] = useState("");
  const [category, setCategory] = useState("");
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [note, setNote] = useState<Record<string, string>>({});
  const [reference, setReference] = useState("");
  const [referenceName, setReferenceName] = useState("");
  const [referenceOpen, setReferenceOpen] = useState(false);
  const [referenceOffset, setReferenceOffset] = useState(0);
  const [referencePage, setReferencePage] = useState<Library>();
  const scan = page?.scan;
  useEffect(() => {
    if (!open || !referenceOpen) return;
    const controller = new AbortController();
    void api<Library>(`library?limit=100&offset=${referenceOffset}`, undefined, controller.signal)
      .then(setReferencePage)
      .catch(e => { if (e.name !== "AbortError") setError(e.message); });
    return () => controller.abort();
  }, [open, referenceOpen, referenceOffset]);
  useEffect(() => {
    // A closed document-specific control does no polling.
    if (p.doc && !open) return;
    let alive = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      const params = new URLSearchParams({ limit: open ? "20" : "1" });
      if (scanId) params.set("scan_id", scanId);
      if (after && open) params.set("after", after);
      if (category && open) params.set("category", category);
      if (p.doc) params.set("document_id", p.doc.document_id);
      try {
        const result = await api<FreshnessPage>("freshness?" + params, undefined, controller.signal);
        if (alive) { setPage(result); setError(""); }
      } catch (e) {
        if (alive && (e as Error).name !== "AbortError") setError((e as Error).message);
      } finally {
        if (alive) timer = setTimeout(() => void load(), 4000);
      }
    };
    void load();
    return () => { alive = false; controller.abort(); clearTimeout(timer); };
  }, [open, scanId, after, category, refresh, p.doc?.document_id]);

  async function action(work: () => Promise<unknown>) {
    setWorking(true); setError("");
    try { await work(); setRefresh(v => v + 1); }
    catch (e) { setError((e as Error).message); }
    finally { setWorking(false); }
  }
  async function start(ids?: string[], references?: string[]) {
    await action(async () => {
      const job = await api<FreshnessScan>("freshness", {
        document_ids: ids, request_id: crypto.randomUUID(),
        reference_document_ids: references ?? (reference ? [reference] : undefined),
      });
      setScanId(job.scan_id); setAfter(""); setCategory("");
    });
  }
  async function review(f: FreshnessFinding, decision: string) {
    await action(() => api("freshness-review", {
      scan_id: f.scan_id, finding_id: f.finding_id, expected_revision: f.revision,
      decision, note: note[noteKey(f)] ?? f.review_note ?? "",
    }));
  }
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button className="freshness-trigger">
          <FileSearch size={16} />
          {p.doc ? "Review freshness" : "Check for outdated documents"}
          {!p.doc && active(scan?.status) ? " · Running" : !p.doc && scan?.findings_total ? ` · ${scan.findings_total}` : ""}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className="reset-dialog freshness-dialog">
          <div className="search-options-heading">
            <div>
              <Dialog.Title>Document freshness review</Dialog.Title>
              <Dialog.Description>
                Start a manual Jev scan for possible problems. Suggestions include original passages.
                Your files are changed only when you update them.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild><button className="icon" aria-label="Close freshness review"><X size={18} /></button></Dialog.Close>
          </div>
          <div className="freshness-controls">
            <button disabled={working || active(scan?.status)} onClick={() => void start(p.doc ? [p.doc.document_id] : undefined)}>
              {p.doc ? "Recheck this file" : "Scan all documents"}
            </button>
            {scan && active(scan.status) && <button disabled={working} onClick={() => void action(() => api("freshness-cancel", { scan_id: scan.scan_id }))}>Cancel scan</button>}
            <details onToggle={e => setReferenceOpen(e.currentTarget.open)}>
              <summary>Optional reference</summary>
              <label>Trusted reference document
                <select value={reference} onChange={e => {
                  setReference(e.target.value);
                  setReferenceName(referencePage?.documents.find(d => d.document_id === e.target.value)?.filename || "");
                }}>
                  <option value="">No preferred source</option>
                  {reference && !referencePage?.documents.some(d => d.document_id === reference) && <option value={reference}>{referenceName}</option>}
                  {referencePage?.documents.map(d => <option key={d.document_id} value={d.document_id}>{d.filename} · {d.version}{d.folder ? ` · ${d.folder}` : ""}</option>)}
                </select>
              </label>
              <div className="freshness-controls">
                {referenceOffset > 0 && <button onClick={() => setReferenceOffset(v => Math.max(0, v - 100))}>Previous reference files</button>}
                {referencePage?.has_more && <button onClick={() => setReferenceOffset(v => v + 100)}>More reference files</button>}
              </div>
              <small>Choose a reference only if it applies to the same product, environment and time. Without one, disagreements remain conflicts.</small>
            </details>
          </div>
          {error && <p className="notice error" role="alert">{error}</p>}
          {scan && (
            <section className="freshness-progress" aria-live="polite">
              <strong>{scan.status === "partial" ? "Finished with gaps" : scan.status === "completed" ? "Scan finished" : scan.status.replaceAll("_", " ")}</strong>
              <p>{scan.documents_read} / {scan.documents_total} files read · {scan.passages_matched} / {scan.passages_read} passages searched · {scan.pairs_checked} / {scan.pairs_total} candidate pairs processed</p>
              {active(scan.status) && <progress aria-label="Freshness scan progress" {...(scan.status === "comparing" && scan.passages_matched === scan.passages_read ? { max: Math.max(scan.pairs_total, 1), value: scan.pairs_checked } : {})} />}
              {active(scan.status) && <p>Results appear as each document is checked. Candidate pairs are checked for a shared subject before detailed review. The total grows while passages are still being searched.</p>}
              {!!scan.usage.freshness_screened_pairs && <p>{scan.usage.freshness_screened_out_pairs || 0} unrelated pairs skipped after the subject check · {scan.usage.freshness_detailed_pairs || 0} pairs given a detailed review</p>}
              {scan.current_filename && <p>{scan.current_filename}</p>}
              <p>{scan.findings_total} suggestions · Checked {new Date(scan.checked_at).toLocaleString()}</p>
              {scan.coverage_changed && <p className="notice">The library or check date has changed. Run a new scan to refresh coverage.</p>}
              {scan.error && <p className="notice error">{scan.error}</p>}
              {!!Object.keys(scan.gaps).length && <details open><summary>Coverage gaps</summary><ul>{Object.entries(scan.gaps).map(([key, count]) => <li key={key}>{gaps[key] || key}: {count}</li>)}</ul></details>}
            </section>
          )}
          <div className="freshness-controls">
            <label>Scan
              <select value={scanId} onChange={e => { setScanId(e.target.value); setAfter(""); }}>
                <option value="">Latest scan</option>
                {page?.recent_scans.map(s => <option key={s.scan_id} value={s.scan_id}>{new Date(s.created_at).toLocaleString()} · {s.status}</option>)}
              </select>
            </label>
            <label>Label
              <select aria-label="Freshness label" value={category} onChange={e => { setCategory(e.target.value); setAfter(""); }}>
                <option value="">All labels</option>
                {Object.entries(labels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
              </select>
            </label>
          </div>
          {p.doc && <p>Showing findings involving {p.doc.filename}.</p>}
          {!scan && <p>No scan yet. Start a scan when you want to check the library.</p>}
          {scan && !page?.findings.length && <p>{active(scan.status) ? "Findings will appear as comparisons finish." : "No suggestions in this view. This does not prove the documents are up to date."}</p>}
          <div className="freshness-findings">
            {page?.findings.map(f => (
              <article key={f.finding_id} className="freshness-finding">
                <h3>{f.label} <small>· {f.review}</small></h3>
                {f.validity !== "valid" && <p className="notice">{f.validity === "source_removed" ? "A source was removed." : "Evidence or check date changed."} Recheck before acting on this suggestion.</p>}
                <div className="freshness-quick-actions" role="group" aria-label={"Quick actions for " + f.label}>
                  <strong>Quick actions</strong>
                  {f.affected_document_id && f.evidence.filter(e => e.document_id === f.affected_document_id).slice(0, 1).map(e => (
                    <button key={e.document_id} disabled={working || f.validity !== "valid"} onClick={() => { setOpen(false); p.onUpdate(document(e)); }}>
                      Upload corrected version
                    </button>
                  ))}
                  {(["confirmed", "dismissed", "historical", "pending"] as const).map((decision, i) =>
                    decision !== f.review &&
                    <button key={decision} disabled={working || f.validity !== "valid"} onClick={() => void review(f, decision)}>{["Confirm", "Dismiss", "Keep as historical", "Reopen"][i]}</button>
                  )}
                  <button disabled={working || active(scan?.status)} onClick={() => void start([...new Set(f.evidence.map(e => e.document_id))], f.reference_document_ids)}>Recheck</button>
                </div>
                <p>{f.reason}</p>
                {f.decision.judgments && <details className="freshness-confidence">
                  <summary>Why this label?</summary>
                  <p>These scores describe how clearly Jev preferred an answer. They are not proof that a document is correct.</p>
                  <ul>{Object.entries(f.decision.judgments).filter(([name]) => !f.decision.used_judgments || f.decision.used_judgments.includes(name)).map(([name, answer]) => (
                    <li key={name}>{({ subject: "Subject", setting: "Operating conditions", specificity: "Claim detail", period: "Time and applicability", effective_change: "Change in effect", relation: "Relationship" } as Record<string, string>)[name] || name}: {answer.choice.replaceAll("_", " ")} · confidence {Math.round(answer.confidence * 100)}%</li>
                  ))}</ul>
                </details>}
                {f.reference_document_ids.length > 0 && <p>Selected reference: {f.evidence.filter(e => f.reference_document_ids.includes(e.document_id)).map(e => e.filename).join(", ") || "See scan settings"}</p>}
                <div className="freshness-evidence">
                  {f.evidence.map((e, i) => (
                    <section key={i}>
                      <strong className="freshness-source-name">{e.filename} · {e.version}</strong>
                      <div className="freshness-controls" role="group" aria-label={"Actions for " + e.filename}>
                        <button disabled={f.validity === "source_removed"} onClick={() => { setOpen(false); p.onOpen(document(e)); }}>Open document</button>
                        <button disabled={working || f.validity !== "valid"} onClick={() => { setOpen(false); p.onUpdate(document(e)); }}>Upload corrected version</button>
                      </div>
                      <blockquote>{e.text}</blockquote>
                      <small>{e.evidence_id} · Characters {e.start}–{e.end}</small>
                    </section>
                  ))}
                </div>
                <label>Review note
                  <input aria-label={"Review note for " + f.label} value={note[noteKey(f)] ?? f.review_note ?? ""} maxLength={2000} onChange={e => setNote(v => ({ ...v, [noteKey(f)]: e.target.value }))} />
                </label>
              </article>
            ))}
          </div>
          <div className="freshness-controls">
            {after && <button onClick={() => setAfter("")}>First page</button>}
            {page?.has_more && <button onClick={() => setAfter(page.next_after)}>Next findings</button>}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
