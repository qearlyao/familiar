export type ThemeMode = "light" | "dark" | "auto";

const STORAGE_KEY = "familiar.theme";

function systemPrefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function loadMode(): ThemeMode {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "light" || stored === "dark" || stored === "auto") {
    return stored;
  }
  return "auto";
}

export function saveMode(mode: ThemeMode): void {
  localStorage.setItem(STORAGE_KEY, mode);
  applyTheme(mode);
}

export function applyTheme(mode: ThemeMode): void {
  const isDark = mode === "dark" || (mode === "auto" && systemPrefersDark());
  document.documentElement.classList.toggle("dark", isDark);
}

export function watchSystemTheme(getMode: () => ThemeMode): () => void {
  const mql = window.matchMedia("(prefers-color-scheme: dark)");
  const handler = () => {
    if (getMode() === "auto") applyTheme("auto");
  };
  mql.addEventListener("change", handler);
  return () => mql.removeEventListener("change", handler);
}
