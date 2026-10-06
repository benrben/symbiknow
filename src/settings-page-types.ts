export type SettingsPayload = Record<string, unknown>;
export type SectionId = 'models' | 'agents' | 'secrets' | 'servers' | 'connect' | 'activity' | 'plugins' | 'jev';
export type ModelOption = { id: string; name: string; tools?: boolean; context?: number };
export type TestedTool = { name: string; description?: string; capabilities?: string[] };
