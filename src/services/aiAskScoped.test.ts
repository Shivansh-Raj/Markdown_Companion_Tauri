import { describe, expect, it } from "vitest";
import {
  buildScopedSystemPrompt, buildScopedUserPrompt, isNotFound, NOT_FOUND_SCOPED, parseScopedAnswer, passagesText, retrievalQuery, type Passage,
} from "./aiAsk";
import { mint } from "./receipt";

const P = (name: string, heading: string, text: string): Passage => ({ path: `/v/${name}.md`, rel: `${name}.md`, name, heading, text });
const passages = [
  P("Kickoff", "Launch", "We agreed the launch date is 12 March. Maria owns the launch checklist."),
  P("Risks", "", "The launch could slip if the vendor is late."),
];

describe("scoped prompts", () => {
  it("numbers passages with their note and heading", () => {
    expect(passagesText(passages)).toBe(
      "[1] Kickoff.md > Launch\nWe agreed the launch date is 12 March. Maria owns the launch checklist.\n\n[2] Risks.md\nThe launch could slip if the vendor is late.",
    );
  });

  it("puts every passage verbatim in the prompt, so a receipt of the passages is accepted", () => {
    const user = buildScopedUserPrompt("When is the launch?", [{ question: "q", answer: "a" }], passages);
    const items = passages.map((p) => ({ label: p.rel, text: p.text }));
    expect(() => mint({ purpose: "t", system: buildScopedSystemPrompt(), user, items, mode: "review" })).not.toThrow();
    expect(user).toContain("Question: When is the launch?");
  });

  it("tells the model the passages are excerpts and what to say when nothing matches", () => {
    const sys = buildScopedSystemPrompt();
    expect(sys).toContain(NOT_FOUND_SCOPED);
    expect(sys).toMatch(/excerpts/);
  });

  it("searches with the previous question for a short follow-up", () => {
    expect(retrievalQuery("and who owns it?", "When is the launch?")).toBe("When is the launch? and who owns it?");
    expect(retrievalQuery("Who owns the launch checklist now?", "When is the launch?")).toBe("Who owns the launch checklist now?");
    expect(retrievalQuery("and who?")).toBe("and who?");
  });
});

describe("scoped answers", () => {
  it("attributes each verified quote to the note it came from", () => {
    const raw = 'The launch is on 12 March, owned by Maria.\nSOURCES:\n- [1] "launch date is 12 March"\n- [2] "could slip if the vendor is late"';
    const a = parseScopedAnswer(raw, passages);
    expect(a.answer).toBe("The launch is on 12 March, owned by Maria.");
    expect(a.sources.map((s) => [s.verified, s.passage?.name])).toEqual([[true, "Kickoff"], [true, "Risks"]]);
  });

  it("trusts the text, not the passage number the model claimed", () => {
    const a = parseScopedAnswer('Yes.\nSOURCES:\n- [2] "Maria owns the launch checklist"', passages);
    expect(a.sources[0]).toMatchObject({ verified: true });
    expect(a.sources[0].passage?.name).toBe("Kickoff");
  });

  it("leaves invented quotes unverified and unattributed", () => {
    const a = parseScopedAnswer('Sure.\nSOURCES:\n- [1] "the launch is cancelled for good"\n- "launch date is 12 March"', passages);
    expect(a.sources[0]).toMatchObject({ verified: false, passage: undefined });
    expect(a.sources[1]).toMatchObject({ verified: true });
    expect(a.sources[1].passage?.name).toBe("Kickoff");
  });

  it("copes with no sources, bad numbers and more than three quotes", () => {
    expect(parseScopedAnswer("Just text", passages)).toEqual({ answer: "Just text", sources: [] });
    expect(parseScopedAnswer('x\nSOURCES:\n- [9] "launch date is 12 March"', passages).sources[0].verified).toBe(true);
    const many = 'x\nSOURCES:\n' + ["a one", "b two", "c three", "d four"].map((q) => `- "${q}"`).join("\n");
    expect(parseScopedAnswer(many, passages).sources).toHaveLength(3);
  });

  it("recognises the not-found replies", () => {
    expect(isNotFound(NOT_FOUND_SCOPED)).toBe(true);
    expect(isNotFound("I couldn't find anything about that in the folder Atlas. Nothing was sent to the AI.")).toBe(true);
    expect(isNotFound("It is on 12 March.")).toBe(false);
  });
});
