// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyTheme, preferredTheme } from './theme';

beforeEach(() => {
  window.localStorage.removeItem('symbiknow.theme');
  delete document.documentElement.dataset.theme;
  document.documentElement.style.colorScheme = '';
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('theme preference', () => {
  it('uses a saved choice before the system preference', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
    expect(preferredTheme()).toBe('dark');
    window.localStorage.setItem('symbiknow.theme', 'light');
    expect(preferredTheme()).toBe('light');
    window.localStorage.setItem('symbiknow.theme', 'dark');
    expect(preferredTheme()).toBe('dark');
  });

  it('applies and stores a selected theme', () => {
    applyTheme('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');
    expect(window.localStorage.getItem('symbiknow.theme')).toBe('dark');
  });

  it('still applies the theme when browser storage is unavailable', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Storage blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage blocked'); });
    expect(preferredTheme()).toBe('dark');
    expect(() => applyTheme('dark')).not.toThrow();
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});
