export type Theme = 'light' | 'dark';

const storageKey = 'symbiknow.theme';

export function preferredTheme(): Theme {
  try {
    const saved = window.localStorage.getItem(storageKey);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    console.warn('Saved theme preferences cannot be read; using the light theme.');
  }
  return 'light';
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  try {
    window.localStorage.setItem(storageKey, theme);
  } catch {
    console.warn('Theme preferences cannot be saved in this browser.');
  }
}
