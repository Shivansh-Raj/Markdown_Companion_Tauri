import { useEffect, useRef, useState } from "react";
import { streamChat } from "../../services/ai";
import {
  MAX_IDEA, MAX_INSTRUCTION, MAX_PROMPT, REFINE_ACTIONS,
  cleanPrompt, generateRequest, refineRequest,
} from "../../services/aiPrompt";
import type { ReceiptRequest } from "../../services/receipt";
import { useReceipt } from "../Receipt/ReceiptProvider";
import { TypingCat } from "./TypingCat";

const isMac = typeof navigator !== "undefined" && /mac/i.test(navigator.platform);

/**
 * Disposable prompt builder. Nothing here is saved: the prompt lives only in this component, so leaving or
 * discarding it removes it. The user can edit it by hand, ask the AI to change it, copy it, or throw it away.
 */
export function PromptBuilder({ apiKey, onBack }: { apiKey: string; onBack: () => void }) {
  const approve = useReceipt();
  const [idea, setIdea] = useState("");
  const [text, setText] = useState("");
  const [started, setStarted] = useState(false); // false = still on the description step
  const [busy, setBusy] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [lastGenerated, setLastGenerated] = useState(""); // what the AI last produced, to tell if the user edited it
  const [undo, setUndo] = useState<string[]>([]);
  const [confirmRegen, setConfirmRegen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const editor = useRef<HTMLTextAreaElement>(null);

  useEffect(() => () => abort.current?.abort(), []);

  const edited = text !== lastGenerated;

  /** Runs one approved request and streams the reply into the editor. Returns the final text, or null if it failed. */
  const run = async (req: ReceiptRequest, keepOnFail: string): Promise<string | null> => {
    setError(null);
    setBusy(true);
    const ctl = new AbortController();
    abort.current = ctl;
    let partial = "";
    try {
      const [approved] = (await approve([req]))!;
      setText("");
      const full = await streamChat({
        apiKey, approval: approved, signal: ctl.signal,
        onText: (t) => { partial = cleanPrompt(t); setText(partial); },
      });
      const result = cleanPrompt(full);
      if (!result) throw new Error("The AI returned nothing. Try rephrasing.");
      setText(result);
      setLastGenerated(result);
      return result;
    } catch (e) {
      if (ctl.signal.aborted) {
        // Stop pressed: keep what arrived if there is any, otherwise put the previous text back.
        const kept = partial.trim() ? partial : keepOnFail;
        setText(kept);
        setLastGenerated(kept);
        return kept;
      }
      setText(keepOnFail);
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      abort.current = null;
      setBusy(false);
    }
  };

  const generate = async () => {
    if (!idea.trim() || busy) return;
    setConfirmRegen(false);
    const before = text;
    setStarted(true);
    const result = await run(generateRequest(idea), before);
    if (result === null && !before) setStarted(false); // first attempt failed: back to the description
    if (result !== null && before.trim() && result !== before) setUndo((u) => [...u, before]);
  };

  const refine = async (instr: string) => {
    if (!text.trim() || !instr.trim() || busy) return;
    const before = text;
    const result = await run(refineRequest(text, instr), before);
    if (result === null) return;
    if (result !== before) setUndo((u) => [...u, before]);
    setInstruction("");
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Older webviews: select the editor and use the legacy copy command.
      const el = editor.current;
      if (!el) return setError("Could not copy. Select the text and copy it by hand.");
      el.select();
      if (!document.execCommand("copy")) return setError("Could not copy. Select the text and copy it by hand.");
    }
    setError(null);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const discard = () => {
    abort.current?.abort();
    setText(""); setLastGenerated(""); setUndo([]); setInstruction(""); setConfirmRegen(false); setError(null);
    setStarted(false);
  };

  const undoLast = () => {
    const prev = undo[undo.length - 1];
    if (prev === undefined) return;
    setUndo((u) => u.slice(0, -1));
    setText(prev);
    setLastGenerated(prev);
  };

  return (
    <div
      className="ai"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        if (busy) abort.current?.abort();
        else if (started) discard();
        else onBack();
      }}
    >
      {!started ? (
        <div className="ai-form">
          <h2>WHAT SHOULD THE AGENT DO?</h2>
          <p className="note">Describe the job in your own words. You'll get an editable prompt. It is not saved anywhere unless you copy it.</p>
          <textarea
            className="ai-prompt"
            autoFocus
            placeholder="e.g. Add dark mode to my React app and make sure the tests still pass"
            aria-label="Describe what the AI agent should do"
            value={idea}
            maxLength={MAX_IDEA}
            onChange={(e) => setIdea(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void generate();
              }
            }}
          />
          <div className="ai-actions" style={{ marginTop: 8 }}>
            <button className="btn primary" disabled={!idea.trim()} onClick={() => void generate()}>✎ GENERATE PROMPT</button>
            <span className="hint">{isMac ? "⌘" : "Ctrl+"}Enter generates</span>
          </div>
        </div>
      ) : (
        <>
          <div className="ai-status">
            {busy ? <TypingCat label="Writing prompt" /> : <TypingCat mood="waiting" label="Prompt ready. Edit it, refine it, or copy it." />}
          </div>
          <textarea
            ref={editor}
            className="ai-prompt prompt-editor"
            aria-label="Prompt for the AI agent"
            value={text}
            readOnly={busy}
            maxLength={MAX_PROMPT}
            spellCheck={false}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="prompt-refine">
            <div className="ai-actions prompt-chips">
              {REFINE_ACTIONS.map((a) => (
                <button key={a.key} className="btn" disabled={busy || !text.trim()} title={a.instruction} onClick={() => void refine(a.instruction)}>{a.label}</button>
              ))}
            </div>
            <div className="ai-actions">
              <input
                className="search"
                style={{ flex: 1, margin: 0 }}
                aria-label="Tell the AI what to change"
                placeholder="Or say what to change, e.g. add a rollback step"
                maxLength={MAX_INSTRUCTION}
                value={instruction}
                disabled={busy}
                onChange={(e) => setInstruction(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void refine(instruction)}
              />
              <button className="btn primary" disabled={busy || !instruction.trim() || !text.trim()} onClick={() => void refine(instruction)}>UPDATE WITH AI</button>
            </div>
          </div>
          <div className="ai-actions" style={{ padding: 10, flexWrap: "wrap" }}>
            {busy ? (
              <button className="btn" onClick={() => abort.current?.abort()}>■ STOP</button>
            ) : (
              <>
                <button className="btn primary" disabled={!text.trim()} onClick={() => void copy()}>{copied ? "COPIED ✓" : "COPY"}</button>
                {confirmRegen ? (
                  <>
                    <span className="note">Replace your edits?</span>
                    <button className="btn" onClick={() => void generate()}>YES, REGENERATE</button>
                    <button className="btn" onClick={() => setConfirmRegen(false)}>NO</button>
                  </>
                ) : (
                  <button className="btn" disabled={!idea.trim()} title="Write a fresh prompt from your original description" onClick={() => (edited ? setConfirmRegen(true) : void generate())}>REGENERATE</button>
                )}
                <button className="btn" disabled={undo.length === 0} onClick={undoLast} title="Go back to the version before the last AI change">UNDO</button>
                <button className="btn" onClick={discard}>DISCARD</button>
              </>
            )}
          </div>
        </>
      )}
      {error && <div className="error" role="alert">{error}</div>}
      {!started && (
        <div style={{ padding: 10 }}>
          <button className="btn" onClick={onBack}>← BACK</button>
        </div>
      )}
    </div>
  );
}
