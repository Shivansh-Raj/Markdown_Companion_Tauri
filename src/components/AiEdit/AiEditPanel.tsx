import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../services/api";
import { streamChat } from "../../services/ai";
import {
  MAX_EDIT_CHARS,
  buildEditSystemPrompt,
  buildEditUserPrompt,
  buildEditedDocument,
  scopeText,
  sectionsOf,
  type EditScope,
  type TextRange,
} from "../../services/aiEdit";
import { diffLines, hasChanges, withContext } from "../../services/diff";
import { loadHistory, pushHistory } from "../../services/history";
import { TypingCat } from "../AiCreate/TypingCat";

const QUICK_ACTIONS: [string, string][] = [
  ["Shorten", "Make this more concise without losing any meaning."],
  ["Fix grammar", "Fix spelling and grammar. Do not change the meaning or structure."],
  ["Add subtasks", "Break each task into 2-4 smaller subtasks as nested checkboxes."],
  ["Reorder by priority", "Reorder the items by priority, most important first."],
];

type Phase = "input" | "generating" | "review";
const isMac = typeof navigator !== "undefined" && /mac/i.test(navigator.platform);

interface Props {
  /** Text currently shown (the edit draft if editing, else the file). */
  content: string;
  /** Hash of the file on disk right now; used to refuse results computed from an outdated file. */
  currentHash: string | undefined;
  /** Text the user highlighted when opening the panel (offsets into `content`), if any. */
  selection: TextRange | null;
  onApply: (next: string) => void;
  onClose: () => void;
}

