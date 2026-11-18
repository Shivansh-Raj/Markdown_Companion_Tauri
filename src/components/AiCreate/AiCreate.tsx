import { useEffect, useRef, useState } from "react";
import { api } from "../../services/api";
import {
  buildSystemPrompt,
  DOC_TYPE_LABELS,
  splitTypeLine,
  streamGeneration,
  stripFence,
  titleFromMarkdown,
  type DocTypeChoice,
} from "../../services/ai";
import { MarkdownRenderer } from "../MarkdownRenderer/MarkdownRenderer";
import { useReceipt } from "../Receipt/ReceiptProvider";
import { TypingCat } from "./TypingCat";

type Phase = "input" | "generating" | "done";
const isMac = typeof navigator !== "undefined" && /mac/i.test(navigator.platform);

export function AiCreate({ onBack, onCreated }: { onBack: () => void; onCreated: (id: string) => void }) {
  const approve = useReceipt();
  const [phase, setPhase] = useState<Phase>("input");
  const [prompt, setPrompt] = useState("");
  const [typeChoice, setTypeChoice] = useState<DocTypeChoice>("auto");
  const [apiKey, setApiKey] = useState<string | null | undefined>(undefined); // undefined = loading
  const [keyDraft, setKeyDraft] = useState("");
  const [editingKey, setEditingKey] = useState(false);
  const [raw, setRaw] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const preview = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.getGroqKey().then((k) => setApiKey(k ?? null)).catch((e) => setError(String(e)));
    return () => abort.current?.abort();
  }, []);

  const { type: detectedType, body: rawBody, pending } = splitTypeLine(raw);
  const body = stripFence(rawBody);
  const typeLabel = typeChoice !== "auto" ? DOC_TYPE_LABELS[typeChoice] : detectedType ? DOC_TYPE_LABELS[detectedType] : null;

  useEffect(() => {
    const el = preview.current;
    if (el && phase === "generating") el.scrollTop = el.scrollHeight;
  }, [body, phase]);

  const saveKey = async () => {
    try {
      const storage = await api.setGroqKey(keyDraft);
      setApiKey(keyDraft.trim() || null);
      setKeyDraft("");
      setEditingKey(false);
      setError(
        storage.kind === "file"
          ? `The key works but could not go into the secure credential store (${storage.warning}), so it is saved unprotected in the app's data file.`
          : null,
      );
    } catch (e) {
      setError(String(e));
    }
  };

  const generate = async () => {
    if (!prompt.trim() || !apiKey) return;
    setError(null);
    setRaw("");
    setPhase("generating");
    const ctl = new AbortController();
    abort.current = ctl;
    try {
      // Only what you typed is sent, so there is nothing to review: this approval needs no dialog.
      const typed = prompt.trim();
      const [approved] = (await approve([{
        purpose: "Create a file", system: buildSystemPrompt(typeChoice), user: typed, mode: "typed",
        items: [{ label: "Your prompt", text: typed, typed: true }],
      }]))!;
      const full = await streamGeneration({
        apiKey,
        approval: approved,
        signal: ctl.signal,
        onText: setRaw,
      });
      setRaw(full);
      if (!full.trim()) throw new Error("The AI returned nothing. Try rephrasing your prompt.");
      setPhase("done");
    } catch (e) {
      if (ctl.signal.aborted) {
        // Stop pressed: keep whatever arrived.
        setPhase("done");
      } else {
        setError(e instanceof Error ? e.message : String(e));
        setPhase("input");
      }
    } finally {
      abort.current = null;
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const content = body.endsWith("\n") ? body : body + "\n";
      const file = await api.createMarkdownFile(titleFromMarkdown(body, "untitled"), content);
      await api.openTracker(file.id);
      onCreated(file.id);
    } catch (e) {
      setError(String(e));
      setSaving(false);
    }
  };

  const reset = () => {
    setPhase("input");
    setRaw("");
    setError(null);
  };

  const needsKey = apiKey === null || editingKey;

  return (
    <div
      className="ai"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          if (phase === "generating") abort.current?.abort();
          else if (phase === "done") reset();
          else onBack();
        }
      }}
    >
      {phase === "input" && (
        <div className="ai-form">
          {needsKey ? (
            <>
              <h2>GROQ API KEY</h2>
              <p className="note">
                Paste a free key from console.groq.com. It is stored only on this computer and sent only to api.groq.com.
              </p>
              <input
                className="search"
                style={{ margin: "6px 0" }}
                type="password"
                autoFocus
                autoComplete="off"
                placeholder="gsk_…"
                aria-label="Groq API key"
                value={keyDraft}
                onChange={(e) => setKeyDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && keyDraft.trim() && void saveKey()}
              />
              <button className="btn primary" disabled={!keyDraft.trim()} onClick={() => void saveKey()}>
                SAVE KEY
              </button>
              {editingKey && (
                <button className="btn" style={{ marginLeft: 8 }} onClick={() => setEditingKey(false)}>
                  CANCEL
                </button>
              )}
            </>
          ) : (
            <>
              <h2>WHAT SHOULD I WRITE?</h2>
              <textarea
                className="ai-prompt"
                autoFocus
                placeholder="e.g. Plan my product launch next week"
                aria-label="Describe the file you want"
                value={prompt}
                maxLength={4000}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void generate();
                  }
                }}
              />
              <label className="ai-type">
                Type
                <select value={typeChoice} onChange={(e) => setTypeChoice(e.target.value as DocTypeChoice)}>
                  {(Object.keys(DOC_TYPE_LABELS) as DocTypeChoice[]).map((t) => (
                    <option key={t} value={t}>
                      {DOC_TYPE_LABELS[t]}
                    </option>
                  ))}
                </select>
              </label>
              <div className="ai-actions">
                <button className="btn primary" disabled={!prompt.trim() || apiKey === undefined} onClick={() => void generate()}>
                  ✎ GENERATE
                </button>
                <button className="btn" onClick={() => setEditingKey(true)} title="Change Groq API key">
                  KEY
                </button>
                <span className="hint">{isMac ? "⌘" : "Ctrl+"}Enter generates</span>
              </div>
            </>
          )}
        </div>
      )}

      {phase !== "input" && (
        <>
          <div className="ai-status">
            {phase === "generating" ? (
              <TypingCat label={pending || !body ? "Thinking" : `Writing${typeLabel ? " " + typeLabel.toLowerCase() : ""}`} />
            ) : (
              <TypingCat mood="waiting" label={`Draft ready${typeLabel ? " (" + typeLabel.toLowerCase() + ")" : ""}. Keep it?`} />
            )}
          </div>
          <div className="ai-preview content" ref={preview} tabIndex={0} aria-label="Generated Markdown preview">
            {body && <MarkdownRenderer source={body} />}
            {phase === "generating" && <span className="ai-caret" aria-hidden="true" />}
          </div>
          <div className="ai-actions" style={{ padding: 10 }}>
            {phase === "generating" ? (
              <button className="btn" onClick={() => abort.current?.abort()}>■ STOP</button>
            ) : (
              <>
                <button className="btn primary" disabled={saving || !body.trim()} onClick={() => void save()}>
                  {saving ? "SAVING…" : "SAVE & OPEN"}
                </button>
                <button className="btn" disabled={saving} onClick={reset}>DISCARD</button>
              </>
            )}
          </div>
        </>
      )}

      {error && <div className="error" role="alert">{error}</div>}
      {phase === "input" && (
        <div style={{ padding: 10 }}>
          <button className="btn" onClick={onBack}>← BACK</button>
        </div>
      )}
    </div>
  );
}
