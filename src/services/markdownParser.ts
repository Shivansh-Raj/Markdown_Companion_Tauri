import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkFrontmatter from "remark-frontmatter";
import type { Root, RootContent } from "mdast";

export interface TaskInfo {
  /** UTF-16 offset of the `[` of the `[ ]`/`[x]` marker in the source. */
  offset: number;
  /** UTF-16 offset where the owning list item starts (used to match rendered <li>). */
  itemOffset: number;
  checked: boolean;
  text: string;
}

export interface SectionProgress {
  done: number;
  total: number;
}

export interface ParsedDoc {
  tasks: TaskInfo[];
  taskByItemOffset: Map<number, TaskInfo>;
  /** Keyed by heading start offset; includes tasks in nested sub-sections. */
  sections: Map<number, SectionProgress>;
  done: number;
  total: number;
}

const processor = unified().use(remarkParse).use(remarkFrontmatter).use(remarkGfm);
const MARKER_PREFIX = /^(?:[-*+]|\d{1,9}[.)])[ \t]+\[/;

type AnyNode = Root | RootContent;

function plainText(node: AnyNode): string {
  if ("value" in node && typeof node.value === "string") return node.value;
  if ("children" in node) return (node.children as AnyNode[]).map(plainText).join("");
  return "";
}

/** Parses with the same CommonMark+GFM pipeline as the renderer, keeping source positions. */
export function parseDocument(source: string): ParsedDoc {
  const tree = processor.parse(source) as Root;
  const tasks: TaskInfo[] = [];
  const headings: { depth: number; offset: number }[] = [];

  const walk = (node: AnyNode) => {
    if (node.type === "heading" && node.position?.start.offset != null) {
      headings.push({ depth: node.depth, offset: node.position.start.offset });
    } else if (node.type === "listItem" && node.checked != null && node.position?.start.offset != null) {
      const itemOffset = node.position.start.offset;
      const prefix = MARKER_PREFIX.exec(source.slice(itemOffset, itemOffset + 24));
      if (prefix) {
        const offset = itemOffset + prefix[0].length - 1;
        if (/^\[[ xX]\]$/.test(source.slice(offset, offset + 3))) {
          const first = node.children[0];
          tasks.push({
            offset,
            itemOffset,
            checked: node.checked === true,
            text: first?.type === "paragraph" ? plainText(first).trim() : "",
          });
        }
      }
    }
    if ("children" in node) (node.children as AnyNode[]).forEach(walk);
  };
  walk(tree);

  const sections = new Map<number, SectionProgress>();
  headings.forEach((h, i) => {
    const next = headings.slice(i + 1).find((n) => n.depth <= h.depth);
    const end = next ? next.offset : Infinity;
    const inSection = tasks.filter((t) => t.itemOffset >= h.offset && t.itemOffset < end);
    if (inSection.length) {
      sections.set(h.offset, { total: inSection.length, done: inSection.filter((t) => t.checked).length });
    }
  });

  return {
    tasks,
    taskByItemOffset: new Map(tasks.map((t) => [t.itemOffset, t])),
    sections,
    done: tasks.filter((t) => t.checked).length,
    total: tasks.length,
  };
}

export interface SectionInfo {
  title: string;
  depth: number;
  /** UTF-16 range of the heading line through the end of its sub-sections. */
  start: number;
  end: number;
}

/** Heading-delimited sections (a section includes its nested sub-sections). Headings in code fences are ignored. */
export function listSections(source: string): SectionInfo[] {
  const tree = processor.parse(source) as Root;
  const heads: { title: string; depth: number; start: number }[] = [];
  const walk = (node: AnyNode) => {
    if (node.type === "heading" && node.position?.start.offset != null) {
      heads.push({ title: plainText(node).trim(), depth: node.depth, start: node.position.start.offset });
    }
    if ("children" in node) (node.children as AnyNode[]).forEach(walk);
  };
  walk(tree);
  return heads.map((h, i) => {
    const next = heads.slice(i + 1).find((n) => n.depth <= h.depth);
    return { ...h, end: next ? next.start : source.length };
  });
}
