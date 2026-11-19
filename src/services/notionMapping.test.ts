import { describe, expect, it } from "vitest";
import { fits, suggestMapping } from "./notionMapping";
import type { NotionField, NotionProp } from "../types";

const f = (key: string, label: string, kind: NotionField["kind"]): NotionField => ({ key, label, kind });
const p = (name: string, type: string): NotionProp => ({ id: name, name, type, options: [] });

describe("notion mapping", () => {
  it("knows which property types a field can fill", () => {
    expect(fits(f("date", "Date", "date"), p("When", "date"))).toBe(true);
    expect(fits(f("date", "Date", "date"), p("When", "number"))).toBe(false);
    expect(fits(f("tags", "Tags", "list"), p("Labels", "multi_select"))).toBe(true);
    expect(fits(f("meeting", "Meeting page", "relation"), p("Meeting", "relation"))).toBe(true);
  });

  it("suggests properties by name and never reuses one", () => {
    const fields = [f("date", "Date", "date"), f("duration_min", "Duration (minutes)", "number"), f("tags", "Tags", "list"), f("project", "Project", "text")];
    const props = [p("Name", "title"), p("Date", "date"), p("Duration", "number"), p("Tags", "multi_select"), p("Project", "select"), p("Other", "rich_text")];
    expect(suggestMapping(fields, props)).toEqual([
      { field: "date", property: "Date" }, { field: "duration_min", property: "Duration" },
      { field: "tags", property: "Tags" }, { field: "project", property: "Project" },
    ]);
  });

  it("does not suggest a property of the wrong type or the title", () => {
    expect(suggestMapping([f("date", "Date", "date")], [p("Date", "number"), p("Name", "title")])).toEqual([]);
  });
});
