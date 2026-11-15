import { describe, expect, it } from "vitest";
import { filterFiles } from "./search";
import type { FileEntry } from "../types";

const f = (name: string, opened: number | null, path = `/docs/${name}`): FileEntry => ({
  id: name,
  canonical_path: path,
  display_name: name,
  registered_at: 0,
  last_opened_at: opened,
  is_open: false,
});

describe("filterFiles", () => {
  const files = [f("plan.md", null), f("roadmap.md", 5), f("notes.md", 9)];
  it("sorts recent first when no query", () => {
    expect(filterFiles(files, "").map((x) => x.id)).toEqual(["notes.md", "roadmap.md", "plan.md"]);
  });
  it("matches all terms against name and path", () => {
    expect(filterFiles(files, "DOCS road").map((x) => x.id)).toEqual(["roadmap.md"]);
    expect(filterFiles(files, "zzz")).toEqual([]);
  });
});
