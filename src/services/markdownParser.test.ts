import { describe, expect, it } from "vitest";
import { parseDocument } from "./markdownParser";
import { applyToggle, describeToggleError, resolveTaskAfterChange, staleSnapshot, statusFromEvent, utf8Offset } from "./markdownSync";

const ROADMAP = `# AI Learning Roadmap

## Phase 1: Mathematics

- [x] Linear Algebra
- [x] Probability Theory
- [ ] Statistical Inference
- [ ] Optimization

## Phase 2: Machine Learning

- [ ] Regression
- [ ] Decision Trees
- [ ] Neural Networks
- [ ] Transformers
`;

describe("parseDocument", () => {
  it("counts only task items, with correct totals", () => {
    const d = parseDocument(ROADMAP);
    expect(d.total).toBe(8);
    expect(d.done).toBe(2);
    expect(d.tasks[0]).toMatchObject({ text: "Linear Algebra", checked: true });
  });

  it("ignores ordinary bullets and non-task brackets", () => {
    const d = parseDocument("- plain\n- [link](x)\n- [] not a task\n- [ ]no space\n- [ ] real\n\nText [ ] inline\n");
    expect(d.total).toBe(1);
    expect(d.tasks[0].text).toBe("real");
  });

  it("points offsets exactly at the marker", () => {
    const d = parseDocument(ROADMAP);
    for (const t of d.tasks) expect(ROADMAP.slice(t.offset, t.offset + 3)).toBe(t.checked ? "[x]" : "[ ]");
  });

  it("handles nested, ordered, mixed and blockquoted task lists", () => {
    const src = "- [ ] a\n  - [x] b\n    - [ ] c\n  - plain\n    - [x] d\n1. [ ] n1\n2) [X] n2\n> - [ ] quoted\n* [x] star\n+ [ ] plus\n";
    const d = parseDocument(src);
    expect(d.tasks.map((t) => t.text)).toEqual(["a", "b", "c", "d", "n1", "n2", "quoted", "star", "plus"]);
    expect(d.tasks.map((t) => t.checked)).toEqual([false, true, false, true, false, true, false, true, false]);
    for (const t of d.tasks) expect(/^\[[ xX]\]$/.test(src.slice(t.offset, t.offset + 3))).toBe(true);
  });

  it("ignores tasks inside code fences", () => {
    expect(parseDocument("```\n- [ ] not real\n```\n").total).toBe(0);
  });

  it("computes cumulative section progress", () => {
    const d = parseDocument(ROADMAP);
    const byText = (h: string) => [...d.sections.entries()].find(([o]) => ROADMAP.slice(o).startsWith(h))![1];
    expect(byText("## Phase 1")).toEqual({ total: 4, done: 2 });
    expect(byText("## Phase 2")).toEqual({ total: 4, done: 0 });
    expect(byText("# AI")).toEqual({ total: 8, done: 2 });
  });

  it("works with CRLF, unicode, empty and malformed input", () => {
    const crlf = "# Ünï 日本\r\n\r\n- [ ] café ☕\r\n- [x] b\r\n";
    const d = parseDocument(crlf);
    expect(d.tasks.map((t) => crlf.slice(t.offset, t.offset + 3))).toEqual(["[ ]", "[x]"]);
    expect(parseDocument("").total).toBe(0);
    expect(() => parseDocument("- [ \n- [x\n**")).not.toThrow();
  });
});

describe("markdownSync", () => {
  it("applyToggle changes only the marker, preserving everything else", () => {
    const src = "# T\r\n- [ ] a\r\n- [x] b\r\n";
    const d = parseDocument(src);
    expect(applyToggle(src, d.tasks[0].offset, true)).toBe("# T\r\n- [x] a\r\n- [x] b\r\n");
    expect(applyToggle(src, d.tasks[1].offset, false)).toBe("# T\r\n- [ ] a\r\n- [ ] b\r\n");
  });

  it("applyToggle refuses a mismatched position or state", () => {
    expect(() => applyToggle("- [ ] a", 0, true)).toThrow();
    expect(() => applyToggle("- [ ] a", 2, false)).toThrow();
  });

  it("utf8Offset converts UTF-16 offsets to byte offsets", () => {
    expect(utf8Offset("abc", 2)).toBe(2);
    expect(utf8Offset("é☕🚀x", 4)).toBe(2 + 3 + 4); // 🚀 is 2 UTF-16 units, 4 bytes
  });

  it("describeToggleError distinguishes stale from failure", () => {
    const stale = describeToggleError({ kind: "stale", content: "new", hash: "h" });
    expect(stale.snapshot).toEqual({ content: "new", hash: "h" });
    expect(stale.message).toMatch(/changed on disk/);
    const failed = describeToggleError({ kind: "failed", message: "File is read-only" });
    expect(failed.snapshot).toBeNull();
    expect(failed.message).toContain("read-only");
    expect(describeToggleError("boom").message).toContain("boom");
  });
});

describe("resolveTaskAfterChange", () => {
  const before = parseDocument("- [ ] alpha\n- [ ] beta\n");
  const alpha = before.tasks[0];

  it("retries on the moved task when its text is unique", () => {
    const fresh = parseDocument("intro line\n\n- [ ] beta\n- [ ] alpha\n");
    const r = resolveTaskAfterChange(fresh, alpha, true);
    expect(r.action).toBe("retry");
    if (r.action === "retry") expect(r.task.text).toBe("alpha");
  });

  it("does nothing when someone already set the requested state", () => {
    const fresh = parseDocument("- [x] alpha\n- [ ] beta\n");
    expect(resolveTaskAfterChange(fresh, alpha, true).action).toBe("satisfied");
  });

  it("refuses when the task is gone, duplicated or has no text", () => {
    expect(resolveTaskAfterChange(parseDocument("- [ ] beta\n"), alpha, true).action).toBe("ambiguous");
    expect(resolveTaskAfterChange(parseDocument("- [ ] alpha\n- [x] alpha\n"), alpha, true).action).toBe("ambiguous");
    const blank = parseDocument("- [ ] \n");
    expect(resolveTaskAfterChange(blank, { ...alpha, text: "" }, true).action).toBe("ambiguous");
  });
});

describe("sync helpers", () => {
  it("staleSnapshot only matches stale errors", () => {
    expect(staleSnapshot({ kind: "stale", content: "c", hash: "h" })).toEqual({ content: "c", hash: "h" });
    expect(staleSnapshot({ kind: "failed", message: "x" })).toBeNull();
    expect(staleSnapshot("boom")).toBeNull();
  });
  it("statusFromEvent maps events to statuses", () => {
    expect(statusFromEvent({ kind: "changed", content: "", hash: "" })).toEqual({ kind: "ok" });
    expect(statusFromEvent({ kind: "missing" })).toEqual({ kind: "missing" });
    expect(statusFromEvent({ kind: "unreadable", message: "m" })).toEqual({ kind: "unreadable", message: "m" });
  });
});
