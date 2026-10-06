type Registration = { getActiveCanvasId: () => string; onChanged: () => void };
// A reused widget follows the newest live consumer; disposal restores the preceding owner.
let registrations: Registration[] = [];

export function activeCanvas(): string { return registrations.at(-1)?.getActiveCanvasId() ?? ''; }
export function changed(): void { registrations.at(-1)?.onChanged(); }

export function registerContext(getActiveCanvasId: () => string, onChanged: () => void): () => void {
  const registration = { getActiveCanvasId, onChanged };
  registrations.push(registration);
  return () => { registrations = registrations.filter(current => current !== registration); };
}
