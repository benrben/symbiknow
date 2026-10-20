import type { Doc, Evidence } from "../../shared/api/client";

// Presentation consumes backend decisions and their supplied, versioned windows.
// It neither classifies passages nor promotes unknown references to citations.
export function searchEvidence(doc: Doc, evaluate = true) {
  const j = evaluate && doc.jev?.status === "evaluated" ? doc.jev : undefined;
  const role = (id: string) =>
    j?.disagreement_chunk_ids?.includes(id)
      ? "Evidence disagreement"
      : j?.conflicting_chunk_ids?.includes(id)
        ? "Premise correction"
        : j?.supporting_chunk_ids?.includes(id)
          ? "Supporting evidence"
          : j?.possible_conflicting_chunk_ids?.includes(id)
            ? "Possible correction"
            : "Retrieved passage";
  const priority = (id: string) =>
    j?.conflicting_chunk_ids?.includes(id) ||
    j?.supporting_chunk_ids?.includes(id)
      ? 0
      : j?.disagreement_chunk_ids?.includes(id)
        ? 1
        : j?.possible_conflicting_chunk_ids?.includes(id)
          ? 2
          : 3;
  return (doc.evidence || [])
    .filter((e) =>
      e.evidence_id.startsWith(`${doc.document_id}:${doc.version}:`),
    )
    .map((e) => {
      const window = j?.evaluated_evidence?.find(
        (w) => w.chunk_id === e.evidence_id,
      );
      return {
        evidence: window
          ? {
              ...e,
              text: window.text,
              provenance: window.location || e.provenance,
            }
          : e,
        role: role(e.evidence_id),
        priority: priority(e.evidence_id),
      };
    })
    .sort((a, b) => a.priority - b.priority);
}

// Extraction wraps are spaces inside a prose paragraph. Blank lines and fenced
// blocks remain structural boundaries; version decimals are not sentence stops.
export function proseSentences(text: string) {
  const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
  return text
    .replace(/^\s*#{1,6}[^\n]*\n/gm, "")
    .split(/(```[\s\S]*?```)/g)
    .flatMap((block) => {
      if (block.startsWith("```")) return [block.trim()];
      return block.split(/\n\s*\n/).flatMap((paragraph) => {
        const prose = paragraph
          .replace(/\s*\n\s*/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        return prose
          ? Array.from(segmenter.segment(prose), (s) => s.segment.trim())
          : [];
      });
    });
}
export function passagePreview(
  e: Evidence,
  limit = 360,
  query = "",
  compact = false,
) {
  const sentences = proseSentences(e.text);
  let text = query
    ? sentences.join(" ")
    : e.text.replace(/^\s*#{1,6}[^\n]*\n/gm, "").trim();
  if (query && text.length > (compact ? 80 : limit) && sentences.length) {
    const words = (s: string) =>
      s.toLowerCase().match(/\p{L}[\p{L}\p{N}]*/gu) || [];
    const headings = new Set(words((e.provenance?.headings || []).join(" ")));
    const stops = new Set([
      "does",
      "which",
      "where",
      "what",
      "the",
      "use",
      "uses",
      "with",
      "that",
      "for",
      "how",
      "why",
      "and",
      "are",
      "using",
    ]);
    const terms = [...new Set(words(query))].filter(
      (t) => t.length > 2 && !headings.has(t) && !stops.has(t),
    );
    const tokens = sentences.map((s) => new Set(words(s)));
    // Lexical focus within an already supplied window; never an answer decision.
    // Rare query terms avoid a generic entity introduction outranking the sentence.
    const hasTerm = (set: Set<string>, t: string) =>
      set.has(t) ||
      set.has(t + "s") ||
      (t.endsWith("s") && set.has(t.slice(0, -1)));
    const frequency = (t: string) =>
      tokens.filter((set) => hasTerm(set, t)).length;
    const score = (i: number) =>
      terms.reduce(
        (n, t) => n + (hasTerm(tokens[i], t) ? 1 / frequency(t) : 0),
        0,
      );
    let best = 0;
    for (let i = 1; i < sentences.length; i++)
      if (score(i) > score(best)) best = i;
    if (score(best) > 0) {
      text = sentences[best];
      // A punctuation-only lead is an extraction fragment, never a useful excerpt.
      if (/^[,;:]/.test(text) && best > 0)
        text = sentences[best - 1] + " " + text;
    }
  }
  if (compact) {
    // Compact cards simplify formatting, not the sentence's meaning. Removing
    // its middle can discard the subject or mechanism even if negation survives.
    // ContentCard already bounds the supplied preview; CSS owns its visible size.
    return text.replace(/\*\*|__/g, "").replace(/\s+([,;:.!?])/g, "$1");
  }
  if (text.length <= limit) return text;
  const boundary = text.lastIndexOf(" ", limit);
  return text.slice(0, boundary > limit / 2 ? boundary : limit) + "…";
}
