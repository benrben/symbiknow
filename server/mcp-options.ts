export type McpPermissions = {
  access?: 'read' | 'propose' | 'write';
  allowedCanvasIds?: string[];
  tools?: string[];
  canApprove?: boolean;
  canConfigure?: boolean;
};

export type ProjectMcpOptions = McpPermissions & {
  /** The transport may materialize files only in the agent's own environment. */
  localFiles?: boolean;
  headers?: Record<string, string>;
  actorSuffix?: string;
  /** Stable trusted caller identity, independent of its display name. */
  callerId?: string;
  /** CLI hosts resolve local and bearer authority from the authenticated API. */
  authoritativeApi?: boolean;
  /** Re-read grants at discovery and execution. null means the caller was revoked. */
  resolvePermissions?: () => Promise<McpPermissions | null> | McpPermissions | null;
  /** All transports publish the same execution event. */
  onToolCall?: (event: { tool: string; args: unknown; startedAt: string; endedAt: string;
    outcome: 'success' | 'error' | 'denied'; result?: unknown }) => Promise<void> | void;
};
