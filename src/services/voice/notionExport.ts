import { dateStamp } from "./transcript";
import type { ExtraProperties } from "./templates";
import type { SessionMeta } from "./types";

/** Where a voice session goes in Notion: a database (when one is set up for it) or a section page under the home page. */
export interface NotionTarget {
  /** Destination key for the database ("meetings" | "practice"), and the section page used when there is no database. */
  key: "meetings" | "practice" | "notes";
  section: "meetings" | "practice" | "notes";
  label: string;
}

export function notionTargetFor(meta: SessionMeta): NotionTarget {
  if (meta.mode === "practice") return { key: "practice", section: "practice", label: "Practice sessions" };
  if (meta.mode === "meeting") return { key: "meetings", section: "meetings", label: "Meetings" };
  return { key: "notes", section: "notes", label: "Notes" };
}

/** Values for the mapped columns. The field keys match the database destinations in Notion settings. */
export function notionValues(meta: SessionMeta, extra: ExtraProperties = {}): Record<string, unknown> {
  return {
    date: dateStamp(meta.createdAtMs),
    type: meta.mode,
    duration_min: Math.round((meta.durationMs / 60000) * 10) / 10,
    tags: ["voice", meta.mode],
    source: "Markdown Companion",
    ...extra,
  };
}
