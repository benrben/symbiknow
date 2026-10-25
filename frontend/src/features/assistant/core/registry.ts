/** Cards and handlers are injected by the host application. */
export type ToolRegistry<Card> = Record<
  string,
  {
    kind: "server" | "browser" | "approval";
    card?: Card;
  }
>;
