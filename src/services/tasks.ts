import { wikilinkLabel } from "./markdownExtras";
import type { NotionTask, TaskRow } from "../types";

export type TaskGroupId = "overdue" | "today" | "upcoming" | "none";

export const GROUP_LABELS: Record<TaskGroupId, string> = {
  overdue: "OVERDUE",
  today: "TODAY",
  upcoming: "UPCOMING",
  none: "NO DATE",
};

const ORDER: TaskGroupId[] = ["overdue", "today", "upcoming", "none"];

/** Local calendar date as YYYY-MM-DD. */
export function localDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function groupOf(due: string | null, today: string): TaskGroupId {
  if (!due) return "none";
  return due < today ? "overdue" : due === today ? "today" : "upcoming";
}

/** `[[Folder/Note#Part|shown]]` shows as `shown`, so task titles read as text. */
export function plainTitle(title: string): string {
  return title.replace(/\[\[([^\]\n]+)\]\]/g, (_m, inner: string) => wikilinkLabel(inner));
}

export function matches(row: TaskRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || plainTitle(row.title).toLowerCase().includes(q) || row.note.toLowerCase().includes(q);
}

export interface TaskGroup {
  id: TaskGroupId;
  rows: TaskRow[];
}

/** Groups by due date (overdue first), each group ordered by date, then note, then position in the note. */
export function groupTasks(rows: TaskRow[], today: string, query = ""): TaskGroup[] {
  const groups = new Map<TaskGroupId, TaskRow[]>(ORDER.map((id) => [id, []]));
  for (const r of rows.filter((r) => matches(r, query))) groups.get(groupOf(r.due, today))!.push(r);
  const cmp = (a: TaskRow, b: TaskRow) =>
    (a.due ?? "").localeCompare(b.due ?? "") || a.note.localeCompare(b.note) || a.line - b.line;
  return ORDER.map((id) => ({ id, rows: groups.get(id)!.sort(cmp) })).filter((g) => g.rows.length > 0);
}

/** "Dec 1" for a YYYY-MM-DD date (no time zone maths: it is just a calendar date). */
export function shortDate(due: string): string {
  const [, m, d] = due.split("-").map(Number);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[m - 1] ?? "?"} ${d}`;
}

export interface NotionTaskGroup {
  id: TaskGroupId;
  rows: NotionTask[];
}

/** Notion tasks grouped like local ones: overdue, today, upcoming, no date. Within a group: by date, then title. */
export function groupNotionTasks(rows: NotionTask[], today: string, query = ""): NotionTaskGroup[] {
  const q = query.trim().toLowerCase();
  const keep = (r: NotionTask) => !q || [r.title, r.owner ?? "", r.status ?? ""].some((s) => s.toLowerCase().includes(q));
  const groups = new Map<TaskGroupId, NotionTask[]>(ORDER.map((id) => [id, []]));
  for (const r of rows.filter(keep)) groups.get(groupOf(r.due, today))!.push(r);
  const cmp = (a: NotionTask, b: NotionTask) => (a.due ?? "").localeCompare(b.due ?? "") || a.title.localeCompare(b.title);
  return ORDER.map((id) => ({ id, rows: groups.get(id)!.sort(cmp) })).filter((g) => g.rows.length > 0);
}