export function AiEditPanel({ content, currentHash, selection, onApply, onClose }: Props) {
  const sections = useMemo(() => sectionsOf(content), [content]);
  const [scopeKind, setScopeKind] = useState<"selection" | "section" | "whole">(selection ? "selection" : sections.length ? "section" : "whole");
  const [sectionIdx, setSectionIdx] = useState(0);
  const [instruction, setInstruction] = useState("");
  const [phase, setPhase] = useState<Phase>("input");
  const [chars, setChars] = useState(0);
  const [live, setLive] = useState("");
  const [history, setHistory] = useState<string[]>(loadHistory);
  const liveRef = useRef<HTMLPreElement>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const startHash = useRef<string | undefined>(undefined);
  const startContent = useRef("");

  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    if (liveRef.current) liveRef.current.scrollTop = liveRef.current.scrollHeight;
  }, [live]);

  const scope: EditScope =
    scopeKind === "selection" && selection
      ? { kind: "selection", range: selection }
      : scopeKind === "section" && sections[sectionIdx] ? { kind: "section", section: sections[sectionIdx] } : { kind: "whole" };

  const generate = async () => {
    if (!instruction.trim()) return;
    setError(null);
    const text = scopeText(content, scope);
    if (text.length > MAX_EDIT_CHARS) {
      setError(`That is too long for one AI edit (${text.length.toLocaleString()} characters, max ${MAX_EDIT_CHARS.toLocaleString()}). Pick a smaller section.`);
      return;
    }
    let apiKey: string | null;
    try {
      apiKey = await api.getGroqKey();
    } catch (e) {
      setError(String(e));
      return;
    }
    if (!apiKey) {
      setError("No Groq API key yet. Open the launcher, choose NEW WITH AI and set it with the KEY button.");
      return;
    }
    setHistory((h) => pushHistory(h, instruction));
    setLive("");
    startHash.current = currentHash;
    startContent.current = content;
    setPhase("generating");
    setChars(0);
    const ctl = new AbortController();
    abort.current = ctl;
    try {
      const out = await streamChat({
        apiKey,
        system: buildEditSystemPrompt(scope.kind),
        user: buildEditUserPrompt(instruction, text),
        signal: ctl.signal,
        onText: (t) => {
          setChars(t.length);
          setLive(t);
        },
      });
      if (!out.trim()) throw new Error("The AI returned nothing. Try rephrasing the instruction.");
      setResult(buildEditedDocument(startContent.current, scope, out));
      setPhase("review");
    } catch (e) {
      if (!ctl.signal.aborted) setError(e instanceof Error ? e.message : String(e));
      setPhase("input");
    } finally {
      abort.current = null;
    }
  };

  const rows = useMemo(
    () => (result === null ? [] : withContext(diffLines(startContent.current, result), 2)),
    [result],
  );
  const changed = hasChanges(rows);

  const apply = () => {
    if (result === null) return;
    if (startHash.current !== currentHash) {
      setError("The file changed on disk while the AI was working, so this result was not applied. Run the edit again.");
      return;
    }
    onApply(result);
  };

  return (
    <div
      className="ai aiedit"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          if (phase === "generating") abort.current?.abort();
          else if (phase === "review") setPhase("input");
          else onClose();
        }
      }}
    >
      {phase === "input" && (
        <div className="ai-form">
          <h2>AI EDIT</h2>
          <fieldset className="scope">
            <legend>Scope</legend>
            <label>
              <input type="radio" name="scope" checked={scopeKind === "selection"} disabled={!selection} onChange={() => setScopeKind("selection")} />
              My selected text
            </label>
            {scopeKind === "selection" && selection && (
              <blockquote className="sel-preview">{content.slice(selection.start, selection.end).slice(0, 160)}{selection.end - selection.start > 160 ? "…" : ""}</blockquote>
            )}
            {!selection && (
              <p className="note" style={{ margin: "0 0 4px 22px" }}>
                To use this, highlight text in EDIT mode (or in the preview, if it appears only once), then click AI.
              </p>
            )}
            <label>
              <input type="radio" name="scope" checked={scopeKind === "section"} disabled={!sections.length} onChange={() => setScopeKind("section")} />
              A heading section
            </label>
            {scopeKind === "section" && (
              <select
                aria-label="Section to edit"
                value={sectionIdx}
                onChange={(e) => setSectionIdx(Number(e.target.value))}
              >
                {sections.map((s, i) => (
                  <option key={s.start} value={i}>
                    {"  ".repeat(s.depth - 1)}
                    {s.title || "(untitled)"}
                  </option>
                ))}
              </select>
            )}
            <label>
              <input type="radio" name="scope" checked={scopeKind === "whole"} onChange={() => setScopeKind("whole")} />
              Whole file
            </label>
          </fieldset>
          <textarea
            className="ai-prompt"
            autoFocus
            placeholder={scopeKind !== "whole" ? "e.g. Add a rollback step and shorten the wording" : "e.g. Reorder by priority"}
            aria-label="What should change?"
            value={instruction}
            maxLength={2000}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void generate();
              }
            }}
          />
          <div className="chips" role="group" aria-label="Quick actions">
            {QUICK_ACTIONS.map(([label, text]) => (
              <button key={label} className="chip" onClick={() => setInstruction(text)}>{label}</button>
            ))}
          </div>
          {history.length > 0 && (
            <div className="chips" role="group" aria-label="Recent instructions">
              <span className="chips-label">Recent</span>
              {history.map((h) => (
                <button key={h} className="chip recent" title={h} onClick={() => setInstruction(h)}>
                  {h.length > 28 ? h.slice(0, 27) + "…" : h}
                </button>
              ))}
            </div>
          )}
          <p className="note">Completed tasks stay completed. Nothing is saved until you press SAVE.</p>
          <div className="ai-actions">
            <button className="btn primary" disabled={!instruction.trim()} onClick={() => void generate()}>✎ EDIT</button>
            <button className="btn" onClick={onClose}>CANCEL</button>
            <span className="hint">{isMac ? "⌘" : "Ctrl+"}Enter</span>
          </div>
        </div>
      )}

      {phase === "generating" && (
        <div className="ai-form">
          <div className="ai-status" style={{ justifyContent: "flex-start" }}>
            <TypingCat label={scope.kind === "whole" ? "Editing file" : "Editing selection"} />
          </div>
          <pre className="live" ref={liveRef} aria-label="AI output so far">{live}<span className="ai-caret" aria-hidden="true" /></pre>
          <div className="ai-actions">
            <button className="btn" onClick={() => abort.current?.abort()}>■ STOP</button>
            <span className="hint">{chars.toLocaleString()} characters</span>
          </div>
        </div>
      )}

      {phase === "review" && (
        <>
          <div className="editbar">
            <button className="btn primary" disabled={!changed} onClick={apply}>APPLY</button>
            <button className="btn" onClick={() => setPhase("input")}>TRY AGAIN</button>
            <button className="btn" onClick={onClose}>DISCARD</button>
          </div>
          <div className="ai-status" style={{ justifyContent: "flex-start", padding: "6px 10px 0" }}>
            <TypingCat mood="waiting" label={changed ? "Looks right? Apply or discard" : "The AI changed nothing"} />
          </div>
          <div className="diff" role="region" aria-label="Proposed changes" tabIndex={0}>
            {!changed && <div className="diff-empty">The AI made no changes.</div>}
            {rows.map((r, i) =>
              r.kind === "gap" ? (
                <div key={i} className="diff-row gap">⋯ {r.hidden} unchanged line{r.hidden === 1 ? "" : "s"}</div>
              ) : (
                <div key={i} className={`diff-row ${r.kind}`} style={{ "--i": Math.min(i, 20) } as React.CSSProperties}>
                  <span className="sign" aria-hidden="true">{r.kind === "add" ? "+" : r.kind === "del" ? "−" : " "}</span>
                  <span className="sr-only">{r.kind === "add" ? "added: " : r.kind === "del" ? "removed: " : ""}</span>
                  <span className="txt">{r.text || " "}</span>
                </div>
              ),
            )}
          </div>
        </>
      )}
      {error && <div className="error" role="alert">{error}</div>}
    </div>
  );
}
