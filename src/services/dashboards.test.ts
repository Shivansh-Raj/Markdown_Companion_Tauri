import { describe, expect, it } from "vitest";
import { DASHBOARD_FOLDER, dashboardFiles } from "./dashboards";
import { combinedFromSections, meetingSections, obsidianFrontmatter, practiceProperties } from "./voice/templates";
import { computeAnalytics } from "./voice/analytics";
import { parseFrontmatter } from "./obsidian";
import type { SessionMeta, TranscriptChunk } from "./voice/types";

const meta: SessionMeta = { id: "s", title: "Talk", mode: "practice", createdAtMs: new Date(2026, 10, 19, 10).getTime(), durationMs: 90_000, status: "stopped", device: "mic", chunks: 1 };

describe("dashboards", () => {
  it("are plain .base files with the documented top-level keys and safe names", () => {
    const files = dashboardFiles();
    expect(files.map((f) => f.name)).toEqual(["Meetings.base", "Speaking practice.base", "All voice sessions.base"]);
    expect(DASHBOARD_FOLDER).toBe("MC Dashboards");
    for (const f of files) {
      expect(f.name).toMatch(/^[A-Za-z0-9 _-]+\.base$/);
      expect(f.content).not.toContain("\t");
      expect(f.content).toMatch(/^filters:\n {2}and:\n/);
      expect(f.content).toMatch(/\nviews:\n {2}- type: table\n {4}name: /);
      expect(f.content).not.toMatch(/\bsort:/); // not documented for views, so never written
      expect(f.content.endsWith("\n")).toBe(true);
    }
  });

  it("only select notes MC wrote, by the same properties the export writes", () => {
    const fm = parseFrontmatter(obsidianFrontmatter({ ...meta, mode: "meeting" }, "meeting notes").split("---")[1]);
    const written = Object.fromEntries(fm.map((e) => [e.key, e.value]));
    expect(written.source).toBe("markdown-companion");
    expect(written.type).toBe("meeting");
    const [meetings, practice, all] = dashboardFiles();
    expect(meetings.content).toContain(`'source == "${written.source}"'`);
    expect(meetings.content).toContain(`'type == "meeting"'`);
    expect(practice.content).toContain(`'type == "practice"'`);
    expect(all.content).toContain('file.hasTag("voice")');
    expect(written.tags).toContain("voice");
  });

  it("show exactly the columns the practice export writes", () => {
    const words = Array.from({ length: 60 }, (_, i) => ({ w: i % 10 === 0 ? "um" : "word", start: i * 1000, end: i * 1000 + 400 }));
    const chunk = { index: 0, startMs: 0, endMs: 60_000, text: "x", words, status: "final" } as TranscriptChunk;
    const props = practiceProperties(computeAnalytics([chunk], 90_000));
    const md = combinedFromSections(meta, "presentation feedback", meetingSections([{ type: "summary", createdAtMs: 1, markdown: "S" }]), true, props);
    const written = new Set(parseFrontmatter(md.split("---")[1]).map((e) => e.key));
    const practice = dashboardFiles()[1].content;
    const columns = [...practice.split("order:\n")[1].matchAll(/ {6}- ([\w.]+)\n/g)].map((m) => m[1]);
    for (const c of columns.filter((c) => !c.startsWith("file."))) expect(written.has(c), `${c} is written by the export`).toBe(true);
    expect(props).toMatchObject({ words: 60, filler_count: expect.any(Number), fillers_per_100_words: expect.any(Number) });
  });

  it("practice properties leave out numbers that could not be measured", () => {
    const p = practiceProperties(computeAnalytics([], 0));
    expect(p).not.toHaveProperty("pace_wpm");
    expect(p).not.toHaveProperty("long_pauses");
    expect(p.words).toBe(0);
  });
});
