import type { Theme } from './theme';

export function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const shapes: Record<string, React.ReactNode> = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></>,
    layers: <><path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5"/></>,
    plus: <path d="M12 5v14M5 12h14"/>,
    search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
    settings: <><path d="M9.7 3h4.6l.6 2.3 2 1.2 2.3-.6 2.3 4-1.7 1.7v2.4l1.7 1.7-2.3 4-2.3-.6-2 1.2-.6 2.3H9.7l-.6-2.3-2-1.2-2.3.6-2.3-4 1.7-1.7v-2.4L2.5 9.9l2.3-4 2.3.6 2-1.2L9.7 3Z"/><circle cx="12" cy="12" r="3"/></>,
    upload: <><path d="M12 16V3m-4 4 4-4 4 4"/><path d="M4 16v4h16v-4"/></>,
    chevron: <path d="m9 18 6-6-6-6"/>,
    spark: <><path d="m12 2 1.9 6.1L20 10l-6.1 1.9L12 18l-1.9-6.1L4 10l6.1-1.9L12 2ZM19 17l.7 1.3L21 19l-1.3.7L19 21l-.7-1.3L17 19l1.3-.7L19 17Z"/></>,
    send: <><path d="m22 2-7 20-4-9-9-4L22 2Z"/><path d="M22 2 11 13"/></>,
    close: <path d="M18 6 6 18M6 6l12 12"/>,
    file: <><path d="M5 2h9l5 5v15H5V2Z"/><path d="M14 2v6h5M8 12h8M8 16h8"/></>,
    arrow: <path d="M5 12h14m-6-6 6 6-6 6"/>,
    trash: <><path d="M4 7h16M9 7V4h6v3m3 0-1 14H7L6 7M10 11v6m4-6v6"/></>,
    moon: <path d="M20.4 15.3A8.6 8.6 0 0 1 8.7 3.6 8.7 8.7 0 1 0 20.4 15.3Z"/>,
    sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{shapes[name]}</svg>;
}

export function BrandMark() {
  return <div className="brand-mark"><img className="brand-symbol" src="/symbiknow-favicon.svg" alt=""/></div>;
}

export function ThemeToggle({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  const next = theme === 'dark' ? 'light' : 'dark';
  return <button type="button" className="toolbar-button theme-toggle" aria-label={`Switch to ${next} mode`} title={`Switch to ${next} mode`} onClick={onToggle}>
    <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={18}/><span>{next === 'dark' ? 'Dark mode' : 'Light mode'}</span>
  </button>;
}
