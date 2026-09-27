// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ResizableAssistant } from './ResizableAssistant';

const originalWidth = window.innerWidth;

beforeEach(() => { window.localStorage.clear(); });
afterEach(() => {
  cleanup();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth });
});

function showAt(viewport: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: viewport });
  render(<ResizableAssistant hidden={false}><p>Conversation</p></ResizableAssistant>);
  return screen.getByRole('separator', { name: 'Resize chat panel' });
}

describe('resizable assistant', () => {
  it('resizes by dragging and remembers the width when opened again', () => {
    const handle = showAt(1440);
    handle.setPointerCapture = () => {};
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 700 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 600 });
    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(window.localStorage.getItem('symbiknow.assistant.width')).toBe('600');
    expect(screen.getByRole('complementary', { name: 'Symbi assistant' }).getAttribute('style')).toContain('600px');
    cleanup();
    showAt(1440);
    expect(screen.getByRole('separator', { name: 'Resize chat panel' }).getAttribute('aria-valuenow')).toBe('600');
  });

  it('supports keyboard resizing and keeps the canvas visible', () => {
    const handle = showAt(700);
    expect(handle.getAttribute('aria-valuemax')).toBe('354');
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(handle.getAttribute('aria-valuenow')).toBe('354');
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(handle.getAttribute('aria-valuenow')).toBe('330');
    fireEvent.keyDown(handle, { key: 'Enter' });
    expect(handle.getAttribute('aria-valuenow')).toBe('330');
  });

  it('limits the panel at tablet and phone widths and stops after cancellation', () => {
    window.localStorage.setItem('allteam.assistant.width', '400');
    const handle = showAt(900);
    expect(handle.getAttribute('aria-valuemax')).toBe('395');
    handle.setPointerCapture = () => {};
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 0 });
    expect(window.localStorage.getItem('allteam.assistant.width')).toBe('400');
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 350 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 800 });
    expect(handle.getAttribute('aria-valuenow')).toBe('240');
    expect(window.localStorage.getItem('symbiknow.assistant.width')).toBe('240');
    fireEvent.pointerCancel(handle, { pointerId: 1 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 0 });
    expect(handle.getAttribute('aria-valuenow')).toBe('240');
    cleanup();
    showAt(390);
    expect(screen.getByRole('separator', { name: 'Resize chat panel' }).getAttribute('aria-valuemax')).toBe('324');
  });
});
