export type Theme = 'light' | 'dark';

const storageKey = 'symbiknow.theme';

export function preferredTheme(): Theme {
  try {
    const saved = window.localStorage.getItem(storageKey);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // The system preference still works when storage is unavailable.
  }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  try {
    window.localStorage.setItem(storageKey, theme);
  } catch {
    // Theme selection still applies for this page when storage is unavailable.
  }
}
