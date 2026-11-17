import { describe, expect, it } from "vitest";
import {
  actionItemsMarkdown, buildSystemPrompt, latestByType, limitTranscript, parseActionItems, stripFences, timedTranscript, toResult,
} from "./analyses";
import { appendBlock, appendToContent, combinedMarkdown, standaloneMarkdown } from "./templates";
import type { SessionMeta, TranscriptChunk } from "./types";

const meta: SessionMeta = {
  id: "1", title: "Sprint review", mode: "meeting", createdAtMs: new Date(2026, 10, 17, 9).getTime(),
  durationMs: 90_000, status: "stopped", device: "mic", chunks: 2,
};
const chunk = (i: number, text: string, status: TranscriptChunk["status"] = "final"): TranscriptChunk => ({
  index: i, startMs: i * 65_000, endMs: i * 65_000 + 60_000, text, words: [], status,
});

describe("action items", () => {
  it("parses a fenced JSON reply and maps unknowns to null (no invented owners or dates)", () => {
    const raw = '```json\n[{"task":"Send the report","owner":"Priya","deadline":"Friday","context":"for finance"},' +
      '{"task":"Book the room","owner":"Not stated","deadline":"TBD","context":null},{"task":"  "},{"owner":"x"}]\n```';
    const items = parseActionItems(raw);
    expect(items).toEqual([
      { task: "Send the report", owner: "Priya", deadline: "Friday", context: "for finance" },
      { task: "Book the room", owner: null, deadline: null, context: null },
    ]);
  });

  it("tolerates text around the array and rejects replies without one", () => {
    expect(parseActionItems('Here you go: [{"task":"A"}] hope it helps')).toHaveLength(1);
    expect(parseActionItems("[]")).toEqual([]);
    expect(() => parseActionItems("no list here")).toThrow(/list of action items/);
    expect(() => parseActionItems("[{broken")).toThrow();
  });

  it("renders unchecked checkboxes and marks missing owner/date as not stated", () => {
    const md = actionItemsMarkdown([
      { task: "Send the report", owner: "Priya", deadline: null, context: "for finance" },
    ]);
    expect(md).toBe("- [ ] Send the report\n  - Owner: Priya\n  - Due: _not stated_\n  - Context: for finance");
    expect(actionItemsMarkdown([])).toContain("No action items");
  });
});

describe("analysis plumbing", () => {
  it("builds a timestamped transcript from final chunks only", () => {
    expect(timedTranscript([chunk(0, "Hello"), chunk(1, "pending", "pending"), chunk(2, "Bye")])).toBe("[00:00] Hello\n[02:10] Bye");
  });

  it("limits very long transcripts on a line boundary and says so", () => {
    expect(limitTranscript("short", 100)).toEqual({ text: "short", truncated: false });
    const r = limitTranscript("aaaa\nbbbb\ncccc", 11);
    expect(r.truncated).toBe(true);
    expect(r.text).toBe("aaaa\nbbbb");
  });

  it("strips fences and rejects empty replies", () => {
    expect(stripFences("```markdown\n- a\n```")).toBe("- a");
    expect(() => toResult("summary", "   ", false)).toThrow();
    expect(toResult("takeaways", "- one", true, 5)).toMatchObject({ type: "takeaways", markdown: "- one", truncated: true, createdAtMs: 5 });
  });

  it("keeps the newest result per type", () => {
    const a = { type: "summary" as const, createdAtMs: 1, markdown: "old" };
    const b = { type: "summary" as const, createdAtMs: 2, markdown: "new" };
    const c = { type: "actions" as const, createdAtMs: 1, markdown: "x", items: [] };
    const out = latestByType([b, a, c]);
    expect(out.summary?.markdown).toBe("new");
    expect(out.actions).toBeDefined();
  });

  it("tells the model not to invent owners or deadlines", () => {
    expect(buildSystemPrompt("actions")).toMatch(/ONLY if the transcript names/);
    expect(buildSystemPrompt("summary")).toMatch(/Never invent/);
  });
});

describe("markdown templates", () => {
  const summary = { type: "summary" as const, createdAtMs: 1, markdown: "## Overview\nWe met." };
  const actions = { type: "actions" as const, createdAtMs: 1, markdown: "- [ ] Do it\n  - Owner: _not stated_\n  - Due: _not stated_", items: [] };

  it("renders stand-alone and combined documents with a dated header", () => {
    expect(standaloneMarkdown(meta, summary)).toContain("# Sprint review — Meeting summary");
    const all = combinedMarkdown(meta, [actions, summary]);
    expect(all.indexOf("## Meeting summary")).toBeLessThan(all.indexOf("## Action items")); // fixed order
    expect(all).toContain("**Date:** 2026-11-17");
  });

  it("appends without touching existing content or completed checkboxes", () => {
    const existing = "# Project\n\n- [x] done task\n- [ ] open task\n\n";
    const out = appendToContent(existing, appendBlock(meta, [summary, actions]));
    expect(out.startsWith("# Project\n\n- [x] done task\n- [ ] open task\n\n## Sprint review (2026-11-17)")).toBe(true);
    expect(out.endsWith("\n")).toBe(true);
    expect(out).toContain("### Action items");
  });
});
