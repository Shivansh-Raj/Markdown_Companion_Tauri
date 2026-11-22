import { useEffect, useMemo, useRef, useState } from "react";
import { streamChat } from "../../services/ai";
import { cleanGrammar, grammarRequest, MAX_GRAMMAR_CHARS } from "../../services/aiGrammar";
import { diffLines, hasChanges, withContext } from "../../services/diff";
import { useReceipt } from "../Receipt/ReceiptProvider";
import { TypingCat } from "./TypingCat";

const isMac = typeof navigator !== "undefined" && /mac/i.test(navigator.platform);

/** Disposable grammar fixer: paste text, get a corrected version you can edit and copy. Nothing is saved. */
export function GrammarFixer({ apiKey, onBack }: { apiKey: string; onBack: () => void }) {
  const approve = useReceipt();
  const [input, setInput] = useState("");
  const [original, setOriginal] = useState(""); // the text that was checked
  const [text, setText] = useState("");          // the corrected, editable result
  const [started, setStarted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showChanges, setShowChanges] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const editor = useRef<HTMLTextAreaElement>(null);

  useEffect(() => () => abort.current?.abort(), []);

  const rows = useMemo(
    () => (showChanges && !busy ? withContext(diffLines(original, text), 1) : []),
    [showChanges, busy, original, text],
  );
  const changed = useMemo(() => !busy && started && hasChanges(diffLines(original, text)), [busy, started, original, text]);

  const check = async (text0: string = input) => {
    const src = text0;
    if (!src.trim() || busy) return;
    setError(null);
    setOriginal(src);
    setText("");
    setStarted(true);
    setBusy(true);
    const ctl = new AbortController();
    abort.current = ctl;
    let partial = "";
    try {
      const [approved] = (await approve([grammarRequest(src)]))!;
      const full = await streamChat({
        apiKey, approval: approved, signal: ctl.signal,
        onText: (t) => { partial = cleanGrammar(t, src); setText(partial); },
      });
      const result = cleanGrammar(full, src);
      if (!result.trim()) throw new Error("The AI returned nothing. Try again.");
      setText(result);
    } catch (e) {
      if (ctl.signal.aborted) {
        // Stopped early: a half-corrected text would silently lose the end, so go back to the original.
        setText(src);
      } else {
        setError(e instanceof Error ? e.message : String(e));
        setStarted(false);
      }
    } finally {
      abort.current = null;
      setBusy(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
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
    setInput(""); setOriginal(""); setText(""); setShowChanges(false); setError(null); setStarted(false);
  };

  const editOriginal = () => { abort.current?.abort(); setInput(original); setStarted(false); setShowChanges(false); };

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
          <h2>PASTE TEXT TO CORRECT</h2>
          <p className="note">Fixes spelling, grammar and punctuation only. Your wording and tone stay as they are. Nothing is saved.</p>
          <textarea
            className="ai-prompt"
            autoFocus
            style={{ minHeight: 160 }}
            placeholder="Paste or type the text here"
            aria-label="Text to correct"
            value={input}
            maxLength={MAX_GRAMMAR_CHARS}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void check();
              }
            }}
          />
          <div className="ai-actions" style={{ marginTop: 8 }}>
            <button className="btn primary" disabled={!input.trim()} onClick={() => void check()}>✎ CORRECT GRAMMAR</button>
            <span className="hint">{input.length.toLocaleString()}/{MAX_GRAMMAR_CHARS.toLocaleString()} · {isMac ? "⌘" : "Ctrl+"}Enter</span>
          </div>
        </div>
      ) : (
        <>
          <div className="ai-status">
            {busy ? <TypingCat label="Proofreading" /> : <TypingCat mood="waiting" label={changed ? "Corrected. Edit it or copy it." : "No corrections needed."} />}
          </div>
          {showChanges && !busy ? (
            <div className="diff" role="region" aria-label="Changes made" tabIndex={0} style={{ margin: "8px 10px 0", flex: 1, overflow: "auto" }}>
              {!changed && <div className="diff-empty">No changes were needed.</div>}
              {rows.map((r, i) =>
                r.kind === "gap" ? (
                  <div key={i} className="diff-row gap">⋯ {r.hidden} unchanged line{r.hidden === 1 ? "" : "s"}</div>
                ) : (
                  <div key={i} className={`diff-row ${r.kind}`}>
                    <span className="sign" aria-hidden="true">{r.kind === "add" ? "+" : r.kind === "del" ? "−" : " "}</span>
                    <span className="sr-only">{r.kind === "add" ? "added: " : r.kind === "del" ? "removed: " : ""}</span>
                    <span className="txt">{r.text || " "}</span>
                  </div>
                ),
              )}
            </div>
          ) : (
            <textarea
              ref={editor}
              className="ai-prompt prompt-editor"
              aria-label="Corrected text"
              value={text}
              readOnly={busy}
              maxLength={MAX_GRAMMAR_CHARS * 2}
              onChange={(e) => setText(e.target.value)}
            />
          )}
          <div className="ai-actions" style={{ padding: 10, flexWrap: "wrap" }}>
            {busy ? (
              <button className="btn" onClick={() => abort.current?.abort()}>■ STOP</button>
            ) : (
              <>
                <button className="btn primary" disabled={!text.trim()} onClick={() => void copy()}>{copied ? "COPIED ✓" : "COPY"}</button>
                <button className="btn" aria-pressed={showChanges} onClick={() => setShowChanges((v) => !v)} title="Compare with your original">{showChanges ? "HIDE CHANGES" : "SHOW CHANGES"}</button>
                <button className="btn" onClick={() => void check(original)} title="Check the original text again">RE-CHECK</button>
                <button className="btn" onClick={editOriginal} title="Go back and change the text you pasted">EDIT ORIGINAL</button>
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
