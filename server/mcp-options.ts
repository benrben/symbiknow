export type ProjectMcpOptions = {
  /** stdio agents run on the agent's machine, so they may read and write local files. Remote HTTP agents may not. */
  localFiles?: boolean;
  /** During migration, register legacy Jev diagnostics and proposal tools in discovery. */
  legacyBrainTools?: boolean;
  /** Extra API headers, such as authorization. */
  headers?: Record<string, string>;
  /** Suffix added to the connecting client's name, such as the MCP token name. */
  actorSuffix?: string;
  /** Remote token capability. Existing stdio clients retain full access. */
  access?: 'read' | 'propose' | 'write';
  /** Limits a remote token to these canvases. Omitted means every canvas. */
  allowedCanvasIds?: string[];
  /** Limits a remote token to these named MCP tools. Omitted means its access-level default. */
  tools?: string[];
  /** Observes the actual remote tool handler without storing its arguments or result. */
  onToolCall?: (event: { tool: string; args: unknown; startedAt: string; endedAt: string;
    outcome: 'success' | 'error' | 'denied'; result?: unknown }) => Promise<void> | void;
};
