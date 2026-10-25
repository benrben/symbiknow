// Standalone bridge types: deliberately independent of application wire imports.
export type Event = {
  type: string;
  session_id: string;
  run_id: string;
  seq: number;
  timestamp?: number;
  automatic?: boolean;
  model?: string;
  id?: string;
  name?: string;
  kind?: string;
  text?: string;
  message?: string;
  args?: Record<string, unknown>;
  preview?: Record<string, unknown>;
  result?: unknown;
  status?: string;
  expires_at?: number;
};
export type ToolState = {
  id: string;
  label?: string;
  name: string;
  kind: string;
  state: string;
  args?: Record<string, unknown>;
  preview?: Record<string, unknown>;
  result?: unknown;
  message?: string;
  startedAt?: number;
  finishedAt?: number;
};
export type Part =
  | { type: "text"; id: string; text: string }
  | { type: "tools"; id: string; ids: string[] };
export type Run = {
  id: string;
  message: string;
  text: string;
  status: string;
  tools: ToolState[];
  parts: Part[];
  automatic: boolean;
  model: string;
  startedAt?: number;
  finishedAt?: number;
};
export type ChatState = {
  session: string;
  seq: number;
  runs: Run[];
  error: string;
};
export const emptyChat: ChatState = {
  session: "",
  seq: 0,
  runs: [],
  error: "",
};
const statuses: Record<string, string> = {
  tool_call_started: "preparing",
  tool_call_args: "running",
  tool_call_awaiting_approval: "awaiting_approval",
  tool_call_approved: "approved",
  tool_call_denied: "denied",
  tool_call_result: "done",
  tool_call_error: "error",
};
export function reduceEvent(state: ChatState, event: Event): ChatState {
  if (
    event.seq <= state.seq ||
    (state.session && event.session_id !== state.session)
  )
    return state;
  if (event.seq !== state.seq + 1)
    return {
      ...state,
      error: "Chat history has a gap. Reconnect to recover it.",
    };
  const next = {
    ...state,
    seq: event.seq,
    session: event.session_id,
    runs: [...state.runs],
  };
  if (event.type === "request_error")
    return { ...next, error: event.message || "Request failed" };
  if (event.type === "run_started") {
    next.error = "";
    next.runs.push({
      id: event.run_id,
      message: event.message || "",
      text: "",
      status: "running",
      tools: [],
      parts: [],
      automatic: event.automatic === true,
      model: event.model || "",
      startedAt: event.timestamp,
    });
    return next;
  }
  const index = next.runs.findIndex((run) => run.id === event.run_id);
  if (index < 0) return next;
  const run = {
    ...next.runs[index],
    tools: [...next.runs[index].tools],
    parts: [...next.runs[index].parts],
  };
  next.runs[index] = run;
  if (event.type === "text_delta" && event.text) {
    run.text += event.text;
    const last = run.parts.at(-1);
    if (last?.type === "text")
      run.parts[run.parts.length - 1] = {
        ...last,
        text: last.text + event.text,
      };
    else
      run.parts.push({ type: "text", id: String(event.seq), text: event.text });
  }
  if (event.type === "run_metadata" && event.model) run.model = event.model;
  if (event.type === "run_finished") {
    run.status = event.status || "completed";
    run.finishedAt = event.timestamp;
  }
  if (event.type === "run_error") {
    run.status = "error";
    run.finishedAt = event.timestamp;
    next.error = event.message || "Agent disconnected";
  }
  if (statuses[event.type] && event.id) {
    const position = run.tools.findIndex((tool) => tool.id === event.id);
    const prior =
      position >= 0
        ? run.tools[position]
        : {
            id: event.id,
            name: event.name || "Tool",
            kind: event.kind || "server",
            state: "preparing",
            startedAt: event.timestamp,
          };
    const tool = {
      ...prior,
      state: statuses[event.type],
      ...(event.args !== undefined && { args: event.args }),
      ...(event.preview !== undefined && { preview: event.preview }),
      ...(event.result !== undefined && { result: event.result }),
      ...(event.message !== undefined && { message: event.message }),
      ...(["tool_call_result", "tool_call_error", "tool_call_denied"].includes(
        event.type,
      ) && { finishedAt: event.timestamp }),
    };
    if (position < 0) {
      run.tools.push(tool);
      const last = run.parts.at(-1);
      if (last?.type === "tools")
        run.parts[run.parts.length - 1] = {
          ...last,
          ids: [...last.ids, tool.id],
        };
      else run.parts.push({ type: "tools", id: tool.id, ids: [tool.id] });
    } else run.tools[position] = tool;
  }
  return next;
}
export function batchEvents<T>(
  deliver: (items: T[]) => void,
  schedule: (work: () => void) => number,
  cancel: (id: number) => void,
) {
  let pending: T[] = [],
    frame: number | undefined;
  return {
    push(item: T) {
      pending.push(item);
      if (frame === undefined)
        frame = schedule(() => {
          frame = undefined;
          const items = pending;
          pending = [];
          deliver(items);
        });
    },
    dispose() {
      if (frame !== undefined) cancel(frame);
      frame = undefined;
      pending = [];
    },
  };
}
