import { describe, expect, it } from "vitest";
import { MAX_ASK_CHARS, buildAskSystemPrompt, buildAskUserPrompt, isNotFound, limitDoc, parseAskAnswer, sourcesToShow } from "./aiAsk";

const DOC = "# Launch plan\n\n- [x] Write the **press release**\n- [ ] Book the venue for March 14\n\nOwner: Priya";

describe("ask the file", () => {
  it("tells the model to answer only from the document and explains the checkboxes", () => {
    const p = buildAskSystemPrompt();
    expect(p).toMatch(/ONLY what is written/);
    expect(p).toMatch(/\[x\].*completed/);
    expect(p).toContain("I couldn't find that in this file.");
  });

  it("includes the document, the question and recent turns in the prompt", () => {
    const u = buildAskUserPrompt("Who owns it?", [{ question: "What is left?", answer: "Book the venue." }], DOC);
    expect(u).toContain("Q: What is left?");
    expect(u).toContain("Document:");
    expect(u).toContain("Question: Who owns it?");
    expect(buildAskUserPrompt("x", [], DOC)).not.toContain("Earlier in this conversation");
  });

  it("verifies source quotes against the file (markdown and punctuation ignored) and flags invented ones", () => {
    const raw = 'The venue is not booked yet.\nSOURCES:\n- "Book the venue for March 14"\n- "Write the press release"\n- "The venue costs $5000"';
    const r = parseAskAnswer(raw, DOC);
    expect(r.answer).toBe("The venue is not booked yet.");
    expect(r.sources).toEqual([
      { quote: "Book the venue for March 14", verified: true },
      { quote: "Write the press release", verified: true },
      { quote: "The venue costs $5000", verified: false },
    ]);
  });

  it("handles replies without sources and recognises the not-found answer", () => {
    expect(parseAskAnswer("Priya.", DOC)).toEqual({ answer: "Priya.", sources: [] });
    expect(isNotFound("I couldn't find that in this file.")).toBe(true);
    expect(isNotFound("Priya.")).toBe(false);
  });

  it("caps sources at three and drops duplicates", () => {
    const raw = 'A.\nSOURCES:\n- "Owner: Priya"\n- "Owner: Priya"\n- "Launch plan"\n- "press release"\n- "Book the venue"';
    expect(parseAskAnswer(raw, DOC).sources.map((s) => s.quote)).toEqual(["Owner: Priya", "Launch plan", "press release"]);
  });

  it("does not repeat quotes that are already part of the answer", () => {
    const sources = [
      { quote: "Book the venue for March 14", verified: true },
      { quote: "Owner: Priya", verified: true },
      { quote: "invented line", verified: false },
    ];
    // answer repeats the first quote, so only the second is worth showing
    expect(sourcesToShow("- Book the venue for March 14.", sources)).toEqual({ extra: ["Owner: Priya"], verifiedCount: 2 });
    // everything verified is already in the answer: nothing extra, but it counts as checked
    expect(sourcesToShow("Book the venue for March 14. Owner: Priya.", sources)).toEqual({ extra: [], verifiedCount: 2 });
    expect(sourcesToShow("x", [{ quote: "q", verified: false }])).toEqual({ extra: [], verifiedCount: 0 });
  });

  it("truncates very large files on a line boundary and says so", () => {
    expect(limitDoc("short")).toEqual({ text: "short", truncated: false });
    const big = ("line of text\n").repeat(MAX_ASK_CHARS / 10);
    const r = limitDoc(big);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(MAX_ASK_CHARS);
    expect(r.text.endsWith("line of text")).toBe(true);
  });
});
