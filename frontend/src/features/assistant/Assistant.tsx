import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowUp,
  FileText,
  FolderOpen,
  Maximize2,
  Minimize2,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import { api, assistantSocket } from "../../shared/api/client";
import type {
  AgentProvider,
  AgentSession,
} from "../../shared/api/contracts.generated";
import { emptyChat, reduceEvent } from "./core/state";
import { connectStream, type Stream } from "./core/stream";
import { ApprovalCard, DefaultCard, record, title } from "./core/cards";
import { ContextSummary } from "./ContextSummary";
import {
  defaultContextPolicy,
  filterCommandResult,
  filterContext,
  type ContextPolicy,
} from "./context";
import { Thread } from "./core/Thread";
import { ModelPicker, rememberModel } from "./ModelPicker";
import { toolLabels, toolRegistry } from "./toolRegistry";
import type { OpenDocument } from "./cards/ToolCards";
import { TransferReceipt } from "./cards/ToolCards";
import "./assistant.css";
export type BrowserCommand = (
  name: string,
  args: Record<string, unknown>,
  manual?: boolean,
  signal?: AbortSignal,
) => Promise<Record<string, unknown>>;

function closeUnusedSession(session: AgentSession) {
  // Let the creation request finish so its returned session can be explicitly
  // closed; aborting the POST could leave an unclaimed CLI running on the server.
  const stream = assistantSocket(session);
  const timeout = window.setTimeout(() => stream.close(), 10000);
  stream.onopen = () => {
    stream.send(JSON.stringify({ type: "close" }));
    stream.close();
  };
  stream.onclose = () => window.clearTimeout(timeout);
  stream.onerror = () => stream.close();
}

const widthKey = "symbiknow.assistant.width";
const minWidth = 320, maxWidth = 560, defaultWidth = 420;

