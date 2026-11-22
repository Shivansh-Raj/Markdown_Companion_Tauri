import { stripFence } from "./ai";
import type { ReceiptRequest } from "./receipt";

/** Grammar fixer: corrects spelling, grammar and punctuation and changes nothing else. */

export const MAX_GRAMMAR_CHARS = 8000; // keeps one request inside Groq's free per-minute token budget

export function buildGrammarSystem(): string {
  return (
    "You are a careful proofreader. Correct spelling, grammar, punctuation, capitalisation and obvious typos in the user's text. " +
    "Do NOT rephrase, reword, restructure, shorten, expand or change the tone, vocabulary, voice or meaning. " +
    "Keep the author's wording wherever it is already correct, and keep their language and spelling variety (e.g. British or American). " +
    "Leave Markdown syntax, links, URLs, code, inline code, numbers, names and line breaks exactly as they are; only fix the prose around them. " +
    "Output ONLY the corrected text, with no commentary, no explanation and no code fence around it. " +
    "If the text is already correct, return it unchanged."
  );
}

/** Only the text the user pasted or typed is sent, so no review dialog is needed. */
export function grammarRequest(text: string): ReceiptRequest {
  return {
    purpose: "Correct grammar", system: buildGrammarSystem(), user: text, mode: "typed",
    items: [{ label: "Your text", text, typed: true }],
  };
}

export function cleanGrammar(raw: string, original: string): string {
  const out = stripFence(raw).replace(/^\s*\n/, "").replace(/\s+$/, "");
  // The model should keep the original's trailing newline habit; do not add or remove blank lines at the end.
  return original.endsWith("\n") ? out + "\n" : out;
}
