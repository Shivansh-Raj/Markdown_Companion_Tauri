import { describe, expect, it } from "vitest";
import { parseSse, pickModel, splitTypeLine, stripFence, titleFromMarkdown } from "./ai";

describe("splitTypeLine", () => {
  it("holds back output while the type line is incomplete", () => {
    expect(splitTypeLine("TY").pending).toBe(true);
    expect(splitTypeLine("TYPE: pl").pending).toBe(true);
    expect(splitTypeLine("TYPE: plan").pending).toBe(true);
  });
  it("extracts type and body", () => {
    const r = splitTypeLine("TYPE: tasks\n\n# Groceries\n- [ ] milk");
    expect(r).toEqual({ type: "tasks", body: "# Groceries\n- [ ] milk", pending: false });
  });
  it("passes through output without a type line", () => {
    expect(splitTypeLine("# Hello world").body).toBe("# Hello world");
  });
  it("ignores unknown types", () => {
    expect(splitTypeLine("TYPE: banana\n# X").type).toBeNull();
  });
});

describe("helpers", () => {
  it("finds the title", () => {
    expect(titleFromMarkdown("intro\n# **Launch** plan\n", "x")).toBe("Launch plan");
    expect(titleFromMarkdown("no heading", "fallback")).toBe("fallback");
  });
  it("strips fences", () => {
    expect(stripFence("```markdown\n# A\n```")).toBe("# A");
    expect(stripFence("# A")).toBe("# A");
  });
  it("parses SSE", () => {
    const chunk = 'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: {"choices":[{"delta":{"content":" there"}}]}\n\ndata: [DO';
    const r = parseSse(chunk);
    expect(r.deltas).toEqual(["Hi", " there"]);
    expect(r.rest).toBe("data: [DO");
    expect(parseSse("data: [DONE]\n").done).toBe(true);
  });
});

describe("pickModel", () => {
  it("prefers known good chat models and skips non-chat ones", () => {
    expect(pickModel(["whisper-large-v3", "llama-3.1-8b-instant", "openai/gpt-oss-120b"])).toBe("openai/gpt-oss-120b");
  });
  it("falls back to any chat model", () => {
    expect(pickModel(["whisper-large-v3", "some-new-model"])).toBe("some-new-model");
    expect(pickModel(["whisper-large-v3", "llama-guard-4"])).toBeNull();
  });
});
