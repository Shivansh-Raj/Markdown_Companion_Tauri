import { describe, expect, it } from "vitest";
import { type AnalysisResult } from "./analyses";
import { appendFromSections, combinedFromSections, meetingSections, frontmatterProperties, standaloneFromSection } from "./templates";
import { parseFrontmatter } from "../markdownExtras";
import type { SessionMeta } from "./types";

const meta: SessionMeta = {
  id: "s1", title: 'Sprint "review"', mode: "meeting", createdAtMs: new Date(2026, 10, 19, 10).getTime(),
  durationMs: 12.5 * 60000, status: "stopped", device: "mic", chunks: 3,
};
const items = [
  { task: "Send notes", owner: "Sam", deadline: "2026-12-01", context: "after sync" },
  { task: "Book room", owner: null, deadline: "by Friday", context: null },
  { task: "Plain", owner: null, deadline: null, context: null },
];
const results: AnalysisResult[] = [
  { type: "summary", createdAtMs: 1, markdown: "Sum." },
  { type: "actions", createdAtMs: 1, markdown: "- [ ] old", items },
];

describe("Frontmatter export format", () => {
  it("writes frontmatter our own parser reads back", () => {
    const fm = frontmatterProperties(meta, "meeting notes");
    const yaml = fm.split("---")[1];
    const map = Object.fromEntries(parseFrontmatter(yaml).map((e) => [e.key, e.value]));
    expect(map.date).toBe("2026-11-19");
    expect(map.duration_min).toBe("12.5");
    expect(map.type).toBe("meeting");
    expect(map.tags).toEqual(["voice", "meeting"]);
    expect(fm).toContain('title: "Sprint \\"review\\""');
  });

  it("uses frontmatter in new files, but leaves default output unchanged", () => {
    const sections = meetingSections(results);
    const ob = combinedFromSections(meta, "meeting notes", sections, true);
    expect(ob.startsWith("---\n")).toBe(true);
    const plain = combinedFromSections(meta, "meeting notes", sections);
    expect(plain.startsWith("# ")).toBe(true);
    expect(plain).toContain("- [ ] old");
    expect(plain).not.toContain("---\ntitle");
  });

  it("never adds frontmatter when appending to an existing file", () => {
    const block = appendFromSections(meta, meetingSections(results));
    expect(block.startsWith("## ")).toBe(true);
    expect(block).not.toContain("source: markdown-companion");
  });

  it("standalone sections get frontmatter too", () => {
    expect(standaloneFromSection(meta, meetingSections(results)[0], true).startsWith("---\n")).toBe(true);
  });
});
