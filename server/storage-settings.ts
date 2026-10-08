import type { ChatSettings } from '../shared/types.js';
import { safeEqual, hashToken } from './auth.js';
import { defaultPrivateSettings, newMcpToken, providerKey, publicSettings, updatedSettings, type PrivateSettings } from './settings.js';
import { appendMcpActivity, readMcpActivity, type McpActivityInput } from './mcp-activity.js';
import { ApiError } from './errors.js';
import { atomicJson } from './storage-files.js';
import { validId } from './storage-shapes.js';
import type { StorageContext } from './storage-context.js';

type FixedTokenIdentity = { id: string; name: string; access: 'write' };

function fixedTokenIdentity(token: string): FixedTokenIdentity | null {
  const tokens = [
    ['env-token-primary', process.env.SYMBIKNOW_MCP_TOKEN, 'env token'],
    ['env-token-legacy', process.env.ALLTEAM_MCP_TOKEN, 'env token'],
    ['access-token-primary', process.env.SYMBIKNOW_ACCESS_TOKEN, 'access token'],
    ['access-token-legacy', process.env.ALLTEAM_ACCESS_TOKEN, 'access token'],
  ] as const;
  for (const [id, fixed, name] of tokens) {
    if (fixed && safeEqual(token, fixed)) return { id, name, access: 'write' };
  }
  return null;
}

function storedTokenIdentity(stored: NonNullable<PrivateSettings['mcpTokens']>[number]) {
  return { id: stored.id, name: stored.name, access: stored.access ?? 'write',
    canApprove: Boolean(stored.canApprove), canConfigure: Boolean(stored.canConfigure),
    ...(stored.allowedCanvasIds ? { allowedCanvasIds: stored.allowedCanvasIds } : {}),
    ...(stored.tools ? { tools: stored.tools } : {}) };
}

export class StorageSettings {
  constructor(private readonly context: StorageContext) {}

  private async privateSettings(): Promise<PrivateSettings> {
    try { return await this.context.files.readJson<PrivateSettings>(this.context.files.settingsFile()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return { ...defaultPrivateSettings };
    }
  }

  /** Full settings including secrets. Only server code may call this. */
  async secretSettings(): Promise<PrivateSettings> { return this.privateSettings(); }

  async getSettings(): Promise<ChatSettings> {
    return publicSettings(await this.privateSettings());
  }

  async getApiKey(): Promise<string> {
    return providerKey(await this.privateSettings());
  }

  async updateSettings(input: Record<string, unknown>): Promise<ChatSettings> {
    return this.context.files.serialize(async () => {
      const settings = updatedSettings(await this.privateSettings(), input);
      await atomicJson(this.context.files.settingsFile(), settings, 0o600);
      return publicSettings(settings);
    });
  }

  async createMcpToken(name: unknown, access: unknown = 'read', scope?: { allowedCanvasIds?: unknown; tools?: unknown; canApprove?: unknown; canConfigure?: unknown }): Promise<{ token: string; settings: ChatSettings }> {
    return this.context.files.serialize(async () => {
      const settings = await this.privateSettings();
      if ((settings.mcpTokens ?? []).length >= 20) throw new ApiError(400, 'Revoke an old token before creating another (limit 20)');
      const { token, stored } = newMcpToken(name, access, scope);
      if (stored.allowedCanvasIds) {
        const known = new Set((await this.context.listWorkspaces()).flatMap(workspace => workspace.canvases.map(canvas => canvas.id)));
        if (stored.allowedCanvasIds.some(id => !known.has(id))) throw new ApiError(400, 'allowedCanvasIds must name existing canvases');
      }
      const next = { ...settings, mcpTokens: [...(settings.mcpTokens ?? []), stored] };
      await atomicJson(this.context.files.settingsFile(), next, 0o600);
      return { token, settings: publicSettings(next) };
    });
  }

  async revokeMcpToken(id: string): Promise<ChatSettings> {
    return this.context.files.serialize(async () => {
      const settings = await this.privateSettings();
      const mcpTokens = settings.mcpTokens ?? [];
      if (!mcpTokens.some(token => token.id === id)) throw new ApiError(404, 'Token not found');
      const next = { ...settings, mcpTokens: mcpTokens.filter(token => token.id !== id) };
      await atomicJson(this.context.files.settingsFile(), next, 0o600);
      return publicSettings(next);
    });
  }

  async mcpActivity() { return readMcpActivity(this.context.files.mcpActivityFile()); }

  async mcpDocumentRevision(blockId: string): Promise<string | undefined> {
    if (!validId(blockId)) return undefined;
    try { return (await this.context.files.versionFile(blockId).status()).commits[0]?.id; }
    catch { return undefined; } // A document may have no Git history yet; activity still records the call.
  }

  async recordMcpActivity(input: McpActivityInput) {
    return this.context.files.serialize(() => appendMcpActivity(this.context.files.mcpActivityFile(), input));
  }

  /** Returns token identity and effective scope, updating last use for stored tokens. */
  async mcpTokenIdentity(token: string): Promise<{ id: string; name: string; access: 'read' | 'propose' | 'write';
    allowedCanvasIds?: string[]; tools?: string[]; canApprove?: boolean; canConfigure?: boolean } | null> {
    if (!token) return null;
    const fixed = fixedTokenIdentity(token);
    if (fixed) return fixed;
    const hash = hashToken(token);
    const settings = await this.privateSettings();
    const stored = (settings.mcpTokens ?? []).find(item => safeEqual(item.hash, hash));
    if (!stored) return null;
    this.touchStoredToken(stored.id, stored.lastUsedAt);
    return storedTokenIdentity(stored);
  }

  private touchStoredToken(id: string, lastUsedAt: string | undefined): void {
    const previousUse = Date.parse(lastUsedAt ?? '');
    const needsTouch = !Number.isFinite(previousUse) || Date.now() - previousUse > 60_000;
    if (!needsTouch) return;
    void this.context.files.serialize(async () => {
      const latest = await this.privateSettings();
      const mcpTokens = (latest.mcpTokens ?? []).map(item => item.id === id ? { ...item, lastUsedAt: new Date().toISOString() } : item);
      await atomicJson(this.context.files.settingsFile(), { ...latest, mcpTokens }, 0o600);
    }).catch(() => undefined); // Last-use metadata is advisory; authentication still succeeds if it cannot be persisted.
  }

  /** Kept for callers that only need the display name. */
  async verifyMcpToken(token: string): Promise<string | null> {
    return (await this.mcpTokenIdentity(token))?.name ?? null;
  }
}
