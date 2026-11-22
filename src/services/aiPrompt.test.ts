import { describe, expect, it } from "vitest";
import { assertConsistent, mint, approvedPayload } from "./receipt";
import {
  PROMPT_SECTIONS, REFINE_ACTIONS, buildGenerateSystem, buildRefineSystem, cleanPrompt, generateRequest, refineRequest,
} from "./aiPrompt";

describe("prompt builder", () => {
  it("asks for an agent-ready structure without inventing facts", () => {
    const s = buildGenerateSystem();
    for (const section of PROMPT_SECTIONS) expect(s).toContain(section);
    expect(s).toMatch(/Never invent/);
    expect(s).toContain("[CONFIRM:");
    expect(s).toMatch(/ONLY the prompt/);
  });

  it("refinement keeps existing requirements and hand edits unless told otherwise", () => {
    const s = buildRefineSystem();
    expect(s).toMatch(/COMPLETE updated prompt/);
    expect(s).toMatch(/Keep every existing requirement/);
    expect(s).toMatch(/wrote by hand/);
  });

  it("sends only typed text, so no review dialog is needed, and the receipt is consistent", () => {
    const g = generateRequest("  add dark mode  ");
    expect(g.mode).toBe("typed");
    expect(g.user).toBe("add dark mode");
    expect(() => assertConsistent(g)).not.toThrow();

    const r = refineRequest("# Title\n\n1. Do it\n", "add a rollback step");
    expect(r.mode).toBe("typed");
    expect(r.user).toContain("# Title");
    expect(r.user).toContain("add a rollback step");
    expect(() => assertConsistent(r)).not.toThrow();
    expect(approvedPayload(mint(r)).user).toBe(r.user);
  });

  it("every quick action is a non-empty instruction", () => {
    expect(REFINE_ACTIONS.map((a) => a.key)).toEqual(["improve", "expand", "shorten", "restructure"]);
    for (const a of REFINE_ACTIONS) expect(a.instruction.length).toBeGreaterThan(20);
  });

  it("strips a wrapping code fence and surrounding blank space", () => {
    expect(cleanPrompt("```markdown\n# P\n\nDo it\n```")).toBe("# P\n\nDo it");
    expect(cleanPrompt("\n\n# P\n")).toBe("# P");
  });
});
