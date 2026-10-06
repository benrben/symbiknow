export type McpInfo = { origin: string; endpoint: string; publicUrlConfigured: boolean; accessProtected: boolean; activeSessions: number };
export type McpActivityEntry = { id: string; tokenId: string; tokenName: string; access: 'read' | 'propose' | 'write'; tool: string;
  allowedCanvasIds?: string[]; tools?: string[]; startedAt: string; endedAt: string; outcome: 'success' | 'error' | 'denied';
  error?: string; canvasIds: string[]; documentIds: string[]; revision?: string };
export type OpenActivityHistory = (canvasId: string, documentId: string, revision: string) => void;

