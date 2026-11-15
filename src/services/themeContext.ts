import { createContext, useContext } from "react";
import type { ThemeName } from "../types";

export const THEME_OPTIONS: { id: ThemeName; label: string }[] = [
  { id: "retro-red", label: "Retro Red" },
  { id: "pixel-dark", label: "Pixel Dark" },
];

export function asTheme(value: unknown): ThemeName {
  return THEME_OPTIONS.some((t) => t.id === value) ? (value as ThemeName) : "retro-red";
}

export const ThemeContext = createContext<ThemeName>("retro-red");
export const useTheme = () => useContext(ThemeContext);
