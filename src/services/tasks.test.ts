import { describe, expect, it } from "vitest";
import { groupNotionTasks, groupOf, groupTasks, localDate, plainTitle, shortDate } from "./tasks";
import type { TaskRow } from "../types";

const row = (over: Partial<TaskRow>): TaskRow => ({
  path: "/v/a.md", note: "A", rel: "a.md", source: "v", offset: 0, line: 1, title: "t", raw: "t",
  due: null, scheduled: null, recurring: false, ...over,
});

describe("task grouping", () => {
  it("formats the local calendar date, not UTC", () => {
    expect(localDate(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
  });

  it("classifies by due date", () => {
    expect(groupOf(null, "2026-11-19")).toBe("none");
    expect(groupOf("2026-11-18", "2026-11-19")).toBe("overdue");
    expect(groupOf("2026-11-19", "2026-11-19")).toBe("today");
    expect(groupOf("2026-11-20", "2026-11-19")).toBe("upcoming");
  });

  it("orders groups overdue, today, upcoming, no date and drops empty ones", () => {
    const rows = [
      row({ title: "n", due: null }), row({ title: "u", due: "2026-12-01" }), row({ title: "o", due: "2026-11-01" }), row({ title: "t", due: "2026-11-19" }),
    ];
    expect(groupTasks(rows, "2026-11-19").map((g) => g.id)).toEqual(["overdue", "today", "upcoming", "none"]);
    expect(groupTasks([row({ due: null })], "2026-11-19").map((g) => g.id)).toEqual(["none"]);
  });

  it("sorts within a group by date, then note, then line", () => {
    const rows = [
      row({ title: "b2", due: "2026-12-02", note: "B", line: 2 }), row({ title: "a", due: "2026-12-02", note: "A", line: 9 }),
      row({ title: "b1", due: "2026-12-02", note: "B", line: 1 }), row({ title: "early", due: "2026-12-01", note: "Z" }),
    ];
    const titles = groupTasks(rows, "2026-11-19")[0].rows.map((r) => r.title);
    expect(titles).toEqual(["early", "a", "b1", "b2"]);
  });

  it("filters by task text or note name, ignoring case and link syntax", () => {
    const rows = [row({ title: "Review [[Projects/Roadmap|the roadmap]]", note: "Sprint" }), row({ title: "Book room", note: "Retro" })];
    expect(groupTasks(rows, "2026-11-19", "ROADMAP")[0].rows).toHaveLength(1);
    expect(groupTasks(rows, "2026-11-19", "retro")[0].rows[0].title).toBe("Book room");
    expect(groupTasks(rows, "2026-11-19", "zzz")).toEqual([]);
  });

  it("shows task titles as plain text", () => {
    expect(plainTitle("See [[Folder/Note#Part]] and [[a|b]]")).toBe("See Note › Part and b");
    expect(shortDate("2026-12-01")).toBe("Dec 1");
  });
});

describe("groupNotionTasks", () => {
  const nrow = (id: string, title: string, due: string | null, owner: string | null = null) => ({ id, title, due, status: "Not started", owner, url: "" });
  it("groups by due date like local tasks and filters by title, owner or status", () => {
    const rows = [nrow("1", "later", "2026-12-05"), nrow("2", "late", "2026-11-01"), nrow("3", "today", "2026-11-20", "Sam"), nrow("4", "someday", null)];
    expect(groupNotionTasks(rows, "2026-11-20").map((g) => [g.id, g.rows.map((r) => r.title)])).toEqual([
      ["overdue", ["late"]], ["today", ["today"]], ["upcoming", ["later"]], ["none", ["someday"]],
    ]);
    expect(groupNotionTasks(rows, "2026-11-20", "sam").flatMap((g) => g.rows.map((r) => r.id))).toEqual(["3"]);
    expect(groupNotionTasks(rows, "2026-11-20", "zzz")).toEqual([]);
  });
});
