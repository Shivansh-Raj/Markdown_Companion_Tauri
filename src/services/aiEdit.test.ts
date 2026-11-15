import { describe, expect, it } from "vitest";
import { buildEditedDocument, locateSelection, preserveProgress, scopeText } from "./aiEdit";
import { listSections } from "./markdownParser";
import { diffLines, hasChanges, withContext } from "./diff";

const DOC = "# Plan\n\nintro\n\n## A\n- [x] one\n- [ ] two\n\n## B\n- [ ] three\n";

describe("sections", () => {
  it("includes sub-sections and ignores headings in code fences", () => {
    const s = listSections("# T\n## A\n### A1\n```\n# not heading\n```\n## B\n");
    expect(s.map((x) => x.title)).toEqual(["T", "A", "A1", "B"]);
    expect(s[1].end).toBe(s[3].start);
  });
});

describe("buildEditedDocument", () => {
  const section = listSections(DOC)[1]; // ## A
  const scope = { kind: "section", section } as const;

  it("only changes the selected section and keeps checked tasks", () => {
    expect(scopeText(DOC, scope)).toBe("## A\n- [x] one\n- [ ] two\n\n");
    const ai = "## A\n- [ ] one\n- [ ] two\n- [ ] extra\n";
    const out = buildEditedDocument(DOC, scope, ai);
    expect(out).toBe("# Plan\n\nintro\n\n## A\n- [x] one\n- [ ] two\n- [ ] extra\n\n## B\n- [ ] three\n");
    expect(out.startsWith(DOC.slice(0, section.start))).toBe(true);
    expect(out.endsWith(DOC.slice(section.end))).toBe(true);
  });
  it("strips code fences the model adds", () => {
    const out = buildEditedDocument(DOC, scope, "```markdown\n## A\n- [ ] one\n```");
    expect(out).toContain("## A\n- [x] one\n\n## B");
  });
  it("unchecks tasks the AI invented as checked", () => {
    expect(buildEditedDocument(DOC, scope, "## A\n- [x] brand new\n")).toContain("- [ ] brand new");
  });
});

describe("preserveProgress", () => {
  it("matches reworded tasks by position when counts line up", () => {
    expect(preserveProgress("- [x] a\n- [ ] b\n", "- [ ] a!\n- [ ] b\n")).toBe("- [x] a!\n- [ ] b\n");
  });
  it("follows moved tasks by text", () => {
    expect(preserveProgress("- [x] a\n- [ ] b\n", "- [ ] b\n- [ ] a\n")).toBe("- [ ] b\n- [x] a\n");
  });
});

describe("diff", () => {
  it("marks removed and added lines and collapses context", () => {
    const rows = diffLines("a\nb\nc\nd\ne\nf\ng\nh", "a\nb\nc\nd\nE\nf\ng\nh");
    expect(rows.filter((r) => r.kind === "del")).toEqual([{ kind: "del", text: "e" }]);
    expect(rows.filter((r) => r.kind === "add")).toEqual([{ kind: "add", text: "E" }]);
    const collapsed = withContext(rows, 1);
    expect(collapsed[0]).toEqual({ kind: "gap", hidden: 3 });
    expect(hasChanges(rows)).toBe(true);
    expect(hasChanges(diffLines("x", "x"))).toBe(false);
  });
});

describe("selection scope", () => {
  const src = "# T\n\nKeep this. Make this shorter please. Keep that.\n\n- [x] done\n";
  const range = { start: src.indexOf("Make"), end: src.indexOf(" Keep that") };
  const scope = { kind: "selection", range } as const;
  it("replaces only the highlighted text", () => {
    expect(scopeText(src, scope)).toBe("Make this shorter please.");
    const out = buildEditedDocument(src, scope, "Shorter.");
    expect(out).toBe("# T\n\nKeep this. Shorter. Keep that.\n\n- [x] done\n");
  });
  it("keeps progress inside a selected checklist", () => {
    const doc = "intro\n\n- [x] a\n- [ ] b\n\noutro\n";
    const r = { start: doc.indexOf("- [x] a"), end: doc.indexOf("\n\noutro") };
    expect(buildEditedDocument(doc, { kind: "selection", range: r }, "- [ ] a\n- [ ] b\n- [ ] c")).toBe(
      "intro\n\n- [x] a\n- [ ] b\n- [ ] c\n\noutro\n",
    );
  });
  it("locates a unique rendered selection only", () => {
    expect(locateSelection(src, "Make this shorter please.")).toEqual(range);
    expect(locateSelection("a b a b", "a b")).toBeNull();
    expect(locateSelection(src, "not there")).toBeNull();
  });
});

import { pushHistory } from "./history";
describe("history", () => {
  it("keeps most recent first without duplicates", () => {
    expect(pushHistory(["a", "b"], "b")).toEqual(["b", "a"]);
    expect(pushHistory(["a"], "  ")).toEqual(["a"]);
    expect(pushHistory(Array.from({ length: 8 }, (_, i) => String(i)), "new")).toHaveLength(8);
  });
});
