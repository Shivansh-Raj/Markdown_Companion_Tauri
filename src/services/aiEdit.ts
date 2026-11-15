import { listSections, parseDocument, type SectionInfo } from "./markdownParser";
import { stripFence } from "./ai";

export const MAX_EDIT_CHARS = 60_000;

export type TextRange = { start: number; end: number };
export type EditScope =
  | { kind: "whole" }
  | { kind: "section"; section: SectionInfo }
  | { kind: "selection"; range: TextRange };

function rangeOf(source: string, scope: EditScope): TextRange {
  if (scope.kind === "whole") return { start: 0, end: source.length };
  return scope.kind === "section" ? { start: scope.section.start, end: scope.section.end } : scope.range;
}

export function buildEditSystemPrompt(scope: EditScope["kind"]): string {
  const common =
    "You edit Markdown files for a checklist app. Follow the user's instruction exactly and change nothing else. " +
    "Preserve every task checkbox state ('- [x]' stays checked, '- [ ]' stays unchecked) unless the instruction says otherwise. " +
    "Keep existing wording, order and formatting of anything the instruction does not touch. " +
    "Output ONLY the resulting Markdown, with no commentary and no code fences around it.";
  if (scope === "selection")
    return common + " You are given a FRAGMENT of a larger document that the user highlighted. Return only the edited fragment, to be pasted back in the same place. Do not add a heading or any text the instruction does not require.";
  return scope === "section"
    ? common + " You are given ONE section of a larger document, starting with its heading line. Return that complete section (keep its heading line unless told to change it) and nothing outside it."
    : common + " You are given the whole document. Return the complete updated document.";
}

export function buildEditUserPrompt(instruction: string, text: string): string {
  return `Instruction:\n${instruction.trim()}\n\nMarkdown to edit:\n<<<\n${text}\n>>>`;
}

/** Text the AI is allowed to see and change. */
export function scopeText(source: string, scope: EditScope): string {
  const { start, end } = rangeOf(source, scope);
  return source.slice(start, end);
}

function cleanOutput(aiOutput: string): string {
  return stripFence(aiOutput).replace(/^\s*<<<\s*\n|\n\s*>>>\s*$/g, "");
}

/**
 * Full pipeline: cleans the model output, restores checkbox progress inside the edited region only,
 * and splices it back so everything outside the region stays byte-identical.
 */
export function buildEditedDocument(source: string, scope: EditScope, aiOutput: string): string {
  const { start, end } = rangeOf(source, scope);
  const original = source.slice(start, end);
  let region = cleanOutput(aiOutput);
  if (scope.kind === "whole") {
    if (original.endsWith("\n") && !region.endsWith("\n")) region += "\n";
  } else {
    // Keep the original's surrounding whitespace so neighbouring text is not glued together.
    const lead = /^\s*/.exec(original)?.[0] ?? "";
    const trail = /\s*$/.exec(original)?.[0] ?? "";
    region = lead + region.trim() + (original.trim() ? trail : "");
  }
  region = preserveProgress(original, region);
  return source.slice(0, start) + region + source.slice(end);
}

/**
 * Maps text highlighted in the rendered view back to the source. Only succeeds when the text occurs
 * exactly once, because rendering drops Markdown syntax and a guess could edit the wrong place.
 */
export function locateSelection(source: string, selected: string): TextRange | null {
  const needle = selected.trim();
  if (needle.length < 2) return null;
  const first = source.indexOf(needle);
  if (first < 0 || source.indexOf(needle, first + 1) >= 0) return null;
  return { start: first, end: first + needle.length };
}

/**
 * Restores checkbox states from the original text onto the edited text so progress is never lost.
 * Tasks are matched by their text; if some remain unmatched but the leftovers pair up one-to-one
 * (e.g. a task was reworded), they are matched by position. Brand-new tasks start unchecked.
 */
export function preserveProgress(original: string, edited: string): string {
  const oldTasks = parseDocument(original).tasks;
  const newTasks = parseDocument(edited).tasks;
  const pool = new Map<string, number[]>();
  oldTasks.forEach((t, i) => pool.set(t.text, [...(pool.get(t.text) ?? []), i]));

  const state: (boolean | undefined)[] = newTasks.map(() => undefined);
  const used = new Set<number>();
  newTasks.forEach((t, i) => {
    const idx = pool.get(t.text)?.shift();
    if (idx !== undefined) {
      state[i] = oldTasks[idx].checked;
      used.add(idx);
    }
  });
  const freeNew = newTasks.map((_, i) => i).filter((i) => state[i] === undefined);
  const freeOld = oldTasks.map((_, i) => i).filter((i) => !used.has(i));
  if (freeNew.length > 0 && freeNew.length === freeOld.length) {
    freeNew.forEach((ni, k) => (state[ni] = oldTasks[freeOld[k]].checked));
  }

  let result = edited;
  for (let i = newTasks.length - 1; i >= 0; i--) {
    const want = state[i] ?? false;
    const t = newTasks[i];
    if (t.checked !== want) {
      result = result.slice(0, t.offset) + (want ? "[x]" : "[ ]") + result.slice(t.offset + 3);
    }
  }
  return result;
}

export function sectionsOf(source: string): SectionInfo[] {
  return listSections(source);
}
