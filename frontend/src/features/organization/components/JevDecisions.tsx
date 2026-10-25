import { useCallback, useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ArrowRight, Check, ChevronLeft, ChevronRight, Folder, Network, Sparkles, X } from "lucide-react";
import { api, type JevDecisionQueue } from "../../../shared/api/client";

export default function JevDecisions({ onResolved }: { onResolved: () => void }) {
  const [queue, setQueue] = useState<JevDecisionQueue>({ decisions: [], has_more: false });
  const [loaded, setLoaded] = useState(false);
  const primary = useRef<HTMLButtonElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState("");
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState("");
  const [loading, setLoading] = useState(false);
  const cursors = useRef([""]);
  const saving = useRef(false);
  const reading = useRef(false);
  const alive = useRef(true);
  const serial = useRef(0);
  const pollDelay = useRef(10000);
  const abort = useRef<AbortController | undefined>(undefined);
  const refresh = useCallback(async (after = cursors.current.at(-1) || "", previous = false) => {
    abort.current?.abort();
    abort.current = new AbortController();
    const request = ++serial.current;
    reading.current = true;
    setLoading(true);
    try {
      const next = await api<JevDecisionQueue>("jev-decisions" + (after ? "?after=" + encodeURIComponent(after) : ""), undefined, abort.current.signal);
      if (!alive.current || request !== serial.current) return;
      if (previous) { cursors.current.pop(); setSelected(next.decisions.at(-1)?.id || ""); }
      else if (after !== cursors.current.at(-1)) { cursors.current.push(after); setSelected(next.decisions[0]?.id || ""); }
      pollDelay.current = next.decisions.length ? 10000 : Math.min(60000, pollDelay.current * 2);
      setQueue(next); setUnavailable(false); setLoaded(true);
    } catch {
      if (alive.current && request === serial.current) setUnavailable(true);
    } finally {
      if (alive.current && request === serial.current) { reading.current = false; setLoading(false); }
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    void refresh();
    let timer: number;
    const poll = async () => { if (!document.hidden && !saving.current && !reading.current) await refresh(); if (alive.current) timer = window.setTimeout(poll, pollDelay.current); };
    timer = window.setTimeout(poll, pollDelay.current);
    const focus = () => { if (!saving.current && !reading.current) void refresh(); };
    window.addEventListener("focus", focus);
    return () => { alive.current = false; serial.current++; clearTimeout(timer); abort.current?.abort(); window.removeEventListener("focus", focus); };
  }, [refresh]);
  const decision = queue.decisions.find(d => d.id === selected) || queue.decisions[0];
  const position = decision ? queue.decisions.indexOf(decision) : 0;
  useEffect(() => { setEditing(false); setValue(decision?.suggested || ""); setError(""); }, [decision?.id, decision?.suggested]);
  useEffect(() => {
    if (open && !busy && document.activeElement === document.body) primary.current?.focus();
  }, [decision?.id, open, busy]);
  async function resolve(action: "accept" | "change" | "skip") {
    if (!decision || busy) return;
    saving.current = true; setBusy(true); setError("");
    // Invalidate any earlier queue read before committing a decision.
    serial.current++;
    abort.current?.abort();
    try {
      await api("jev-decision", { decision_id: decision.id, action, ...(action === "change" ? { value } : {}) });
      const target = action === "change" ? value : decision.kind === "folder" ? decision.suggested : decision.target_filename;
      setReceipt(action === "skip" ? `Skipped ${decision.filename}. It stays as it is.` : decision.kind === "folder" ? `Moved ${decision.filename} to ${target}. You can move it again from its file menu.` : `Connected ${decision.filename} to ${decision.target_filename}${action === "change" ? ` as ${value}` : ""}.`);
      setQueue(q => ({ ...q, decisions: q.decisions.filter(d => d.id !== decision.id) }));
      setEditing(false); onResolved();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save this decision. Try again.");
      await refresh();
    } finally { saving.current = false; setBusy(false); }
  }
  // Open beneath the Jev button, right-aligned to it, instead of floating mid-screen.
  function anchor() {
    const box = trigger.current?.getBoundingClientRect();
    if (!box) return undefined;
    return { top: box.bottom + 8, right: Math.min(Math.max(14, window.innerWidth - box.right), Math.max(14, window.innerWidth - Math.min(440, window.innerWidth - 28) - 14)), bottom: "auto", left: "auto", transform: "none", maxHeight: `calc(100dvh - ${Math.round(box.bottom) + 24}px)` } as const;
  }
  return <Dialog.Root open={open} onOpenChange={next => { if (!busy) { setOpen(next); if (!next) { cursors.current = [""]; setSelected(""); setReceipt(""); } void refresh(); } }} modal={false}>
    <Dialog.Trigger asChild>
      <button ref={trigger} title={unavailable ? "Jev: decisions unavailable. Click to retry" : queue.decisions.length ? "Jev · decisions that need you" : "Jev · suggests where files belong and how they connect"} className={`jev-presence ${queue.decisions.length ? "has-decisions" : ""}`}
        aria-label={unavailable ? "Retry Jev: decisions unavailable" : queue.decisions.length ? `Jev ${queue.decisions.length}${queue.has_more ? "+" : ""} ${queue.decisions.length === 1 ? "decision needs" : "decisions need"} you` : cursors.current.length > 1 ? "Jev: Browse decisions" : loaded ? "Jev: No decisions needed" : "Jev"}>
        <Sparkles size={19} aria-hidden="true" />
        <strong>{unavailable ? "Retry Jev" : "Jev"}</strong>{" "}
        {!!queue.decisions.length && !unavailable && <span aria-hidden="true">{queue.decisions.length}{queue.has_more ? "+" : ""}</span>}
      </button>
    </Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Content className="jev-decision-panel" style={anchor()} onInteractOutside={event => { if (busy) event.preventDefault(); }}>
        <header className="jev-decision-header">
          <span className="jev-avatar"><Sparkles size={19}/></span>
          <div><Dialog.Title>Jev</Dialog.Title><Dialog.Description>{unavailable ? "Decisions unavailable" : !loaded ? "Looking at your library" : decision ? "A decision for you or your agent" : cursors.current.length > 1 ? "No decisions left on this page" : "Nothing needs your decision"}</Dialog.Description></div>
          <Dialog.Close className="icon" aria-label="Close Jev" disabled={busy}><X size={18}/></Dialog.Close>
        </header>
        {receipt && <p className="jev-receipt" role="status"><Check size={14} aria-hidden="true" /> {receipt}</p>}
        {unavailable && <div className="jev-problem" role="alert">Couldn’t check for decisions. <button onClick={() => void refresh()}>Retry</button></div>}
        {loading && !loaded && <p className="jev-problem" role="status">Checking for decisions…</p>}
        {decision ? <div className="jev-decision-body" aria-busy={busy}>
          <div className="jev-decision-kind">{decision.kind === "folder" ? <Folder size={15}/> : <Network size={15}/>}{decision.kind === "folder" ? "File placement" : "Possible connection"}</div>
          <h2>{decision.kind === "folder" ? "Does this belong here?" : "Connect these files?"}</h2>
          <div className="jev-decision-pair"><span>{decision.filename}</span><ArrowRight size={16}/><strong>{decision.kind === "folder" ? decision.suggested : decision.target_filename}</strong></div>
          <p className="jev-decision-reason">{decision.reason}</p>
          <details className="jev-decision-evidence" key={decision.id} open>
            <summary>See the evidence</summary>
            <strong>{decision.filename} · {decision.version}</strong><blockquote>{decision.excerpt || "No text excerpt available."}</blockquote>
            {decision.target_filename && <><strong>{decision.target_filename} · {decision.target_version}</strong><blockquote>{decision.target_excerpt || "No text excerpt available."}</blockquote></>}
            {decision.kind === "folder" && <p>Currently in {decision.current}</p>}
          </details>
          {editing && <div className="jev-decision-edit"><label htmlFor="jev-choice">{decision.kind === "folder" ? "Choose a folder" : "Connection type"}</label>
            {decision.kind === "folder" ? <><input autoFocus id="jev-choice" list="jev-folders" value={value} disabled={busy} onChange={e => setValue(e.target.value)} placeholder="Folder / Subfolder"/><datalist id="jev-folders">{decision.options.map(option => <option key={option} value={option}/>)}</datalist></> : <select autoFocus id="jev-choice" value={value} disabled={busy} onChange={e => setValue(e.target.value)}>{decision.options.map(option => <option key={option} value={option}>{option[0].toUpperCase() + option.slice(1)}</option>)}</select>}
          </div>}
          {error && <p role="alert" className="jev-problem">{error}</p>}
          <p className="jev-decision-hint">{decision.kind === "folder" ? `Accept moves this file to ${decision.suggested}. Change lets you choose another folder. Skip leaves it where it is.` : "Accept saves this connection. Change lets you pick another type. Skip leaves the files unconnected."}</p>
          <div className="jev-decision-actions"><button ref={primary} className="primary" disabled={busy || unavailable || (editing && !value.trim())} onClick={() => void resolve(editing ? "change" : "accept")}><Check size={16}/>{busy ? "Saving…" : editing ? "Save decision" : "Accept"}</button><button disabled={busy} onClick={() => { setEditing(!editing); setValue(decision.suggested); }}>{editing ? "Cancel" : "Change"}</button><button className="jev-skip" disabled={busy || unavailable} onClick={() => void resolve("skip")}>Skip</button></div>
          <footer><span>{queue.decisions.length === 1 && !queue.has_more ? "1 decision" : `${position + 1} of ${queue.decisions.length}${queue.has_more ? "+" : ""} decisions on this page`}</span><div><button className="icon" aria-label="Previous decision" disabled={busy || loading || (position === 0 && cursors.current.length === 1)} onClick={() => position > 0 ? setSelected(queue.decisions[position - 1].id) : void refresh(cursors.current.at(-2), true)}><ChevronLeft size={16}/></button><button className="icon" aria-label="Next decision" disabled={busy || loading || (position >= queue.decisions.length - 1 && !queue.has_more)} onClick={() => position < queue.decisions.length - 1 ? setSelected(queue.decisions[position + 1].id) : void refresh(queue.next_after)}><ChevronRight size={16}/></button></div></footer>
        </div> : loaded && !unavailable && <div className="jev-quiet"><Check size={22}/><p>{queue.has_more ? "More decisions to check." : cursors.current.length > 1 ? "No decisions left on this page." : "You’re all clear."}</p>{queue.has_more ? <button disabled={loading} onClick={() => void refresh(queue.next_after)}>Next decisions</button> : cursors.current.length === 1 && <span>I’ll surface the next decision here.</span>}{cursors.current.length > 1 && <button disabled={loading} onClick={() => void refresh(cursors.current.at(-2), true)}>Previous decisions</button>}</div>}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
