import { createContext, useContext, useState, type ComponentProps, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkFrontmatter from "remark-frontmatter";
import { extractFrontmatter, parseFrontmatter, remarkObsidian } from "../../services/obsidian";
import type { ParsedDoc, TaskInfo } from "../../services/markdownParser";
import { TaskCheckbox } from "../TaskCheckbox/TaskCheckbox";
import { CodeBlock } from "./CodeBlock";
import "./markdown.css";

export interface MarkdownRendererProps {
  source: string;
  onOpenLink?: (url: string) => void;
  /** Called with the target of a clicked `[[wikilink]]`. Without it, wikilinks are plain styled text. */
  onOpenWikilink?: (target: string) => void;
  /** Parsed from the same source; enables interactive tasks and section progress. */
  doc?: ParsedDoc;
  onToggleTask?: (task: TaskInfo) => void;
  /** Disables checkboxes while a write is in flight. */
  busy?: boolean;
}

type RenderCtx = Pick<MarkdownRendererProps, "onOpenLink" | "onOpenWikilink" | "doc" | "onToggleTask" | "busy">;

// Components are module-level and read dynamic data from context, so React does not
// remount the whole tree (and lose focus or re-highlight code) on every update.
const RenderContext = createContext<RenderCtx>({});
const TaskContext = createContext<TaskInfo | undefined>(undefined);

function Img({ src, alt }: ComponentProps<"img">) {
  const [failed, setFailed] = useState(false);
  // Only https/data images are loadable (see CSP); anything else degrades to alt text.
  const loadable = typeof src === "string" && /^(https:|data:image\/)/i.test(src);
  if (!loadable || failed) return <span className="img-missing">🖼 {alt || "image unavailable"}</span>;
  return <img src={src} alt={alt ?? ""} loading="lazy" onError={() => setFailed(true)} />;
}

function Link({ href, children }: ComponentProps<"a">) {
  const { onOpenLink } = useContext(RenderContext);
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        if (href) onOpenLink?.(href);
      }}
    >
      {children}
    </a>
  );
}

function ListItem({ node, className, children }: ComponentProps<"li"> & { node?: { position?: { start: { offset?: number } } } }) {
  const { doc } = useContext(RenderContext);
  const offset = node?.position?.start.offset;
  const task = offset != null ? doc?.taskByItemOffset.get(offset) : undefined;
  return (
    <li className={className}>
      {task ? <TaskContext.Provider value={task}>{children}</TaskContext.Provider> : children}
    </li>
  );
}

function Checkbox({ checked }: ComponentProps<"input">) {
  const { onToggleTask, busy } = useContext(RenderContext);
  const task = useContext(TaskContext);
  const interactive = !!task && !!onToggleTask;
  return (
    <TaskCheckbox
      checked={!!checked}
      label={task?.text ?? ""}
      offset={task?.offset}
      disabled={!interactive || !!busy}
      onToggle={() => task && onToggleTask?.(task)}
    />
  );
}

function makeHeading(Tag: "h1" | "h2" | "h3" | "h4" | "h5" | "h6") {
  return function Heading({ node, children }: { node?: { position?: { start: { offset?: number } } }; children?: ReactNode }) {
    const { doc } = useContext(RenderContext);
    const offset = node?.position?.start.offset;
    const section = offset != null ? doc?.sections.get(offset) : undefined;
    return (
      <Tag>
        {children}
        {section && (
          <span className={section.done === section.total ? "section-progress complete" : "section-progress"} aria-label={`${section.done} of ${section.total} done`}>
            {section.done}/{section.total}
          </span>
        )}
      </Tag>
    );
  };
}

function Span({ className, children, ...rest }: ComponentProps<"span">) {
  const { onOpenWikilink } = useContext(RenderContext);
  const target = (rest as Record<string, unknown>)["data-target"];
  if (className === "wikilink" && typeof target === "string" && onOpenWikilink) {
    const open = () => onOpenWikilink(target);
    return (
      <span
        className="wikilink wikilink-live"
        role="link"
        tabIndex={0}
        title={`Open ${target}`}
        onClick={open}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            open();
          }
        }}
      >
        {children}
      </span>
    );
  }
  return <span className={className}>{children}</span>;
}

function Properties({ yaml }: { yaml: string }) {
  const entries = parseFrontmatter(yaml);
  if (!entries.length) return null;
  return (
    <dl className="properties" aria-label="Properties">
      {entries.map(({ key, value }) => (
        <div className="property" key={key}>
          <dt>{key}</dt>
          <dd>
            {Array.isArray(value)
              ? value.map((v, i) => (
                  <span className="property-chip" key={`${v}-${i}`}>
                    {v}
                  </span>
                ))
              : value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

const components: Components = {
  a: Link,
  span: Span,
  img: Img,
  li: ListItem,
  input: Checkbox,
  h1: makeHeading("h1"),
  h2: makeHeading("h2"),
  h3: makeHeading("h3"),
  h4: makeHeading("h4"),
  h5: makeHeading("h5"),
  h6: makeHeading("h6"),
  table({ children }) {
    return (
      <div className="table-scroll">
        <table>{children}</table>
      </div>
    );
  },
  pre({ children }) {
    return <>{children}</>;
  },
  code({ className, children }) {
    const text = String(children);
    const lang = /language-([\w-]+)/.exec(className ?? "")?.[1];
    // Fenced blocks carry a language class or contain newlines; otherwise inline code.
    if (lang || text.includes("\n")) return <CodeBlock code={text.replace(/\n$/, "")} lang={lang} />;
    return <code className="inline-code">{children}</code>;
  },
};

/** Theme-independent renderer: CommonMark + GFM + Obsidian-flavoured extras (properties, wikilinks, callouts, tags, highlights). Raw HTML is never rendered as HTML. */
export function MarkdownRenderer({ source, onOpenLink, onOpenWikilink, doc, onToggleTask, busy }: MarkdownRendererProps) {
  const frontmatter = extractFrontmatter(source);
  return (
    <RenderContext.Provider value={{ onOpenLink, onOpenWikilink, doc, onToggleTask, busy }}>
      <div className="markdown">
        {frontmatter !== null && <Properties yaml={frontmatter} />}
        <ReactMarkdown remarkPlugins={[remarkFrontmatter, remarkGfm, remarkObsidian]} components={components}>
          {source}
        </ReactMarkdown>
      </div>
    </RenderContext.Provider>
  );
}
