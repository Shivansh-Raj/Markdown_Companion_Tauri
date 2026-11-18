import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownRenderer } from "../components/MarkdownRenderer/MarkdownRenderer";
import { extractFrontmatter, parseFrontmatter, wikilinkLabel } from "./obsidian";
import { listSections, parseDocument } from "./markdownParser";

const render = (s: string) => renderToStaticMarkup(<MarkdownRenderer source={s} />);

describe("parseFrontmatter", () => {
  it("reads scalars, inline lists and block lists", () => {
    const y = 'title: "My note"\nstatus: active\ntags: [a, b]\naliases:\n  - one\n  - two\nempty:\n# comment\n';
    expect(parseFrontmatter(y)).toEqual([
      { key: "title", value: "My note" },
      { key: "status", value: "active" },
      { key: "tags", value: ["a", "b"] },
      { key: "aliases", value: ["one", "two"] },
    ]);
  });
  it("ignores nested maps and garbage without throwing", () => {
    expect(() => parseFrontmatter("a:\n  b: 1\n: x\n- stray")).not.toThrow();
  });
});

describe("extractFrontmatter", () => {
  it("only matches a block at the very start", () => {
    expect(extractFrontmatter("---\na: 1\n---\n# T")).toBe("a: 1");
    expect(extractFrontmatter("# T\n---\na: 1\n---\n")).toBeNull();
    expect(extractFrontmatter("---\r\na: 1\r\n---\r\nbody")).toBe("a: 1");
  });
});

describe("wikilinkLabel", () => {
  it("handles alias, heading and folders", () => {
    expect(wikilinkLabel("Note")).toBe("Note");
    expect(wikilinkLabel("a/b/Note|Shown")).toBe("Shown");
    expect(wikilinkLabel("a/Note#Part")).toBe("Note › Part");
  });
});

describe("Obsidian rendering", () => {
  it("shows frontmatter as properties and never as text", () => {
    const h = render("---\ntitle: Plan\ntags: [x, y]\n---\n\n# Body");
    expect(h).toContain('class="properties"');
    expect(h).toContain("property-chip");
    expect(h).toContain("<h1>Body</h1>");
    expect(h).not.toContain("<hr");
    expect(h).not.toContain("<h2>");
  });
  it("renders wikilinks, embeds, highlights, tags and hides comments and block ids", () => {
    const h = render("See [[Folder/Note|the note]] and ![[img.png]] ==key== #proj/x done %%secret%% ^abc123");
    expect(h).toContain('class="wikilink">the note<');
    expect(h).toContain('class="embed">⧉ img.png<');
    expect(h).toContain('<mark class="highlight">key</mark>');
    expect(h).toContain('class="tag">#proj/x<');
    expect(h).not.toContain("secret");
    expect(h).not.toContain("abc123");
  });
  it("makes wikilinks clickable only when a handler is given", () => {
    const src = "[[Folder/Note#Part|shown]]";
    const live = renderToStaticMarkup(<MarkdownRenderer source={src} onOpenWikilink={() => {}} />);
    expect(live).toContain('role="link"');
    expect(live).toContain('title="Open Folder/Note#Part"');
    expect(live).toContain(">shown<");
    const plain = render(src);
    expect(plain).not.toContain('role="link"');
    expect(plain).toContain('class="wikilink"');
  });
  it("leaves code, urls and plain # alone", () => {
    const h = render("`[[x]]` and https://a.com/p#frag and issue #12\n\n```\n[[y]] #z\n```");
    expect(h).not.toContain('class="wikilink"');
    expect(h).not.toContain('class="tag"');
  });
  it("renders callouts with a title", () => {
    const h = render("> [!warning] Careful\n> body text\n\n> [!note]\n> second");
    expect(h).toContain("callout callout-warning");
    expect(h).toContain(">Careful<");
    expect(h).toContain("body text");
    expect(h).toContain(">Note<");
    expect(render("> plain quote")).not.toContain("callout");
  });
});

describe("offsets stay valid with Obsidian syntax", () => {
  const src = "---\ntags: [a]\ntitle: T\n---\n# Plan\n\n- [ ] see [[Note]] #tag\n> [!tip] x\n> - [x] in callout\n";
  it("parser ignores frontmatter and wires every checkbox to the right offset", () => {
    const doc = parseDocument(src);
    expect(doc.tasks.map((t) => src.slice(t.offset, t.offset + 3))).toEqual(["[ ]", "[x]"]);
    expect(listSections(src).map((s) => s.title)).toEqual(["Plan"]);
    const h = renderToStaticMarkup(<MarkdownRenderer source={src} doc={doc} onToggleTask={() => {}} />);
    expect([...h.matchAll(/data-task-offset="(\d+)"/g)].map((m) => Number(m[1]))).toEqual(doc.tasks.map((t) => t.offset));
  });
});
