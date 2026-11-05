// Light, dark or follow macOS. The choice is a per-Mac preference, so it lives in localStorage;
// "system" leaves <html> without data-theme and the CSS follows prefers-color-scheme.

export type Theme = "system" | "light" | "dark";

const STORAGE_KEY = "sikrets.theme";

export function savedTheme(): Theme {
  try {
    const t = localStorage.getItem(STORAGE_KEY);
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(t: Theme) {
  if (t === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}

export function setTheme(t: Theme) {
  applyTheme(t);
  try {
    if (t === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, t);
  } catch {
    // Private storage unavailable: the choice lasts until the app quits.
  }
}