export default function Assistant({
  context: viewContext,
  command,
  changed,
  launcher,
  visible,
  setVisible,
}: {
  context: Record<string, unknown>;
  command: BrowserCommand;
  changed: () => void;
  launcher: HTMLElement | null;
  visible: boolean;
  setVisible: (visible: boolean) => void;
}) {
  const [contextPolicy, setContextPolicy] = useState({
    ...defaultContextPolicy,
  });
  const contextKey = JSON.stringify(filterContext(viewContext, contextPolicy));
  const context = useMemo<Record<string, unknown>>(
    () => JSON.parse(contextKey),
    [contextKey],
  );
  const [providers, setProviders] = useState<AgentProvider[]>([]);
  const [session, setSession] = useState<AgentSession>(),
    [state, setState] = useState(emptyChat);
  const [status, setStatus] = useState(""),
    [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false),
    [draft, setDraft] = useState("");
  const [stopping, setStopping] = useState(false),
    [submitted, setSubmitted] = useState(false);
  const [expanded, setExpanded] = useState(() => {
    try {
      return localStorage.getItem("symbiknow.assistant.expanded") === "1";
    } catch {
      return false;
    }
  });
  const [width, setWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(widthKey));
      return saved >= minWidth && saved <= maxWidth ? saved : defaultWidth;
    } catch {
      return defaultWidth;
    }
  });
  // The chat is docked: it starts below the top bar and the page shrinks beside it.
  useEffect(() => {
    if (!visible) return;
    const root = document.documentElement;
    const place = () => {
      const content = document.querySelector(".workspace .content");
      root.style.setProperty("--assistant-top", `${Math.max(0, content?.getBoundingClientRect().top ?? 68)}px`);
    };
    root.style.setProperty("--assistant-w", `${width}px`);
    if (expanded) root.style.removeProperty("--assistant-dock");
    else root.style.setProperty("--assistant-dock", `${width}px`);
    place();
    const observer = new ResizeObserver(place);
    for (const element of document.querySelectorAll(".workspace .content, .topbar")) observer.observe(element);
    window.addEventListener("resize", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      for (const name of ["--assistant-top", "--assistant-w", "--assistant-dock"]) root.style.removeProperty(name);
    };
  }, [visible, width, expanded]);
  const rememberWidth = (value: number) => {
    try {
      localStorage.setItem(widthKey, String(value));
    } catch {
      /* Preference storage may be disabled. */
    }
  };
  const resize = (value: number) => setWidth(Math.min(maxWidth, Math.max(minWidth, Math.round(value))));
  const [providerLoading, setProviderLoading] = useState(false);
  const [providerError, setProviderError] = useState("");
  const [providerRefresh, setProviderRefresh] = useState(0);
  const [pendingDecisions, setPendingDecisions] = useState<string[]>([]);
  const connectionGeneration = useRef(0);
  useEffect(
    () => () => {
      connectionGeneration.current++;
    },
    [],
  );
  const socket = useRef<Stream | undefined>(undefined),
    latest = useRef({ context, command, changed, contextPolicy });
  latest.current = { context, command, changed, contextPolicy };
  const stateRef = useRef(state);
  stateRef.current = state;
  const composer = useRef<HTMLTextAreaElement>(null);
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    if (visible) (session ? composer.current : panel.current)?.focus();
  }, [visible, session]);
  const uiCommands = useRef(new Set<AbortController>());
  const cancelUI = () => {
    for (const controller of uiCommands.current) controller.abort();
    uiCommands.current.clear();
  };
  const handled = useRef(new Set<string>()),
    decisions = useRef(new Set<string>());
  const running =
    submitted || state.runs.some((run) => run.status === "running");
  const send = (message: unknown) => socket.current?.send(message) || false;
  const updateContextPolicy = (next: ContextPolicy) => {
    // Apply exclusions immediately, including a command resolving in this event turn.
    latest.current.contextPolicy = next;
    latest.current.context = filterContext(viewContext, next);
    setContextPolicy(next);
    if (connected) send({ type: "context_update", ...latest.current.context });
  };
  useEffect(() => {
    if (!visible || session) return;
    const abort = new AbortController();
    setProviderLoading(true);
    setProviderError("");
    api<{ agents: AgentProvider[] }>("agents", undefined, abort.signal)
      .then((result) => {
        if (!abort.signal.aborted) setProviders(result.agents);
      })
      .catch((error) => {
        if (!abort.signal.aborted) setProviderError(String(error));
      })
      .finally(() => {
        if (!abort.signal.aborted) setProviderLoading(false);
      });
    return () => abort.abort();
  }, [visible, session, providerRefresh]);
  useEffect(() => {
    if (!session) return;
    const writeCalls = new Set<string>();
    const stream = connectStream({
      session: session.session_id,
      open: () => assistantSocket(session),
      sequence: () => stateRef.current.seq,
      context: () => latest.current.context,
      events: (events) => {
        const next = events.reduce(reduceEvent, stateRef.current);
        stateRef.current = next;
        setState(next);
      },
      connection: (connected, message) => {
        setConnected(connected);
        setStatus(message);
        if (!connected) {
          setSubmitted(false);
          setStopping(false);
          // The socket may have dropped before an approval reached the server.
          // Replayed receipts remain authoritative and the server deduplicates decisions.
          decisions.current.clear();
          setPendingDecisions([]);
          cancelUI();
        }
      },
      event: (value, reply) => {
        if (value.type === "run_started" || value.type === "request_error")
          setSubmitted(false);
        if (value.type === "run_finished" || value.type === "run_error") {
          setStopping(false);
          setSubmitted(false);
        }
        if (
          value.type === "tool_call_started" &&
          value.kind === "approval" &&
          value.id
        )
          writeCalls.add(value.id);
        if (
          value.seq > stateRef.current.seq &&
          (value.type === "tool_call_result" ||
            (value.type === "tool_call_error" && value.result !== undefined)) &&
          value.id &&
          writeCalls.has(value.id)
        )
          latest.current.changed();
        const expiry = value.expires_at || 0;
        if (
          value.type === "ui_command" &&
          value.id &&
          !handled.current.has(value.id) &&
          expiry > Date.now()
        ) {
          handled.current.add(value.id);
          const controller = new AbortController();
          uiCommands.current.add(controller);
          const timer = window.setTimeout(
            () => controller.abort(),
            Math.max(0, expiry - Date.now() - 50),
          );
          void latest.current
            .command(
              value.name || "",
              {
                ...value.args,
                _agent: session!.provider,
                _expires_at: expiry,
              },
              false,
              controller.signal,
            )
            .then((rawResult) => {
              const result = filterCommandResult(
                rawResult,
                latest.current.contextPolicy,
              );
              if (result.state)
                reply({ type: "context_update", ...record(result.state) });
              reply({
                type: "ui_result",
                id: value.id,
                ok: result.ok !== false,
                result,
              });
              if (
                result.ok !== false &&
                window.innerWidth < 1150 &&
                result.reveal === true
              )
                setVisible(false);
            })
            .catch(() => {
              reply({
                type: "ui_result",
                id: value.id,
                ok: false,
                result: {
                  reason: controller.signal.aborted
                    ? "cancelled"
                    : "view_unavailable",
                },
              });
            })
            .finally(() => {
              window.clearTimeout(timer);
              uiCommands.current.delete(controller);
            });
        }
      },
    });
    socket.current = stream;
    return () => {
      cancelUI();
      stream.close();
      socket.current = undefined;
      setConnected(false);
    };
  }, [session]);
  useEffect(() => {
    if (connected) send({ type: "context_update", ...context });
  }, [context, connected]);
  async function choose(provider: string, model: string, effort: string) {
    const generation = ++connectionGeneration.current;
    setConnecting(true);
    setStatus("");
    try {
      const next = await api<AgentSession>("agent-sessions", {
        provider,
        model,
        effort,
      });
      if (generation !== connectionGeneration.current) {
        closeUnusedSession(next);
        return;
      }
      rememberModel(provider, model, effort);
      setState(emptyChat);
      stateRef.current = emptyChat;
      handled.current.clear();
      decisions.current.clear();
      setPendingDecisions([]);
      setSession(next);
    } catch (error) {
      if (generation === connectionGeneration.current) setStatus(String(error));
    } finally {
      if (generation === connectionGeneration.current) setConnecting(false);
    }
  }
  function reset() {
    connectionGeneration.current++;
    setConnecting(false);
    send({ type: "close" });
    setSession(undefined);
    setState(emptyChat);
    stateRef.current = emptyChat;
    setDraft("");
    setSubmitted(false);
    setStopping(false);
    setStatus("");
  }
  function close() {
    reset();
    setVisible(false);
    launcher?.focus();
  }
  function submit() {
    if (
      connected &&
      !running &&
      draft.trim() &&
      send({ type: "send", message: draft, context: latest.current.context })
    ) {
      setDraft("");
      setSubmitted(true);
    }
  }
  const open: OpenDocument = (doc, evidence_id) => {
    void command(
      evidence_id ? "highlight_evidence" : "open_document",
      {
        ...doc,
        ...(evidence_id && { evidence_id }),
        _agent: session?.provider || "agent",
      },
      true,
    )
      .then((result) => {
        if (result.ok === false)
          setStatus(String(result.reason || "View unavailable"));
      })
      .catch(() => setStatus("Could not open this item. Try again."));
  };
  function decide(id: string, approve: boolean) {
    if (decisions.current.has(id)) return;
    if (send({ type: "approval", id, approve })) {
      decisions.current.add(id);
      setPendingDecisions([...decisions.current]);
    }
  }
  return (
    <>
      {visible && (
        <aside
          ref={panel}
          tabIndex={-1}
          className={`assistant-panel${expanded ? " assistant-expanded" : ""}`}
          id="assistant-panel"
          aria-label="Agent chat"
          onKeyDown={(event) => {
            if (event.key === "Escape" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.stopPropagation();
              close();
            }
          }}
        >
          <header className="assistant-header">
            <span className="assistant-header-icon">
              <Sparkles size={18} />
            </span>
            <div className="assistant-heading">
              <strong>{session?.provider || "Ask an agent"}</strong>
              <small title={session?.model}>
                {session
                  ? `${session.model_name || "CLI default"}${session.effort ? ` · ${session.effort} effort` : ""}`
                  : "Your local CLI · Your account"}
              </small>
            </div>
            {session && (
              <button
                type="button"
                aria-label="New chat and choose model"
                title="New chat · Choose model"
                onClick={reset}
                disabled={
                  running ||
                  state.runs.some((run) =>
                    run.tools.some(
                      (tool) => tool.state === "awaiting_approval",
                    ),
                  )
                }
              >
                <Plus size={18} />
              </button>
            )}
            <button
              type="button"
              aria-label={expanded ? "Shrink chat" : "Expand chat"}
              onClick={() => {
                const next = !expanded;
                setExpanded(next);
                try {
                  localStorage.setItem("symbiknow.assistant.expanded", next ? "1" : "0");
                } catch {
                  /* Preference storage may be disabled. */
                }
              }}
            >
              {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            </button>
            <button type="button" aria-label="Close agent chat" onClick={close}>
              <X size={18} />
            </button>
          </header>
          <ContextSummary
            context={context}
            policy={contextPolicy}
            update={updateContextPolicy}
            connected={connected}
          />
          {!session ? (
            <ModelPicker
              providers={providers}
              providerLoading={providerLoading}
              providerError={providerError}
              retryProviders={() => setProviderRefresh((value) => value + 1)}
              connecting={connecting}
              choose={(provider, model, effort) =>
                void choose(provider, model, effort)
              }
            />
          ) : (
            <>
              <div className="assistant-session-strip">
                <span
                  className={
                    connected ? "assistant-online-dot" : "assistant-offline-dot"
                  }
                />
                {connected ? "Connected" : "Reconnecting…"}
                <span>
                  <ShieldCheck size={14} aria-hidden="true" /> Changes require approval
                </span>
              </div>
              <Thread
                runs={state.runs}
                provider={session.provider}
                modelName={session.model_name || "CLI default"}
                retry={(message) => {
                  if (
                    connected &&
                    !running &&
                    send({
                      type: "send",
                      message,
                      context: latest.current.context,
                    })
                  )
                    setSubmitted(true);
                }}
                retryDisabled={!connected || running}
                toolLabel={(name) => toolLabels[name] || title(name)}
                renderTool={(raw) => {
                  const tool = { ...raw, label: toolLabels[raw.name] };
                  const Card = toolRegistry[tool.name]?.card;
                  return tool.preview ? (
                    <ApprovalCard
                      tool={tool}
                      decide={decide}
                      disabled={
                        !connected || pendingDecisions.includes(tool.id)
                      }
                    >
                      {["done", "error"].includes(tool.state) &&
                        tool.result !== undefined &&
                        ["upload", "upload_folder"].includes(tool.name) && (
                          <TransferReceipt result={tool.result} />
                        )}
                    </ApprovalCard>
                  ) : Card ? (
                    <Card tool={tool} open={open} />
                  ) : (
                    <DefaultCard tool={tool} />
                  );
                }}
              >
                {!state.runs.length && (
                  <div className="assistant-welcome">
                    <span className="assistant-emblem">
                      <Sparkles size={24} />
                    </span>
                    <h2>What would you like to explore?</h2>
                    <p>
                      Your agent can search your library, open evidence, and
                      propose changes. Follow each step here.
                    </p>
                    <div className="assistant-suggestions">
                      {[
                        {
                          icon: Search,
                          title: "Find an answer",
                          prompt: "Help me find information about ",
                        },
                        {
                          icon: FileText,
                          title: "Explore this view",
                          prompt:
                            "What documents are in my current view? Help me understand them.",
                        },
                        {
                          icon: FolderOpen,
                          title: "Organize my library",
                          prompt:
                            "Review the organization of my library and suggest improvements. Ask before making changes.",
                        },
                      ].map((item) => (
                        <button
                          key={item.title}
                          type="button"
                          onClick={() => {
                            setDraft(item.prompt);
                            composer.current?.focus();
                          }}
                        >
                          <item.icon size={16} />
                          <span>{item.title}</span>
                          <ArrowRight size={14} aria-hidden="true" />
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </Thread>
              {submitted && (
                <div className="assistant-submitting" role="status">
                  Sending your message…
                </div>
              )}
              <form
                className="assistant-composer"
                onSubmit={(event) => {
                  event.preventDefault();
                  submit();
                }}
              >
                <div className="assistant-input-box">
                  <label htmlFor="assistant-message">
                    Message {session.provider}
                  </label>
                  <textarea
                    id="assistant-message"
                    ref={composer}
                    value={draft}
                    maxLength={32000}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (
                        event.key === "Enter" &&
                        !event.shiftKey &&
                        !event.nativeEvent.isComposing
                      ) {
                        event.preventDefault();
                        submit();
                      }
                    }}
                    rows={2}
                    placeholder="Ask about your library…"
                  />
                  <div className="assistant-compose-actions">
                    <small>Enter to send · Shift + Enter for a new line</small>
                    {running && (
                      <button
                        type="button"
                        disabled={stopping || !connected}
                        onClick={() => {
                          if (send({ type: "cancel" })) {
                            cancelUI();
                            setStopping(true);
                          }
                        }}
                      >
                        <Square size={12} fill="currentColor" />
                        {stopping ? "Stopping…" : "Stop"}
                      </button>
                    )}
                    <button
                      type="submit"
                      className="assistant-primary"
                      disabled={!connected || running || !draft.trim()}
                    >
                      <ArrowUp size={16} /> Send
                    </button>
                  </div>
                </div>
              </form>
            </>
          )}
          {(status || state.error) && (
            <div className="assistant-status" role="status">
              {status || state.error}
              {session && !connected && (
                <button type="button" onClick={reset}>
                  New chat
                </button>
              )}
            </div>
          )}
          {!expanded && (
            <div
              className="assistant-resizer"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize chat"
              aria-valuemin={minWidth}
              aria-valuemax={maxWidth}
              aria-valuenow={width}
              tabIndex={0}
              onPointerDown={(event) => {
                event.preventDefault();
                const handle = event.currentTarget;
                handle.setPointerCapture(event.pointerId);
                const move = (e: PointerEvent) => resize(window.innerWidth - e.clientX);
                const up = (e: PointerEvent) => {
                  handle.removeEventListener("pointermove", move);
                  handle.removeEventListener("pointerup", up);
                  rememberWidth(Math.min(maxWidth, Math.max(minWidth, Math.round(window.innerWidth - e.clientX))));
                };
                handle.addEventListener("pointermove", move);
                handle.addEventListener("pointerup", up);
              }}
              onKeyDown={(event) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                event.preventDefault();
                event.stopPropagation();
                const next = Math.min(maxWidth, Math.max(minWidth, width + (event.key === "ArrowLeft" ? 20 : -20)));
                setWidth(next);
                rememberWidth(next);
              }}
            />
          )}
        </aside>
      )}
    </>
  );
}
