const keyStore = 'symbiknow.investigation-keys.v1';
export function errorText(reason: unknown): string { return reason instanceof Error ? reason.message : 'Request failed. Try again.'; }

export function savedKeys(): Record<string, string> {
  const raw = window.localStorage.getItem(keyStore);
  if (!raw) return {};
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Private access keys in this browser are invalid.');
  return Object.fromEntries(Object.entries(value).filter(validStoredKey));
}

export function storeKey(id: string, key?: string): void {
  const keys = savedKeys();
  if (key) keys[id] = key;
  else delete keys[id];
  window.localStorage.setItem(keyStore, JSON.stringify(keys));
}


function validStoredKey([id, key]: [string, unknown]): boolean { return /^[a-z0-9-]{1,64}$/.test(id) && typeof key === 'string'; }
