import { describe, expect, it } from "vitest";
import { prepareForNotion } from "./notionMarkdown";

describe("prepareForNotion", () => {
  it("keeps plain Markdown as it is and takes the title from the first heading", () => {
    const d = prepareForNotion("# Sprint plan\n\n- [ ] a\n- [x] b\n", "file");
    expect(d.title).toBe("Sprint plan");
    expect(d.markdown).toBe("# Sprint plan\n\n- [ ] a\n- [x] b\n");
    expect(d.notes).toEqual([]);
  });

  it("falls back to the file name when there is no title", () => {
    expect(prepareForNotion("just text", "My file").title).toBe("My file");
  });

  it("turns frontmatter into a visible code block instead of dropping it", () => {
    const d = prepareForNotion('---\ntitle: "Retro"\ntags: [a, b]\n---\n# Body\n\ntext', "file");
    expect(d.title).toBe("Retro");
    expect(d.markdown.startsWith("```yaml\ntitle: \"Retro\"\ntags: [a, b]\n```\n\n# Body")).toBe(true);
    expect(d.markdown).not.toMatch(/^---/);
    expect(d.notes.join(" ")).toContain("frontmatter");
  });

  it("uses the heading when frontmatter has no title", () => {
    expect(prepareForNotion("---\ntype: meeting\n---\n# Weekly\n", "f").title).toBe("Weekly");
  });

  it("warns about content Notion shows differently", () => {
    const d = prepareForNotion("See [[Roadmap]] and [[Plan|the plan]].\n\n![[img.png]]\n\n> [!note] Hi\n> there", "f");
    const notes = d.notes.join("\n");
    expect(notes).toContain("2 [[wikilink]]s");
    expect(notes).toContain("Embedded");
    expect(notes).toContain("Callouts");
    expect(d.markdown).toContain("[[Roadmap]]");
  });
});
