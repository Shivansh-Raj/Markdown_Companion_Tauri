import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import type { ThemeName } from "../types";

// Small, lazily loaded language set keeps the bundle light. The JS regex engine avoids WASM.
const LANGS: Record<string, () => Promise<unknown>> = {
  javascript: () => import("shiki/langs/javascript.mjs"),
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  bash: () => import("shiki/langs/bash.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  go: () => import("shiki/langs/go.mjs"),
};

const ALIASES: Record<string, string> = {
  js: "javascript", ts: "typescript", sh: "bash", shell: "bash", zsh: "bash",
  py: "python", rs: "rust", yml: "yaml", md: "markdown",
};

export function shikiTheme(theme: ThemeName): "github-light" | "github-dark" {
  return theme === "pixel-dark" ? "github-dark" : "github-light";
}

let highlighter: Promise<HighlighterCore> | null = null;
const loaded = new Set<string>();

function get(): Promise<HighlighterCore> {
  highlighter ??= createHighlighterCore({
    themes: [import("shiki/themes/github-light.mjs"), import("shiki/themes/github-dark.mjs")],
    langs: [],
    engine: createJavaScriptRegexEngine(),
  });
  return highlighter;
}

export function resolveLang(lang: string | undefined): string | null {
  if (!lang) return null;
  const l = lang.toLowerCase();
  const name = ALIASES[l] ?? l;
  return name in LANGS ? name : null;
}

/** Returns highlighted HTML (Shiki escapes code content), or null for unknown languages. */
export async function highlight(code: string, lang: string | undefined, theme: ThemeName): Promise<string | null> {
  const name = resolveLang(lang);
  if (!name) return null;
  const h = await get();
  if (!loaded.has(name)) {
    await h.loadLanguage((await LANGS[name]()) as never);
    loaded.add(name);
  }
  return h.codeToHtml(code, { lang: name, theme: shikiTheme(theme) });
}
