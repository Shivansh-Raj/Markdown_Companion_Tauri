import { extractFrontmatter } from "./markdownExtras";

export interface NotionDraft {
  title: string;
  markdown: string;
  /** Things the user should know about before sending; shown above the SEND button. */
  notes: string[];
}

const FENCE = /^---[ \t]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

/**
 * Prepares a local note for a new Notion page. Nothing is dropped silently: frontmatter becomes a visible `yaml`
 * code block (property mapping comes later), and the notes list what Notion will show differently.
 */
export function prepareForNotion(source: string, fallbackTitle: string): NotionDraft {
  const text = source.replace(/^﻿/, "");
  const notes: string[] = [];
  const yaml = extractFrontmatter(text);
  let body = text;
  let titleFromYaml: string | null = null;
  if (yaml !== null) {
    body = text.replace(FENCE, "");
    const m = /^title:\s*(.+)$/m.exec(yaml);
    titleFromYaml = m ? m[1].trim().replace(/^["']|["']$/g, "") : null;
    body = "```yaml\n" + yaml.trimEnd() + "\n```\n\n" + body.replace(/^\s+/, "");
    notes.push("The frontmatter is kept as a code block at the top. It does not become Notion properties yet.");
  }
  const heading = /^#\s+(.+?)\s*$/m.exec(yaml !== null ? body.replace(/^```yaml[\s\S]*?```\n\n/, "") : body);
  const title = titleFromYaml || heading?.[1].replace(/[#*_`]/g, "").trim() || fallbackTitle;
  const links = (body.match(/(?<!!)\[\[[^\]\n]+\]\]/g) ?? []).length;
  if (links > 0) notes.push(`${links} [[wikilink]]${links === 1 ? "" : "s"} will show as plain text. Notion has no equivalent.`);
  if (/!\[\[[^\]\n]+\]\]/.test(body)) notes.push("Embedded notes (![[…]]) will show as plain text.");
  if (/^> \[![\w-]+\]/m.test(body)) notes.push("Callouts will show as quotes.");
  return { title, markdown: body, notes };
}
