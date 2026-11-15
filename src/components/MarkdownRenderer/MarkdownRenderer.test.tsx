import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { parseDocument } from "../../services/markdownParser";
import { resolveLang, shikiTheme } from "../../services/highlighter";

const render = (source: string) => renderToStaticMarkup(<MarkdownRenderer source={source} />);

describe("MarkdownRenderer", () => {
  it("renders headings, emphasis and strikethrough", () => {
    const h = render("# T\n\n###### Six\n\n**b** *i* ~~s~~");
    expect(h).toContain("<h1>T</h1>");
    expect(h).toContain("<h6>Six</h6>");
    expect(h).toContain("<strong>b</strong>");
    expect(h).toContain("<em>i</em>");
    expect(h).toContain("<del>s</del>");
  });

  it("renders nested lists and task lists with checkboxes", () => {
    const h = render("- a\n  - b\n\n- [x] done\n- [ ] todo\n  - [ ] nested");
    expect(h.match(/<ul/g)!.length).toBeGreaterThanOrEqual(2);
    expect(h.match(/type="checkbox"/g)).toHaveLength(3);
    expect(h).toContain("checked");
  });

  it("renders GFM tables inside a scroll wrapper", () => {
    const h = render("| a | b |\n|---|---|\n| 1 | 2 |");
    expect(h).toContain('class="table-scroll"');
    expect(h).toContain("<th>a</th>");
  });

  it("renders blockquote, hr, inline code and fenced code", () => {
    const h = render("> q\n\n---\n\n`x`\n\n```ts\nconst a = 1;\n```");
    expect(h).toContain("<blockquote>");
    expect(h).toContain("<hr/>");
    expect(h).toContain('class="inline-code"');
    expect(h).toContain('class="code-block"');
    expect(h).toContain("const a = 1;");
  });

  it("handles escapes, unicode, CRLF and empty input", () => {
    expect(render("\\*not em\\*")).toContain("*not em*");
    expect(render("# 日本語 — Ünïcode 🚀")).toContain("日本語 — Ünïcode 🚀");
    expect(render("a\r\n\r\n- [ ] t\r\n- [x] u\r\n")).toContain('type="checkbox"');
    expect(render("")).toContain('class="markdown"');
  });

  it("does not render raw HTML or javascript: links", () => {
    const h = render('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[x](javascript:alert(1))');
    expect(h).not.toContain("<script");
    expect(h).not.toContain("<img");
    expect(h).not.toContain("javascript:");
  });

  it("degrades non-https images to a placeholder", () => {
    const h = render("![logo](./local.png)");
    expect(h).toContain("img-missing");
    expect(h).not.toContain("<img");
  });

  it("copes with malformed and very long documents", () => {
    expect(() => render("| a |\n|--\n**unclosed `code\n```")).not.toThrow();
    const long = Array.from({ length: 3000 }, (_, i) => `- [ ] item ${i}`).join("\n");
    expect(render(long).match(/type="checkbox"/g)).toHaveLength(3000);
  });
});

describe("interactive tasks", () => {
  const src = "# Plan\n\n- [x] a\n  - [ ] b\n- plain\n- [ ] c\n\n## Sub\n\n- [ ] d\n";
  const html = (busy = false, withHandler = true) =>
    renderToStaticMarkup(
      <MarkdownRenderer source={src} doc={parseDocument(src)} busy={busy} onToggleTask={withHandler ? () => {} : undefined} />,
    );

  it("wires every rendered checkbox to the matching parsed task offset", () => {
    const doc = parseDocument(src);
    const offsets = [...html().matchAll(/data-task-offset="(\d+)"/g)].map((m) => Number(m[1]));
    expect(offsets).toEqual(doc.tasks.map((t) => t.offset));
  });

  it("enables checkboxes only when interactive and idle", () => {
    expect(html()).not.toContain("disabled");
    expect(html(true)).toContain("disabled");
    expect(html(false, false)).toContain("disabled");
  });

  it("labels checkboxes with task text and shows section progress", () => {
    const h = html();
    expect(h).toContain('aria-label="a"');
    expect(h).toContain('aria-label="1 of 4 done"'); // # Plan includes sub-section task d
    expect(h).toContain('aria-label="0 of 1 done"'); // ## Sub
  });
});

describe("resolveLang", () => {
  it("picks a code theme matching the app theme", () => {
    expect(shikiTheme("retro-red")).toBe("github-light");
    expect(shikiTheme("pixel-dark")).toBe("github-dark");
  });

  it("maps aliases and rejects unknown languages", () => {
    expect(resolveLang("TS")).toBe("typescript");
    expect(resolveLang("sh")).toBe("bash");
    expect(resolveLang("brainfuck")).toBeNull();
    expect(resolveLang(undefined)).toBeNull();
  });
});
