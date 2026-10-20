import { useCallback, useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ArrowRight, Check, ChevronLeft, ChevronRight, Folder, Network, Sparkles, X } from "lucide-react";
import { api, type JevDecisionQueue } from "../../../shared/api/client";

export default function JevDecisions({ onResolved }: { onResolved: () => void }) {
  const [queue, setQueue] = useState<JevDecisionQueue>({ decisions: [], has_more: false });
  const [loaded, setLoaded] = useState(false);
  const primary = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState("");
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  const serial = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++serial.current;
    try {
      const next = await api<JevDecisionQueue>("jev-decisions");
      if (!alive.current || request !== serial.current) return;
      setQueue(next); setUnavailable(false); setLoaded(true);
    } catch {
      if (alive.current && request === serial.current) setUnavailable(true);
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    void refresh();
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 10000);
    const focus = () => void refresh();
    window.addEventListener("focus", focus);
    return () => { alive.current = false; serial.current++; clearInterval(timer); window.removeEventListener("focus", focus); };
  }, [refresh]);
  const decision = queue.decisions.find(d => d.id === selected) || queue.decisions[0];
  const position = decision ? queue.decisions.indexOf(decision) : 0;
  useEffect(() => { setEditing(false); setValue(decision?.suggested || ""); setError(""); }, [decision?.id, decision?.suggested]);
  useEffect(() => {
    if (open && !busy && document.activeElement === document.body) primary.current?.focus();
  }, [decision?.id, open, busy]);
  async function resolve(action: "accept" | "change" | "skip") {
    if (!decision || busy) return;
    setBusy(true); setError("");
    // Invalidate any earlier queue read before committing a decision.
    serial.current++;
    try {
      await api("jev-decision", { decision_id: decision.id, action, ...(action === "change" ? { value } : {}) });
      setQueue(q => ({ ...q, decisions: q.decisions.filter(d => d.id !== decision.id) }));
      setEditing(false); onResolved();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save this decision. Try again.");
      await refresh();
    } finally { setBusy(false); }
  }
  return <Dialog.Root open={open} onOpenChange={next => { if (!busy) { setOpen(next); if (next) void refresh(); } }} modal={false}>
    <Dialog.Trigger asChild>
      <button className={`jev-presence ${queue.decisions.length ? "has-decisions" : ""}`}
        aria-label={unavailable ? "Jev decisions unavailable. Retry" : queue.decisions.length ? `Jev · ${queue.decisions.length}${queue.has_more ? "+" : ""} ${queue.decisions.length === 1 ? "decision needs" : "decisions need"} you` : loaded ? "Jev · No decisions needed" : "Jev"}>
        <Sparkles size={19} aria-hidden="true" />
        {unavailable ? <span>Retry Jev</span> : !!queue.decisions.length && <><strong>Jev</strong><span>{queue.decisions.length}{queue.has_more ? "+" : ""} {queue.decisions.length === 1 ? "decision" : "decisions"}</span></>}
      </button>
    </Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Content className="jev-decision-panel" onInteractOutside={event => { if (busy) event.preventDefault(); }}>
        <header className="jev-decision-header">
          <span className="jev-avatar"><Sparkles size={19}/></span>
          <div><Dialog.Title>Jev</Dialog.Title><Dialog.Description>{unavailable ? "Decisions unavailable" : !loaded ? "Checking for decisions…" : decision ? "A decision for you or your agent" : "Nothing needs your decision"}</Dialog.Description></div>
          <Dialog.Close className="icon" aria-label="Close Jev" disabled={busy}><X size={18}/></Dialog.Close>
        </header>
        {unavailable && <div className="jev-problem" role="alert">Couldn’t check for decisions. <button onClick={() => void refresh()}>Retry</button></div>}
        {decision ? <div className="jev-decision-body" aria-busy={busy}>
          <div className="jev-decision-kind">{decision.kind === "folder" ? <Folder size={15}/> : <Network size={15}/>}{decision.kind === "folder" ? "File placement" : "Possible connection"}</div>
          <h2>{decision.kind === "folder" ? "Does this belong here?" : "Connect these files?"}</h2>
          <div className="jev-decision-pair"><span>{decision.filename}</span><ArrowRight size={16}/><strong>{decision.kind === "folder" ? decision.suggested : decision.target_filename}</strong></div>
          <p className="jev-decision-reason">{decision.reason}</p>
          <details className="jev-decision-evidence" key={decision.id}>
            <summary>See the evidence</summary>
            <strong>{decision.filename} · {decision.version}</strong><blockquote>{decision.excerpt || "No text excerpt available."}</blockquote>
            {decision.target_filename && <><strong>{decision.target_filename} · {decision.target_version}</strong><blockquote>{decision.target_excerpt || "No text excerpt available."}</blockquote></>}
            {decision.kind === "folder" && <p>Currently in {decision.current}</p>}
          </details>
          {editing && <div className="jev-decision-edit"><label htmlFor="jev-choice">{decision.kind === "folder" ? "Choose a folder" : "Connection type"}</label>
            {decision.kind === "folder" ? <><input autoFocus id="jev-choice" list="jev-folders" value={value} disabled={busy} onChange={e => setValue(e.target.value)} placeholder="Folder / Subfolder"/><datalist id="jev-folders">{decision.options.map(option => <option key={option} value={option}/>)}</datalist></> : <select autoFocus id="jev-choice" value={value} disabled={busy} onChange={e => setValue(e.target.value)}>{decision.options.map(option => <option key={option} value={option}>{option[0].toUpperCase() + option.slice(1)}</option>)}</select>}
          </div>}
          {error && <p role="alert" className="jev-problem">{error}</p>}
          <div className="jev-decision-actions"><button ref={primary} className="primary" disabled={busy || unavailable || (editing && !value.trim())} onClick={() => void resolve(editing ? "change" : "accept")}><Check size={16}/>{busy ? "Saving…" : editing ? "Save decision" : "Accept"}</button><button disabled={busy} onClick={() => { setEditing(!editing); setValue(decision.suggested); }}>{editing ? "Cancel" : "Change"}</button><button className="jev-skip" disabled={busy || unavailable} onClick={() => void resolve("skip")}>Skip</button></div>
          <footer><span>{position + 1} of {queue.decisions.length}{queue.has_more ? "+" : ""} decisions</span><div><button className="icon" aria-label="Previous decision" disabled={busy || position === 0} onClick={() => setSelected(queue.decisions[position - 1].id)}><ChevronLeft size={16}/></button><button className="icon" aria-label="Next decision" disabled={busy || position >= queue.decisions.length - 1} onClick={() => setSelected(queue.decisions[position + 1].id)}><ChevronRight size={16}/></button></div></footer>
        </div> : loaded && !unavailable && <div className="jev-quiet"><Check size={22}/><p>You’re all clear.</p><span>I’ll surface the next decision here.</span></div>}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
