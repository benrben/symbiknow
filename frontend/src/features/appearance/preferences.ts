import { useSyncExternalStore } from "react";

export type Appearance = "dark" | "light" | "system";
const key = "symbiknow.appearance";
const media = window.matchMedia("(prefers-color-scheme: dark)");
const valid = (value: unknown): value is Appearance =>
  value === "dark" || value === "light" || value === "system";
function read(): Appearance {
  try {
    const value = localStorage.getItem(key);
    return valid(value) ? value : "dark";
  } catch {
    return "dark";
  }
}
let appearance = read();
const listeners = new Set<() => void>();
const resolved = () =>
  appearance === "system" ? (media.matches ? "dark" : "light") : appearance;
function publish() {
  document.documentElement.dataset.theme = resolved();
  document.documentElement.style.colorScheme = resolved();
  listeners.forEach((listener) => listener());
}
export function setAppearance(value: Appearance) {
  if (!valid(value)) return;
  appearance = value;
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Appearance still works when storage is unavailable. */
  }
  publish();
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
media.addEventListener("change", publish);
window.addEventListener("storage", (event) => {
  if (event.key === key || event.key === null) {
    appearance = read();
    publish();
  }
});
publish();
export function useAppearance() {
  const mode = useSyncExternalStore(subscribe, () => appearance);
  const theme = useSyncExternalStore(subscribe, resolved);
  return { mode, theme, setAppearance };
}
