// Light/dark preference. The only thing the console keeps in localStorage: it is not sensitive.

export type Theme = "system" | "light" | "dark";

const KEY = "mixin-console.theme";

export function storedTheme(): Theme {
  try {
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(theme: Theme): void {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  try {
    if (theme === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch { /* private mode: the choice lasts for this page only */ }
}

export const nextTheme = (theme: Theme): Theme => theme === "system" ? "light" : theme === "light" ? "dark" : "system";

export const themeLabel: Record<Theme, string> = { system: "跟随系统", light: "浅色", dark: "深色" };
