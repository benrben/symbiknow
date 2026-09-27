/** Fired when the server asks for the workspace access token. */
export const authRequiredEvent = 'symbiknow:auth-required';

/** Browser edits are recorded under this name in each file's history. */
export const browserActor = 'Browser';

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...init,
      headers: {
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        'x-symbiknow-actor': browserActor,
        ...init.headers,
      },
    });
  } catch {
    throw new Error('Canvas server is unavailable. Check that it is running, then retry.');
  }

  if (!response.ok) {
    if (response.status === 401 && path !== '/session') window.dispatchEvent(new Event(authRequiredEvent));
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    if (payload?.error) throw new Error(payload.error);
    if ([502, 503, 504].includes(response.status)) throw new Error(`Canvas server is unavailable or restarting (${response.status}). Retry in a moment.`);
    throw new Error(`Request failed (${response.status})`);
  }

  return response.json() as Promise<T>;
}
