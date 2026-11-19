import { describe, expect, it } from "vitest";
import { notionTargetFor, notionValues, taskRowsFor } from "./notionExport";
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

  it("makes task rows that never invent dates or owners", () => {
    const rows = taskRowsFor([
      { task: "Send notes", owner: "Sam", deadline: "2026-12-01", context: "after sync" },
      { task: "Book room", owner: null, deadline: "by Friday", context: null },
      { task: "  ", owner: null, deadline: null, context: null },
      { task: "Plain\nwrapped", owner: " ", deadline: null, context: null },
    ], "page-1");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ title: "Send notes", values: { status: "Not started", due: "2026-12-01", owner: "Sam", meeting: "page-1" }, body: "Context: after sync" });
    expect(rows[1].values).toEqual({ status: "Not started", meeting: "page-1" });
    expect(rows[1].body).toBe("Due: by Friday");
    expect(rows[2].title).toBe("Plain wrapped");
    expect(rows[2].values).not.toHaveProperty("owner");
  });

  it("leaves out the meeting link when the meeting was not saved as a database row", () => {
    expect(taskRowsFor([{ task: "x", owner: null, deadline: null, context: null }], null)[0].values).toEqual({ status: "Not started" });
  });

  it("treats the same wording as the same task, ignoring case and spacing", () => {
    const [a] = taskRowsFor([{ task: "Send  Notes", owner: null, deadline: null, context: null }], null);
    const [b] = taskRowsFor([{ task: "send notes ", owner: null, deadline: null, context: null }], null);
    expect(a.key).toBe(b.key);
  });
});
