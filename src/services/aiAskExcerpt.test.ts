import { describe, expect, it } from "vitest";
import { ASK_BUDGET_CHARS, excerptForAsk } from "./aiAsk";

const section = (n: number, body: string) => `## Section ${n}\n\n${body}\n\n`;
const filler = (n: number) => `Filler sentence ${n} about nothing in particular. `.repeat(40);

describe("excerptForAsk", () => {
  it("sends a short file whole", () => {
    const e = excerptForAsk("# T\n\nshort", "anything");
    expect(e).toEqual({ text: "# T\n\nshort", partial: false, sent: 1, total: 1 });
  });

  it("keeps a long file under the budget and picks the parts that match the question", () => {
    let doc = "# Big\n\n";
    for (let i = 0; i < 60; i++) doc += section(i, i === 41 ? "The deadline for the migration is 14 March, owned by Priya." : filler(i));
    expect(doc.length).toBeGreaterThan(ASK_BUDGET_CHARS * 3);
    const e = excerptForAsk(doc, "Who owns the migration deadline?");
    expect(e.partial).toBe(true);
    expect(e.text.length).toBeLessThanOrEqual(ASK_BUDGET_CHARS);
    expect(e.text).toContain("14 March, owned by Priya");
  });

  it("spreads over the whole file for a general question", () => {
    let doc = "# Big\n\n";
    for (let i = 0; i < 40; i++) doc += section(i, `Unique-${i} ` + filler(i));
    const e = excerptForAsk(doc, "Summarise this file in three bullets.");
    expect(e.partial).toBe(true);
    expect(e.text.length).toBeLessThanOrEqual(ASK_BUDGET_CHARS);
    expect(e.text).toContain("Unique-0 ");
    expect(e.text).toContain("Unique-39 ");
    expect(e.text.indexOf("Unique-3 ")).toBeLessThan(e.text.indexOf("Unique-30 "));
  });

  it("copes with one huge paragraph and no headings", () => {
    const e = excerptForAsk("word ".repeat(20_000), "word");
    expect(e.text.length).toBeLessThanOrEqual(ASK_BUDGET_CHARS);
    expect(e.partial).toBe(true);
  });
});

import { headingForQuote, parseAskAnswer } from "./aiAsk";

describe("quotes name their section", () => {
  const doc = "# Plan\n\nIntro line.\n\n## Risks\n\nThe vendor may slip by two weeks.\n\n## Owners\n\nPriya owns the migration.\n";
  it("finds the heading above a quote, ignoring case and punctuation", () => {
    expect(headingForQuote(doc, "the vendor may slip by two weeks")).toBe("Risks");
    expect(headingForQuote(doc, "Priya owns the migration")).toBe("Owners");
    expect(headingForQuote(doc, "nothing like this")).toBeNull();
  });

  it("adds the heading to verified sources only", () => {
    const p = parseAskAnswer('Priya.\n\nSOURCES:\n- "Priya owns the migration."\n- "invented quote that is not there"', doc);
    expect(p.sources[0]).toMatchObject({ verified: true, heading: "Owners" });
    expect(p.sources[1].verified).toBe(false);
    expect(p.sources[1].heading).toBeUndefined();
  });
});

import { archiveMarkdown } from "./aiAsk";

describe("archiving an answer", () => {
  it("keeps the question, the answer and only verified quotes with their section and source link", () => {
    const md = archiveMarkdown(" Who owns it? ", "Priya.", [
      { quote: "Priya owns the migration.", verified: true, heading: "Owners" },
      { quote: "made up", verified: false },
    ], { name: "Roadmap", url: "https://notion.so/r" });
    expect(md).toContain("**Question:** Who owns it?");
    expect(md).toContain("**Source:** [Roadmap](https://notion.so/r)");
    expect(md).toContain("## Answer\n\nPriya.");
    expect(md).toContain("> Priya owns the migration.\n\n— Owners, [Roadmap](https://notion.so/r)");
    expect(md).not.toContain("made up");
  });

  it("leaves out the quotes heading when nothing was verified", () => {
    expect(archiveMarkdown("q", "a", [{ quote: "x", verified: false }], { name: "notes.md" })).not.toContain("Verified quotes");
  });
});

import { passagesFromPages } from "./aiAsk";

describe("passages from Notion pages", () => {
  const pages = [
    { title: "Retro", url: "https://notion.so/r", markdown: "# Retro\n\n## Decisions\n\nWe agreed to ship on Friday.\n\n## Other\n\nCake." },
    { title: "Sprint", url: "https://notion.so/s", markdown: "# Sprint\n\nNothing about it." },
  ];
  it("picks the sections that share words with the question and names page and section", () => {
    const p = passagesFromPages(pages, "When did we agree to ship?");
    expect(p[0]).toMatchObject({ name: "Retro", heading: "Decisions", path: "https://notion.so/r" });
    expect(p.some((x) => x.text.includes("Cake"))).toBe(false);
  });
  it("falls back to each page's opening when nothing matches, and stays within limits", () => {
    const p = passagesFromPages(pages, "zzz");
    expect(p.map((x) => x.name)).toEqual(["Retro", "Sprint"]);
    const big = passagesFromPages([{ title: "B", url: "u", markdown: Array.from({ length: 30 }, (_, i) => `## S${i}\n\nship ${"x".repeat(1500)}`).join("\n") }], "ship");
    expect(big.length).toBeLessThanOrEqual(3);
    expect(big.reduce((n, x) => n + x.text.length, 0)).toBeLessThanOrEqual(10_000);
  });
});
