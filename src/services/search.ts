export interface Searchable {
  display_name: string;
  canonical_path: string;
  last_opened_at?: number | null;
}

/** Filters by name/path (case-insensitive, all terms must match); recent files first. */
export function filterFiles<T extends Searchable>(files: T[], query: string): T[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return files
    .filter((f) => {
      const hay = `${f.display_name} ${f.canonical_path}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    })
    .sort(
      (a, b) =>
        (b.last_opened_at ?? 0) - (a.last_opened_at ?? 0) ||
        a.display_name.localeCompare(b.display_name),
    );
}
