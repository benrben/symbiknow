import { useEffect, useRef, useState, type RefObject } from "react";
import { Search, ChevronUp, ChevronDown, X } from "lucide-react";
import { findTextMatches, boundedHistory } from "../tools";
import { readSaved, save, preferenceKey } from "../../../shared/presentation/format";

type HighlightStore = {
  set: (key: string, value: unknown) => void;
  delete: (key: string) => void;
};
const highlightApi = () =>
  (CSS as unknown as { highlights?: HighlightStore }).highlights;
type Position = { id: string; top: number };
export default function ReaderTools(p: {
  content: RefObject<HTMLDivElement | null>;
  ready: boolean;
  identity: string;
  libraryId?: string;
}) {
  const [query, setQuery] = useState("");
  const [current, setCurrent] = useState(0);
  const [count, setCount] = useState(0);
  const [resumed, setResumed] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const ranges = useRef<Range[]>([]);
  useEffect(() => {
    setQuery("");
    setCurrent(0);
    setResumed(false);
  }, [p.identity]);
  useEffect(() => {
    if (!p.ready || !p.content.current || !p.libraryId) return;
    const scroller =
      p.content.current.closest<HTMLElement>(".inspector-content");
    if (!scroller) return;
    const key = preferenceKey(p.libraryId, "readingPositions");
    const stored = readSaved<Position[]>(key, []);
    const previous = Array.isArray(stored)
      ? stored.find((item) => item.id === p.identity)
      : undefined;
    const frame = requestAnimationFrame(() => {
      scroller.scrollTop = Number.isFinite(previous?.top)
        ? Math.max(0, previous!.top)
        : 0;
      setResumed(scroller.scrollTop > 40);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let top = previous?.top || 0;
    const persist = () => {
      const latest = readSaved<Position[]>(key, []);
      save(
        key,
        boundedHistory(
          Array.isArray(latest) ? latest : [],
          { id: p.identity, top },
          200,
        ),
      );
    };
    const remember = () => {
      top = scroller.scrollTop;
      clearTimeout(timer);
      timer = setTimeout(persist, 250);
    };
    scroller.addEventListener("scroll", remember, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      scroller.removeEventListener("scroll", remember);
      persist();
    };
  }, [p.ready, p.identity, p.libraryId, p.content]);
  useEffect(() => {
    const root = p.content.current;
    ranges.current = [];
    setCurrent(0);
    if (root && p.ready && query.trim()) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const nodes: { node: Node; start: number; end: number }[] = [];
      let text = "",
        node: Node | null;
      let previousBlock: Element | null = null;
      while ((node = walker.nextNode())) {
        const block =
          node.parentElement?.closest(
            "p,h1,h2,h3,h4,h5,h6,li,td,th,pre,blockquote",
          ) || null;
        if (previousBlock && block !== previousBlock) text += "\n";
        previousBlock = block;
        const value = node.textContent || "";
        nodes.push({
          node,
          start: text.length,
          end: text.length + value.length,
        });
        text += value;
      }
      for (const match of findTextMatches(text, query)) {
        const a = nodes.find((n) => n.end > match.start),
          b = nodes.find((n) => n.end >= match.end);
        if (!a || !b) continue;
        const range = document.createRange();
        range.setStart(a.node, match.start - a.start);
        range.setEnd(b.node, match.end - b.start);
        ranges.current.push(range);
      }
    }
    setCount(ranges.current.length);
    const Highlight = (
      window as unknown as { Highlight?: new (...ranges: Range[]) => unknown }
    ).Highlight;
    if (Highlight)
      highlightApi()?.set("reader-matches", new Highlight(...ranges.current));
    return () => {
      highlightApi()?.delete("reader-matches");
      highlightApi()?.delete("reader-current");
    };
  }, [query, p.ready, p.identity, p.content]);
  useEffect(() => {
    const range = ranges.current[current];
    const Highlight = (
      window as unknown as { Highlight?: new (...ranges: Range[]) => unknown }
    ).Highlight;
    if (Highlight)
      highlightApi()?.set(
        "reader-current",
        new Highlight(...(range ? [range] : [])),
      );
    if (range)
      range.startContainer.parentElement?.scrollIntoView({
        block: "center",
        behavior: "auto",
      });
  }, [current, count, query]);
  function move(direction: number) {
    if (count) setCurrent((n) => (n + direction + count) % count);
  }
  return (
    <div className="reader-tools">
      <label className="reader-find">
        <Search size={16} />
        <input
          ref={input}
          type="search"
          aria-label="Find in document"
          placeholder="Find in document…"
          maxLength={200}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              move(e.shiftKey ? -1 : 1);
            }
            if (e.key === "Escape") {
              e.stopPropagation();
              setQuery("");
            }
          }}
        />
      </label>
      {query && (
        <>
          <output role="status" aria-live="polite">
            {count
              ? `${current + 1} / ${count}${count === 500 ? "+" : ""}`
              : "No matches"}
          </output>
          <button
            className="icon"
            aria-label="Previous text match"
            disabled={!count}
            onClick={() => move(-1)}
          >
            <ChevronUp size={16} />
          </button>
          <button
            className="icon"
            aria-label="Next text match"
            disabled={!count}
            onClick={() => move(1)}
          >
            <ChevronDown size={16} />
          </button>
          <button
            className="icon"
            aria-label="Clear document search"
            onClick={() => {
              setQuery("");
              input.current?.focus();
            }}
          >
            <X size={16} />
          </button>
        </>
      )}
      {resumed && !query && (
        <button
          className="resume-reading"
          onClick={() => {
            p.content.current?.closest(".inspector-content")?.scrollTo(0, 0);
            setResumed(false);
          }}
        >
          Resumed · Back to top
        </button>
      )}
    </div>
  );
}
