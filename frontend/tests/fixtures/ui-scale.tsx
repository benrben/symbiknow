// Development-only synthetic data. Not imported by the product entrypoint.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import ConnectionMap from "../../src/features/connections/components/ConnectionMap";
import type { Doc, Link } from "../../src/shared/api/client";
import "../../src/styles/styles.css";
import "../../src/styles/redesign.css";
const docs: Doc[] = Array.from({ length: 10000 }, (_, i) => ({
  document_id: `fixture-${i}`,
  version: "v1",
  filename: `${i === 0 ? "A very long document title describing exact version provenance and readable knowledge navigation across deep folder hierarchies" : "Document " + i}.md`,
  folder: `Project ${Math.floor(i / 100)} / A deeper folder / Another level`,
  mime_type: "text/markdown",
}));
const folders = Object.fromEntries(
  Array.from({ length: 100 }, (_, i) => [
    `Project ${i} / A deeper folder / Another level`,
    100,
  ]),
);
const links: Link[] = Array.from({ length: 250 }, (_, i) => ({
  source_document_id: docs[0].document_id,
  source_version: "v1",
  document_id: docs[i + 1].document_id,
  version: "v1",
  source_filename: docs[0].filename,
  target_filename: docs[i + 1].filename,
  source_chunk_id: "fixture-0:v1:t0",
  target_chunk_id: `fixture-${i + 1}:v1:t0`,
  relation: i % 2 ? "supports" : "related",
}));
function App() {
  const [selected, setSelected] = useState<Doc>();
  const [link, setLink] = useState<Link>();
  return (
    <div style={{ height: "100dvh", display: "flex", flexDirection: "column" }}>
      <p style={{ padding: "10px 24px", margin: 0 }}>
        Synthetic fixture · 10,000 metadata rows · 100 groups · 250 connections.
        No library writes or model calls.
      </p>
      <ConnectionMap
        docs={docs}
        folders={folders}
        selected={selected?.document_id}
        selectedLink={link}
        links={selected ? links : []}
        total={10000}
        loaded={10000}
        hasMore={false}
        loading={false}
        linksLoading={false}
        linksError=""
        onRetryLinks={() => {}}
        onLoadMore={() => {}}
        onSelect={(d) => {
          setSelected(d);
          setLink(undefined);
        }}
        onOpen={() => {}}
        onLink={setLink}
        onClear={() => {
          setSelected(undefined);
          setLink(undefined);
        }}
        onFolder={() => {}}
        onFreeform={() => {}}
      />
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
