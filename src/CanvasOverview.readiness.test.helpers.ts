import { act } from '@testing-library/react';
import { vi } from 'vitest';

export function holdNativeNodeMeasurements() {
  const Observer = ResizeObserver;
  const pending: (() => void)[] = [];
  let held = true;
  // Node geometry may arrive after an already-visible toolbar is activated.
  // Container geometry and the installed ReactFlow renderer remain unchanged.
  vi.stubGlobal('ResizeObserver', class extends Observer {
    constructor(callback: ResizeObserverCallback) {
      super((entries, observer) => {
        const report = () => { if (entries.some(entry => entry.target.isConnected)) callback(entries, observer); };
        if (held && entries.some(entry => entry.target.classList.contains('react-flow__node'))) pending.push(report);
        else report();
      });
    }
  });
  return () => act(() => { held = false; for (const report of pending.splice(0)) report(); });
}

export function nativeCameraClock() {
  const epoch = Date.now();
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame'] });
  vi.spyOn(performance, 'now').mockImplementation(() => Date.now() - epoch);
}
export async function cameraFrames(milliseconds: number) {
  for (let elapsed = 0; elapsed < milliseconds; elapsed += 16) {
    await act(async () => { await vi.advanceTimersByTimeAsync(Math.min(16, milliseconds - elapsed)); });
  }
}
