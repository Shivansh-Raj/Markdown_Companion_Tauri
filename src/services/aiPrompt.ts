import { stripFence } from "./ai";
import type { ReceiptRequest } from "./receipt";

/**
 * Prompt Builder: turns a rough idea into a prompt for an AI agent, and refines it on request.
 * Pure text builders only; sending goes through the same Context Receipt + streamChat path as every other AI feature.
 */

export const PROMPT_SECTIONS = [
  "Objective and expected outcome",
  "Context and constraints",
  "Steps to take",
  "Technical requirements and dependencies",
  "Rules, restrictions and edge cases",
  "Validation and testing",
  "Deliverables and completion criteria",
] as const;

const RULES =
  "Output ONLY the prompt itself, with no commentary before or after and no code fence around it. " +
  "Write it in Markdown, addressed to the AI agent that will run it (second person: 'You will…'). " +
  "Be concrete and actionable, not generic. " +
  "Never invent facts, file names, tools, versions or requirements the user did not give. " +
  "Where something important is unknown, write it as '[CONFIRM: …]' so the user can fill it in, or state a clearly labelled assumption.";

export function buildGenerateSystem(): string {
  return (
    "You write execution-ready prompts for AI agents (coding agents, autonomous agents and other AI-powered tools). " +
    RULES +
    " Organise the prompt under these '##' headings, in this order, leaving out a heading only if it truly does not apply: " +
    PROMPT_SECTIONS.map((s, i) => `${i + 1}. ${s}`).join("; ") +
    ". Use numbered lists for steps and '-' bullets for rules. Start with a single '# ' title line."
  );
}

export function buildRefineSystem(): string {
  return (
    "You revise an existing prompt for an AI agent according to the user's instruction. " +
    RULES +
    " Return the COMPLETE updated prompt. Keep every existing requirement, constraint, detail and the overall structure " +
    "unless the instruction explicitly changes or removes it. Do not drop content just to be shorter unless asked to shorten. " +
    "Text the user wrote by hand is intentional: preserve it as written unless the instruction says otherwise."
  );
}

/** Quick actions for refining. Each is a plain-language instruction sent as the user's request. */
export const REFINE_ACTIONS = [
  { key: "improve", label: "IMPROVE", instruction: "Improve this prompt: make it clearer, more specific and more actionable, fixing gaps and ambiguity." },
  { key: "expand", label: "EXPAND", instruction: "Expand this prompt with more detail: more explicit steps, edge cases and validation, without inventing facts." },
  { key: "shorten", label: "SHORTEN", instruction: "Shorten this prompt. Remove redundancy and filler but keep every requirement." },
  { key: "restructure", label: "RESTRUCTURE", instruction: `Restructure this prompt under these headings, in order: ${PROMPT_SECTIONS.join("; ")}. Keep all content.` },
] as const;

export const MAX_IDEA = 4000;
export const MAX_INSTRUCTION = 1000;
export const MAX_PROMPT = 20000;

const IDEA_LABEL = "Your description";
const PROMPT_LABEL = "Current prompt (as in the editor)";
const INSTRUCTION_LABEL = "Your instruction";

/**
 * Only text the user typed or can see and edit in the editor is sent, so no review dialog is needed.
 * The editor text counts as typed: the user is looking at it and may have changed it by hand.
 */
export function generateRequest(idea: string): ReceiptRequest {
  const typed = idea.trim();
  return {
    purpose: "Generate a prompt", system: buildGenerateSystem(), user: typed, mode: "typed",
    items: [{ label: IDEA_LABEL, text: typed, typed: true }],
  };
}

export function refineRequest(current: string, instruction: string): ReceiptRequest {
  const cur = current.trim();
  const ins = instruction.trim();
  return {
    purpose: "Update a prompt",
    system: buildRefineSystem(),
    user: `Current prompt:\n<<<\n${cur}\n>>>\n\nChange requested:\n${ins}`,
    mode: "typed",
    items: [
      { label: PROMPT_LABEL, text: cur, typed: true },
      { label: INSTRUCTION_LABEL, text: ins, typed: true },
    ],
  };
}

/** The model's reply, cleaned: wrapping fence removed, surrounding blank space trimmed. */
export function cleanPrompt(raw: string): string {
  return stripFence(raw).trim();
}
