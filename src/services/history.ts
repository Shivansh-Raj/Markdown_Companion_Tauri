const KEY = "mdc-ai-history";
const MAX = 8;

export function loadHistory(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, MAX) : [];
  } catch {
    return [];
  }
}

/** Most recent first, no duplicates, capped. Returns the new list. */
export function pushHistory(list: string[], entry: string): string[] {
  const clean = entry.trim();
  if (!clean) return list;
  const next = [clean, ...list.filter((x) => x !== clean)].slice(0, MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* not persisted */
  }
  return next;
}
