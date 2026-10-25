import { batchEvents, type Event } from "./state";

export type Stream = { send: (message: unknown) => boolean; close: () => void };
/** Product code supplies the socket factory; this module owns only the protocol. */
export function connectStream(options: {
  session: string;
  open: () => WebSocket;
  sequence: () => number;
  context: () => Record<string, unknown>;
  events: (events: Event[]) => void;
  event: (event: Event, reply: (message: unknown) => boolean) => void;
  connection: (connected: boolean, message: string) => void;
}): Stream {
  let disposed = false,
    socket: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined,
    attempts = 0;
  const batch = batchEvents(
    options.events,
    requestAnimationFrame,
    cancelAnimationFrame,
  );
  function send(message: unknown) {
    if (socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }
  function connect() {
    if (disposed) return;
    const ws = options.open();
    socket = ws;
    const reply = (message: unknown) => {
      if (disposed || ws.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify(message));
      return true;
    };
    ws.onopen = () => {
      if (disposed) {
        ws.close();
        return;
      }
      options.connection(true, "");
      attempts = 0;
      reply({ type: "replay", after: options.sequence() });
      reply({ type: "context_update", ...options.context() });
    };
    ws.onmessage = (message) => {
      let event: Event;
      try {
        event = JSON.parse(message.data);
      } catch {
        ws.close();
        return;
      }
      if (
        !event ||
        event.session_id !== options.session ||
        !Number.isInteger(event.seq) ||
        typeof event.type !== "string"
      )
        return;
      options.event(event, reply);
      batch.push(event);
    };
    ws.onclose = (event) => {
      if (disposed) return;
      if (event.code === 1008 || ++attempts > 12) {
        options.connection(
          false,
          "Session ended. Start a new chat to reconnect.",
        );
        return;
      }
      options.connection(false, "Reconnecting…");
      retry = setTimeout(connect, 1200);
    };
  }
  connect();
  return {
    send,
    close() {
      disposed = true;
      clearTimeout(retry);
      batch.dispose();
      send({ type: "close" });
      socket?.close();
    },
  };
}
