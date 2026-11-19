import { describe, expect, it } from "vitest";
import { notionTargetFor, notionValues } from "./notionExport";
import { bodyFromSections } from "./templates";
import type { SessionMeta } from "./types";

const meta = (mode: SessionMeta["mode"]): SessionMeta => ({ id: "1", title: "Sprint", mode, createdAtMs: Date.UTC(2026, 10, 19, 12), durationMs: 750_000, status: "stopped", device: "mic", chunks: 3 });

describe("notion export", () => {
  it("sends meetings and practice to their own destinations and everything else to Notes", () => {
    expect(notionTargetFor(meta("meeting")).key).toBe("meetings");
    expect(notionTargetFor(meta("practice")).key).toBe("practice");
    expect(notionTargetFor(meta("note")).key).toBe("notes");
  });

  it("builds values for the mapped columns, with speaking numbers for practice", () => {
    const v = notionValues(meta("practice"), { words: 620, pace_wpm: 138 });
    expect(v).toMatchObject({ type: "practice", duration_min: 12.5, tags: ["voice", "practice"], source: "Markdown Companion", words: 620, pace_wpm: 138 });
    expect(String(v.date)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("puts only the sections in the page body", () => {
    const md = bodyFromSections([{ id: "s", label: "Summary", suffix: "summary", markdown: "Done." }, { id: "a", label: "Actions", suffix: "actions", markdown: "- [ ] x", note: "short" }]);
    expect(md).toBe("## Summary\n\nDone.\n\n## Actions\n\n- [ ] x\n\n> Note: short\n\n".trim() + "\n");
    expect(md).not.toMatch(/^# /m);
  });
});
