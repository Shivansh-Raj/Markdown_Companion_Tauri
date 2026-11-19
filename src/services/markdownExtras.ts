import type { Root, RootContent, Parent, Text, PhrasingContent } from "mdast";

/**
 * Extended Markdown support (frontmatter properties, wikilinks, callouts, highlights, tags), implemented as pure functions plus a remark
 * plugin that only rewrites the syntax tree. The source text is never changed, so the source
 * offsets used for task toggling and section progress stay valid.
 */

export type FrontmatterValue = string | string[];
export interface FrontmatterEntry {
  key: string;
  value: FrontmatterValue;
}

type AnyNode = Root | RootContent | PhrasingContent;

const unquote = (s: string): string => {
  const t = s.trim();
  return t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'"))) ? t.slice(1, -1) : t;
};

/** Parses a flat YAML subset: `key: value`, `key: [a, b]` and block lists. Nested maps are shown as text. */
export function parseFrontmatter(yaml: string): FrontmatterEntry[] {
  const entries: FrontmatterEntry[] = [];
  let current: { key: string; items: string[] } | null = null;
  const flush = () => {
    if (current) entries.push({ key: current.key, value: current.items });
    current = null;
  };
  for (const raw of yaml.split(/\r?\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue;
    const item = /^\s+-\s+(.*)$/.exec(raw) ?? /^-\s+(.*)$/.exec(raw);
    if (item && current) {
      current.items.push(unquote(item[1]));
      continue;
    }
    const kv = /^([^\s:#][^:]*?):(?:\s+(.*))?$/.exec(raw);
    if (!kv || /^\s/.test(raw)) continue; // indented continuation / nested map: ignore
    flush();
    const key = kv[1].trim();
    const rest = (kv[2] ?? "").trim();
    if (rest === "") {
      current = { key, items: [] };
    } else if (rest.startsWith("[") && rest.endsWith("]")) {
      const inner = rest.slice(1, -1).trim();
      entries.push({ key, value: inner ? inner.split(",").map(unquote).filter(Boolean) : [] });
    } else {
      entries.push({ key, value: unquote(rest) });
    }
  }
  flush();
  // A key with no value and no list items carries nothing to show.
  return entries.filter((e) => (Array.isArray(e.value) ? e.value.length > 0 : e.value !== ""));
}

/** Splits `[[target#heading|alias]]` into what to show. */
export function wikilinkLabel(inner: string): string {
  const [target, alias] = inner.split("|");
  if (alias?.trim()) return alias.trim();
  const [file, heading] = target.split("#");
  const name = file.trim().split("/").pop() ?? "";
  const h = heading?.trim();
  return name && h ? `${name} › ${h}` : name || (h ?? "");
}

const INLINE =
  /%%[\s\S]*?%%|!\[\[([^\]\n]+)\]\]|\[\[([^\]\n]+)\]\]|==([^=\s](?:[^\n]*?[^=\s])?)==|(^|[\s(])#((?=[\w/-]*[A-Za-z_])[\w/-]+)/g;
const TRAILING_BLOCK_ID = /[ \t]+\^[A-Za-z0-9-]+$/;
const CALLOUT = /^\[!([\w-]+)\]([+-])?[ \t]*([^\n]*)(?:\n([\s\S]*))?$/;

const span = (cls: string, value: string, tag = "span", extra: Record<string, string> = {}): PhrasingContent =>
  ({
    type: "emphasis",
    children: [{ type: "text", value }],
    data: { hName: tag, hProperties: { className: [cls], ...extra } },
  }) as PhrasingContent;

/** The link target without alias: `Folder/Note#Heading|shown` -> `Folder/Note#Heading`. */
export const wikilinkTarget = (inner: string): string => inner.split("|")[0].trim();

function transformText(node: Text, isLastInParagraph: boolean): PhrasingContent[] | null {
  let value = node.value;
  if (isLastInParagraph) value = value.replace(TRAILING_BLOCK_ID, "");
  const out: PhrasingContent[] = [];
  let last = 0;
  let changed = value !== node.value;
  for (const m of value.matchAll(INLINE)) {
    changed = true;
    const idx = m.index ?? 0;
    if (m[0].startsWith("%%")) {
      if (idx > last) out.push({ type: "text", value: value.slice(last, idx) });
    } else if (m[1] !== undefined) {
      if (idx > last) out.push({ type: "text", value: value.slice(last, idx) });
      out.push(span("embed", `⧉ ${wikilinkLabel(m[1])}`));
    } else if (m[2] !== undefined) {
      if (idx > last) out.push({ type: "text", value: value.slice(last, idx) });
      out.push(span("wikilink", wikilinkLabel(m[2]), "span", { "data-target": wikilinkTarget(m[2]) }));
    } else if (m[3] !== undefined) {
      if (idx > last) out.push({ type: "text", value: value.slice(last, idx) });
      out.push(span("highlight", m[3], "mark"));
    } else {
      // tag: keep the leading whitespace/paren as plain text
      const prefix = m[4] ?? "";
      if (idx + prefix.length > last) out.push({ type: "text", value: value.slice(last, idx + prefix.length) });
      out.push(span("tag", `#${m[5]}`));
    }
    last = idx + m[0].length;
  }
  if (!changed) return null;
  if (last < value.length) out.push({ type: "text", value: value.slice(last) });
  return out;
}

function calloutFrom(bq: Parent): void {
  const first = bq.children[0];
  if (!first || first.type !== "paragraph") return;
  const lead = first.children[0];
  if (!lead || lead.type !== "text") return;
  const m = CALLOUT.exec(lead.value);
  if (!m) return;
  const type = m[1].toLowerCase();
  const title = m[3].trim() || type.charAt(0).toUpperCase() + type.slice(1);
  const rest: PhrasingContent[] = [];
  if (m[4]) rest.push({ type: "text", value: m[4] });
  rest.push(...first.children.slice(1));
  const titleNode = {
    type: "paragraph",
    children: [{ type: "text", value: title }],
    data: { hProperties: { className: ["callout-title"] } },
  } as RootContent;
  const replacement: RootContent[] = [titleNode];
  if (rest.length) replacement.push({ type: "paragraph", children: rest });
  bq.children.splice(0, 1, ...replacement);
  (bq as unknown as { data: object }).data = {
    hProperties: { className: ["callout", `callout-${type}`], "data-callout": type },
  };
}

function walk(node: AnyNode): void {
  // Code, links and raw HTML must stay literal.
  if (node.type === "code" || node.type === "inlineCode" || node.type === "link" || node.type === "html") return;
  if (!("children" in node)) return;
  const parent = node as Parent;
  if (parent.type === "blockquote") calloutFrom(parent);
  const kids = parent.children as AnyNode[];
  for (let i = 0; i < kids.length; i++) {
    const child = kids[i];
    if (child.type === "text") {
      const repl = transformText(child, parent.type === "paragraph" && i === kids.length - 1);
      if (repl) {
        kids.splice(i, 1, ...repl);
        i += repl.length - 1;
      }
    } else {
      walk(child);
    }
  }
}

const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

/** Raw YAML of a leading frontmatter block, or null. Matches what remark-frontmatter treats as `yaml`. */
export function extractFrontmatter(source: string): string | null {
  return FRONTMATTER.exec(source.replace(/^\uFEFF/, ""))?.[1] ?? null;
}

/**
 * Remark plugin. The `yaml` node (from remark-frontmatter) is removed so it never renders as
 * text; the renderer shows it separately as properties.
 */
export function remarkExtras() {
  return (tree: Root) => {
    tree.children = tree.children.filter((n) => (n as { type: string }).type !== "yaml");
    walk(tree);
  };
}
