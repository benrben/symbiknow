import { ArrowUpRight, FileText, Folder, Network, Sparkles, Tag } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { title, kind, type Doc, type Link } from "../../../shared/api/client";
import ContentCard from "./ContentCard";

export function ConnectedWorkspace(p: {
  featured?: Doc; folders: [string, number][]; files: ReactNode;
  onOpen: (doc: Doc) => void; onFolder: (folder: string) => void;
  onMap: () => void; selected?: Doc; group?: string;
}) {
  return <div className="connected-workspace">
    {!!p.folders.length && <section className="space-section" aria-label="Folders in this space">
      <div className="section-caption"><h2>Your spaces</h2><span>Folders that keep things together</span></div>
      <div className="space-shelves">{p.folders.map(([path, count]) =>
        <button key={path} className="space-tile" onClick={() => p.onFolder(path)} title={path}>
          <Folder size={20} /><strong>{path.split(" / ").at(-1)}</strong><small>{count} files</small><ArrowUpRight size={14} />
        </button>)}</div>
    </section>}
    {p.featured && <section className="focus-document" aria-label="Featured file">
      <div className="focus-copy">
        <span className="eyebrow"><span className="live-dot" />{p.selected ? "In focus" : "From your library"}</span>
        <h2>{title(p.featured)}</h2>
        <p>{p.featured.folder || "Unfiled"} <span>· {kind(p.featured)} · {p.featured.version}</span></p>
        <div className="focus-actions"><button className="primary" onClick={() => p.onOpen(p.featured!)}>Open file <ArrowUpRight size={15}/></button><button onClick={p.onMap}><Network size={15} /> Explore map</button></div>
      </div>
      <ContentCard key={p.featured.document_id + p.featured.version} doc={p.featured} />
    </section>}
    <section className="working-files" aria-label="Files in this space">
      <div className="section-caption"><h2>{p.group ? `Files about ${p.group}` : "Your files"}</h2><span>Select to explore · Double-click to read</span></div>
      {p.files}
    </section>
  </div>;
}

export function KnowledgeRail(p: {
  doc?: Doc; links: Link[]; neighbors: Doc[]; loading: boolean; error: string;
  groups: string[]; group?: string; onGroup: (group: string) => void;
  onOpen: (doc: Doc) => void; onLink: (link: Link) => void; onRetry: () => void;
  onAsk: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => setExpanded(false), [p.doc?.document_id, p.doc?.version]);
  const seen = new Set<string>();
  const related = p.links.filter(l => {
    if (!p.doc || (l.source_document_id !== p.doc.document_id && l.document_id !== p.doc.document_id)) return false;
    const key = [l.source_document_id, l.document_id, l.relation].join(":");
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  const topics = p.doc?.groups?.length ? p.doc.groups : p.groups;
  return <aside className="knowledge-rail" aria-label="Connected knowledge">
    <div className="rail-title"><span className="jev-mark"><Sparkles size={18}/></span><div><strong>Jev</strong><small>Your knowledge, connected</small></div></div>
    <section className="rail-section">
      <div className="section-caption"><h2>Connections</h2><Network size={15}/></div>
      <p className="rail-context">{p.doc ? <>For <strong>{title(p.doc)}</strong></> : "Select a file to explore its connections."}</p>
      {p.loading ? <p role="status">Loading connections…</p> : p.error ? <div role="alert"><p>{p.error}</p><button onClick={p.onRetry}>Retry connections</button></div> : related.length ? <div className="connection-stack">{(expanded ? related : related.slice(0, 3)).map((link) => {
        const outbound = link.source_document_id === p.doc?.document_id;
        const id = outbound ? link.document_id : link.source_document_id;
        const version = outbound ? link.version : link.source_version;
        const doc = p.neighbors.find(d => d.document_id === id && d.version === version);
        const name = doc ? title(doc) : outbound ? link.target_filename : link.source_filename;
        return <article className="connection-note" key={[link.source_document_id, link.document_id, link.relation].join(":")}>
          <span className="relation-label">{link.relation === "related" ? "Related to this file" : `${outbound ? "This file" : "Connected file"} ${link.relation.replaceAll("_", " ")}`}</span>
          <button className="related-file" disabled={!doc} onClick={() => doc && p.onOpen(doc)}><FileText size={15}/><span>{name || "Connected document"}</span><ArrowUpRight size={13}/></button>
          <button className="evidence-link" onClick={() => p.onLink(link)}>See connection evidence <span>↗</span></button>
        </article>;
      })}{related.length > 3 && <button className="more-connections" onClick={() => setExpanded(v => !v)}>{expanded ? "Show fewer connections" : `Show all ${related.length} connections`}</button>}</div> : p.doc && <div className="rail-empty"><Network size={22}/><p>No recorded connections yet.</p><small>Use Review connections in Library actions to look for links.</small></div>}
    </section>
    <section className="rail-section"><div className="section-caption"><h2>{p.doc?.groups?.length ? "Topics in this file" : "Library topics"}</h2><Tag size={15}/></div><div className="topic-chips">{topics.map(g => <button key={g} aria-pressed={p.group === g} onClick={() => p.onGroup(g)}>{g}</button>)}</div>{!topics.length && <p className="rail-context">Topics will appear as your files are organized.</p>}</section>
    <div className="ask-card"><Sparkles size={16}/><strong>Put your files to work.</strong><p>Ask a question. Jev checks the passages and shows the supporting sources.</p><button onClick={p.onAsk}>Ask Jev <ArrowUpRight size={15}/></button><small>Answer checks send selected passages to the configured hosted judge.</small></div>
  </aside>;
}
