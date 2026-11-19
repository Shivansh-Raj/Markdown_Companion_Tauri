import { dateStamp } from "./transcript";
import type { ActionItem } from "./analyses";
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

/** One task row to create from an action item. */
export interface TaskRow {
  /** Identifies the item for "already sent" tracking: the same wording in the same recording is the same task. */
  key: string;
  title: string;
  body: string;
  values: Record<string, unknown>;
  /** Shown beside the item so the user sees what will be filled in. */
  summary: string;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

const normalise = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Task rows for the action items. A due date is filled only when the item's deadline is already a real date; wording such
 * as "by Friday" is kept as text in the page, never turned into a date we are guessing. The owner is written as text
 * only if the recording named one. `meetingPageId` links each task to the meeting's row, when it was saved as one.
 */
export function taskRowsFor(items: ActionItem[], meetingPageId: string | null): TaskRow[] {
  return items
    .filter((i) => i.task.trim())
    .map((i) => {
      const title = i.task.replace(/\s*\n\s*/g, " ").trim().slice(0, 2000);
      const deadline = i.deadline?.trim() ?? "";
      const values: Record<string, unknown> = { status: "Not started" };
      if (ISO_DAY.test(deadline)) values.due = deadline;
      if (i.owner?.trim()) values.owner = i.owner.trim();
      if (meetingPageId) values.meeting = meetingPageId;
      const lines: string[] = [];
      if (deadline && !ISO_DAY.test(deadline)) lines.push(`Due: ${deadline}`);
      if (i.context?.trim()) lines.push(`Context: ${i.context.trim()}`);
      const bits = [values.due ? `due ${values.due}` : deadline ? `due “${deadline}” (in the page)` : "", values.owner ? `owner ${values.owner}` : ""].filter(Boolean);
      return { key: normalise(i.task), title, body: lines.join("\n\n"), values, summary: bits.join(" · ") };
    });
}
