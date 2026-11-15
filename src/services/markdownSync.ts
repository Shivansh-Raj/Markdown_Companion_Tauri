import type { FileSnapshot, FileStatus, SyncEvent, ToggleError } from "../types";
import type { ParsedDoc, TaskInfo } from "./markdownParser";

/** Mirrors the native edit: swaps only the 3-char marker at `offset`. Used for optimistic UI. */
export function applyToggle(source: string, offset: number, checked: boolean): string {
  const found = source.slice(offset, offset + 3);
  const ok = checked ? found === "[ ]" : found === "[x]" || found === "[X]";
  if (!ok) throw new Error("Task marker not found at the expected position");
  return source.slice(0, offset) + (checked ? "[x]" : "[ ]") + source.slice(offset + 3);
}

/** Native code works in UTF-8 bytes; JS offsets are UTF-16 code units. */
export function utf8Offset(source: string, utf16Offset: number): number {
  return new TextEncoder().encode(source.slice(0, utf16Offset)).length;
}

export type ToggleOutcome =
  | { ok: true; snapshot: FileSnapshot }
  | { ok: false; snapshot: FileSnapshot | null; message: string };

/** Maps a native toggle failure to what the UI should show and which content to display. */
export function describeToggleError(err: unknown): { snapshot: FileSnapshot | null; message: string } {
  const e = err as Partial<ToggleError> | undefined;
  if (e && e.kind === "stale" && "content" in e && "hash" in e) {
    return {
      snapshot: { content: e.content as string, hash: e.hash as string },
      message: "The file changed on disk, so that task was not updated. The view has been refreshed.",
    };
  }
  const message = e && e.kind === "failed" && "message" in e ? String(e.message) : String(err);
  return { snapshot: null, message: `Could not save: ${message}` };
}

/** The fresh file version when a native toggle was refused because the file changed. */
export function staleSnapshot(err: unknown): FileSnapshot | null {
  const e = err as Partial<ToggleError> | undefined;
  return e && e.kind === "stale" && "content" in e && "hash" in e
    ? { content: e.content as string, hash: e.hash as string }
    : null;
}

export type Resolution =
  | { action: "retry"; task: TaskInfo }
  | { action: "satisfied" }
  | { action: "ambiguous" };

/**
 * After the file changed under a pending click, decide whether the intended task can be
 * identified unambiguously in the new version. Identity is the task's text: it must occur
 * exactly once. Otherwise nothing is written.
 */
export function resolveTaskAfterChange(fresh: ParsedDoc, task: TaskInfo, desired: boolean): Resolution {
  if (!task.text) return { action: "ambiguous" };
  const matches = fresh.tasks.filter((t) => t.text === task.text);
  if (matches.length !== 1) return { action: "ambiguous" };
  return matches[0].checked === desired ? { action: "satisfied" } : { action: "retry", task: matches[0] };
}

/** Folds a native sync event into the file status shown to the user. */
export function statusFromEvent(ev: SyncEvent): FileStatus {
  return ev.kind === "changed" ? { kind: "ok" } : ev.kind === "missing" ? { kind: "missing" } : ev;
}
