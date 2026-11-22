import { describe, expect, it } from "vitest";
import { assertConsistent } from "./receipt";
import { buildGrammarSystem, cleanGrammar, grammarRequest } from "./aiGrammar";

describe("grammar fixer", () => {
  it("tells the model to fix errors only and leave wording, Markdown and code alone", () => {
    const s = buildGrammarSystem();
    expect(s).toMatch(/Do NOT rephrase/);
    expect(s).toMatch(/Markdown syntax, links, URLs, code/);
    expect(s).toMatch(/ONLY the corrected text/);
  });

  it("sends only the typed text, with a consistent receipt", () => {
    const r = grammarRequest("Their going to the store.");
    expect(r.mode).toBe("typed");
    expect(r.user).toBe("Their going to the store.");
    expect(() => assertConsistent(r)).not.toThrow();
  });

  it("removes a wrapping fence and keeps the original's trailing newline habit", () => {
    expect(cleanGrammar("```\nThey're going.\n```", "Their going.")).toBe("They're going.");
    expect(cleanGrammar("They're going.", "Their going.\n")).toBe("They're going.\n");
  });
});
