import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowDown,
  Check,
  ChevronDown,
  CircleAlert,
  Copy,
  LoaderCircle,
  Pause,
  Sparkles,
} from "lucide-react";
import type { Run, ToolState } from "./state";
import { record } from "./cards";

export function duration(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

const Answer = lazy(() => import("./Answer"));

function ToolGroup({
  tools,
  renderTool,
  toolLabel,
}: {
  tools: ToolState[];
  renderTool: (tool: ToolState) => ReactNode;
  toolLabel: (name: string) => string;
}) {
  const [expanded, setExpanded] = useState(true);
  const pending = tools.some((t) => t.state === "awaiting_approval");
  const active = tools.some((t) =>
    ["preparing", "running", "approved"].includes(t.state),
  );
  const failed = tools.some(
    (t) =>
      t.state === "error" ||
      (t.state === "done" && record(t.result).ok === false),
  );
  const Icon = pending
    ? Pause
    : active
      ? LoaderCircle
      : failed
        ? CircleAlert
        : Check;
  const summary = [...new Set(tools.map((t) => toolLabel(t.name)))].join(" · ");
  return (
    <div className="assistant-tool-group">
      <button
        type="button"
        className="assistant-group-toggle"
        aria-expanded={expanded || pending}
        onClick={() => setExpanded(!expanded)}
        disabled={pending}
      >
        <Icon
          size={14}
          className={active && !pending ? "assistant-spin" : ""}
        />
        <strong>
          {pending
            ? "Needs your approval"
            : `${tools.length} ${tools.length === 1 ? "step" : "steps"}`}
        </strong>
        <span title={summary}>{summary}</span>
        <ChevronDown
          size={14}
          className={expanded || pending ? "assistant-chevron-open" : ""}
        />
      </button>
      {(expanded || pending) && (
        <div className="assistant-tool-steps">
          {tools.map((t) => (
            <div key={t.id} className="assistant-step">
              {renderTool(t)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RunMessage({
  run,
  provider,
  modelName,
  renderTool,
  toolLabel,
  retry,
  retryDisabled,
}: {
  run: Run;
  provider: string;
  modelName: string;
  renderTool: (tool: ToolState) => ReactNode;
  toolLabel: (name: string) => string;
  retry?: (message: string) => void;
  retryDisabled?: boolean;
}) {
  const [now, setNow] = useState(Date.now()),
    [copy, setCopy] = useState("");
  useEffect(() => {
    if (run.status !== "running") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [run.status]);
  const pending = run.tools.some((t) => t.state === "awaiting_approval");
  const active = [...run.tools]
    .reverse()
    .find((t) => ["preparing", "running", "approved"].includes(t.state));
  const working = run.status === "running";
  const activity = pending
    ? "Waiting for your approval"
    : working
      ? active
        ? toolLabel(active.name)
        : run.text
          ? "Composing response"
          : "Working on your request"
      : run.status === "cancelled"
        ? "Stopped."
        : run.status === "error"
          ? "Could not finish"
          : "Complete";
  const Icon = pending
    ? Pause
    : working
      ? LoaderCircle
      : run.status === "error"
        ? CircleAlert
        : Check;
  return (
    <section
      className="assistant-run"
      aria-label={run.automatic ? "Approval follow-up" : "Conversation turn"}
    >
      {run.automatic ? (
        <p className="assistant-receipt">
          <Check size={13} /> Approval decision sent to agent
        </p>
      ) : (
        <div className="assistant-user">
          <span>You</span>
          <p>{run.message}</p>
        </div>
      )}
      <div className="assistant-speaker">
        <span className="assistant-avatar">
          <Sparkles size={14} />
        </span>
        <strong>{provider}</strong>
        <span title={run.model || modelName}>{modelName}</span>
      </div>
      {run.parts.map((part) =>
        part.type === "text" ? (
          <Suspense
            key={part.id}
            fallback={<div className="assistant-answer">{part.text}</div>}
          >
            <Answer text={part.text} />
          </Suspense>
        ) : (
          <ToolGroup
            key={part.id}
            tools={part.ids.flatMap(
              (id) => run.tools.find((t) => t.id === id) || [],
            )}
            renderTool={renderTool}
            toolLabel={toolLabel}
          />
        ),
      )}
      <div className="assistant-run-footer">
        <span
          className={`assistant-activity ${pending ? "needs-approval" : ""}`}
          role={working || pending ? "status" : undefined}
        >
          <Icon
            size={13}
            className={working && !pending ? "assistant-spin" : ""}
          />
          {activity}
        </span>
        {run.startedAt && (run.finishedAt || working) && (
          <span className="assistant-duration" aria-label="Elapsed time">
            {duration((run.finishedAt || now) - run.startedAt)}
          </span>
        )}
        {retry &&
          !run.automatic &&
          ["error", "cancelled"].includes(run.status) && (
            <button
              type="button"
              className="assistant-text-button"
              disabled={retryDisabled}
              onClick={() =>
                retry(
                  run.status === "cancelled"
                    ? `Continue the stopped request: ${run.message}\nCheck the completed tool receipts before retrying any changes.`
                    : `Retry the request: ${run.message}\nCheck the completed tool receipts before retrying any changes.`,
                )
              }
            >
              {run.status === "cancelled"
                ? "Continue stopped request"
                : "Retry message"}
            </button>
          )}
        {retry &&
          !run.automatic &&
          ["error", "cancelled"].includes(run.status) && (
            <small>A new request; completed changes are retained.</small>
          )}
        {!working && run.text && (
          <button
            type="button"
            className="assistant-text-button assistant-copy"
            aria-label="Copy response"
            onClick={() => {
              void navigator.clipboard.writeText(run.text).then(
                () => setCopy("Copied"),
                () => setCopy("Copy unavailable"),
              );
            }}
          >
            <Copy size={13} />
            {copy || "Copy"}
          </button>
        )}
      </div>
      {run.model && (
        <div className="assistant-model-used">Model: {run.model}</div>
      )}
    </section>
  );
}

export function Thread({
  runs,
  provider,
  modelName,
  renderTool,
  toolLabel,
  children,
  retry,
  retryDisabled,
}: {
  runs: Run[];
  provider: string;
  modelName: string;
  renderTool: (tool: ToolState) => ReactNode;
  toolLabel: (name: string) => string;
  children?: ReactNode;
  retry?: (message: string) => void;
  retryDisabled?: boolean;
}) {
  const viewport = useRef<HTMLDivElement>(null),
    content = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [away, setAway] = useState(false);
  const latest = () => {
    following.current = true;
    setAway(false);
    const el = viewport.current;
    if (el) el.scrollTop = el.scrollHeight;
  };
  useLayoutEffect(() => {
    if (following.current) latest();
  }, [runs]);
  useEffect(() => {
    if (!content.current) return;
    const observer = new ResizeObserver(() => {
      if (following.current) latest();
    });
    observer.observe(content.current);
    return () => observer.disconnect();
  }, []);
  return (
    <div className="assistant-thread">
      <div
        ref={viewport}
        className="assistant-log"
        tabIndex={0}
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-label="Conversation"
        onScroll={() => {
          const el = viewport.current;
          if (!el) return;
          following.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 90;
          setAway(!following.current);
        }}
      >
        <div ref={content} className="assistant-thread-content">
          {children}
          {runs.map((run) => (
            <RunMessage
              key={run.id}
              run={run}
              provider={provider}
              modelName={modelName}
              renderTool={renderTool}
              toolLabel={toolLabel}
              retry={retry}
              retryDisabled={retryDisabled}
            />
          ))}
        </div>
      </div>
      {away && (
        <button type="button" className="assistant-jump" onClick={latest}>
          <ArrowDown size={14} /> Jump to latest
        </button>
      )}
    </div>
  );
}
