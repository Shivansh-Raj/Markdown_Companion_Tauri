import { useEffect, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "../services/api";
import { asTheme, ThemeContext } from "../services/themeContext";
import { watchAnimationPref } from "../services/animations";
import type { Settings, ThemeName } from "../types";

/** Applies the saved theme to the document and follows changes made in any window. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<ThemeName>("retro-red");

  useEffect(() => {
    api.getSettings().then((s) => setTheme(asTheme(s.theme))).catch(() => {});
    const un = listen<Settings>("settings-changed", (e) => setTheme(asTheme(e.payload.theme)));
    return () => {
      un.then((f) => f());
    };
  }, []);

  useEffect(() => watchAnimationPref(), []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}
