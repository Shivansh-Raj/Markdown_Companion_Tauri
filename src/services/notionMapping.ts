import type { NotionField, NotionMapEntry, NotionProp } from "../types";

/** Mirrors the Rust rule: which Notion property types a field can fill. */
export function fits(field: NotionField, prop: NotionProp): boolean {
  switch (field.kind) {
    case "text": return ["rich_text", "select", "status", "url"].includes(prop.type);
    case "number": return ["number", "rich_text"].includes(prop.type);
    case "date": return ["date", "rich_text"].includes(prop.type);
    case "list": return ["multi_select", "rich_text"].includes(prop.type);
    case "relation": return prop.type === "relation";
  }
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * A first guess for the mapping: a property whose name matches the field's name or label and that fits. It is only
 * a suggestion; the user sees it and can change it. Each property is used for at most one field.
 */
export function suggestMapping(fields: NotionField[], props: NotionProp[]): NotionMapEntry[] {
  const used = new Set<string>();
  const out: NotionMapEntry[] = [];
  for (const f of fields) {
    const names = [norm(f.key), norm(f.label), ...(f.key === "duration_min" ? ["duration", "minutes", "length"] : []), ...(f.key === "due" ? ["duedate", "deadline"] : [])];
    const hit = props.find((p) => p.type !== "title" && !used.has(p.name) && fits(f, p) && names.includes(norm(p.name)));
    if (hit) {
      used.add(hit.name);
      out.push({ field: f.key, property: hit.name });
    }
  }
  return out;
}

/** Example values for the preview, shaped like what the real export sends. */
export function sampleValues(destination: string): Record<string, unknown> {
  const today = new Date().toISOString().slice(0, 10);
  if (destination === "practice") return { date: today, duration_min: 4.5, words: 620, pace_wpm: 138, speaking_wpm: 151, filler_count: 9, fillers_per_100_words: 1.5, long_pauses: 2 };
  if (destination === "tasks") return { due: today, status: "Not started", owner: "Sam" };
  return { date: today, type: "meeting", duration_min: 12.5, tags: ["voice", "meeting"], project: "Apollo", source: "Markdown Companion" };
}
