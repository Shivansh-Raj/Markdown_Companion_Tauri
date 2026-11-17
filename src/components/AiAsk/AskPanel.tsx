import { useEffect, useRef, useState } from "react";
import { api } from "../../services/api";
import { MarkdownRenderer } from "../MarkdownRenderer/MarkdownRenderer";
import { streamChat } from "../../services/ai";
import {
  buildAskSystemPrompt, buildAskUserPrompt, isNotFound, limitDoc, parseAskAnswer, type ParsedAnswer, type Turn,
} from "../../services/aiAsk";

/** Answers are Markdown (lists, bold, code): render them instead of showing raw characters. */
function Answer({ text }: { text: string }) {
  return (
    <div className="ask-body">
      <MarkdownRenderer source={text} busy onOpenLink={(u) => void api.openExternal(u).catch(() => {})} />
    </div>
  );
}

interface Item extends Turn { sources: ParsedAnswer["sources"]; error?: boolean }

const EXAMPLES = ["What is still left to do?", "Summarise this file in three bullets.", "What is due soonest?"];

/** Ask a question about the open file; the answer comes only from the file, with quotes you can check. */
export function AskPanel({ content, fileName, onClose }: { content: string; fileName: string; onClose: () => void }) {
  const [items, setItems] = useState<Item[]>([]);
  const [question, setQuestion] = useState("");
  const [live, setLive] = useState<string | null>(null); // answer being streamed
  const [asked, setAsked] = useState("");
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const { text: doc, truncated } = limitDoc(content);

  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items, live]);

  const ask = async (q: string) => {
    const text = q.trim();
    if (!text || live !== null) return;
    setError(null);
    const apiKey = await api.getGroqKey().catch(() => null);
    if (!apiKey) {
      setError("No Groq API key yet. Open the launcher, choose NEW WITH AI and set it with the KEY button.");
      return;
    }
    setQuestion("");
    setAsked(text);
    setLive("");
    const ctl = new AbortController();
    abort.current = ctl;
    try {
      const raw = await streamChat({
        apiKey, system: buildAskSystemPrompt(), user: buildAskUserPrompt(text, items.filter((i) => !i.error), doc),
        signal: ctl.signal, onText: (t) => setLive(t.replace(/\n?\s*SOURCES:[\s\S]*$/i, "")),
      });
      const parsed = parseAskAnswer(raw, doc);
      if (!parsed.answer) throw new Error("The AI returned nothing. Try rephrasing the question.");
      setItems((cur) => [...cur, { question: text, answer: parsed.answer, sources: parsed.sources }]);
    } catch (e) {
      if (ctl.signal.aborted) {
        setQuestion(text); // stopped: put the question back so it can be edited
      } else {
        setItems((cur) => [...cur, { question: text, answer: e instanceof Error ? e.message : String(e), sources: [], error: true }]);
      }
    } finally {
      setLive(null);
      abort.current = null;
      input.current?.focus();
    }
  };

  return (
    <div
      className="ask"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          if (live !== null) abort.current?.abort();
          else onClose();
        }
      }}
    >
      <div className="ask-head">
        <strong>ASK ABOUT {fileName.toUpperCase()}</strong>
        <span style={{ flex: 1 }} />
        {items.length > 0 && live === null && <button className="btn" onClick={() => setItems([])}>CLEAR</button>}
        <button className="btn" onClick={onClose}>CLOSE</button>
      </div>
      <p className="note">Answers come only from this file. Quotes below each answer are checked against the file.</p>
      {truncated && <div className="error" role="status">This file is very long, so only the first part was searched.</div>}

      <div className="ask-log" ref={scroller} aria-live="polite">
        {items.length === 0 && live === null && (
          <div className="ask-examples">
            {EXAMPLES.map((ex) => <button key={ex} className="btn" onClick={() => void ask(ex)}>{ex}</button>)}
          </div>
        )}
        {items.map((it, i) => (
          <div key={i} className="ask-turn">
            <p className="ask-q"><span className="voice-tag">YOU</span> {it.question}</p>
            <div className={it.error ? "ask-a error" : "ask-a"}>
              <span className="voice-tag">FILE SAYS</span>
              {it.error ? <p>{it.answer}</p> : <Answer text={it.answer} />}
            </div>
            {!it.error && !isNotFound(it.answer) && (
              it.sources.some((s) => s.verified) ? (
                <ul className="ask-src" aria-label="Quotes from the file">
                  {it.sources.filter((s) => s.verified).map((s) => <li key={s.quote}>“{s.quote}”</li>)}
                </ul>
              ) : <p className="note">No exact quote could be matched in the file, so double-check this answer.</p>
            )}
          </div>
        ))}
        {live !== null && (
          <div className="ask-turn">
            <p className="ask-q"><span className="voice-tag">YOU</span> {asked}</p>
            <div className="ask-a">
              <span className="voice-tag">FILE SAYS</span>
              {live ? <Answer text={live} /> : <p>Reading the file…</p>}
            </div>
          </div>
        )}
      </div>

      {error && <div className="error" role="alert">{error}</div>}
      <div className="ask-input">
        <textarea
          ref={input}
          className="search"
          style={{ margin: 0, resize: "none", height: 54 }}
          autoFocus
          placeholder="Ask a question about this file…"
          aria-label="Question"
          value={question}
          disabled={live !== null}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void ask(question);
            }
          }}
        />
        {live !== null
          ? <button className="btn" onClick={() => abort.current?.abort()}>STOP</button>
          : <button className="btn primary" disabled={!question.trim()} onClick={() => void ask(question)}>ASK</button>}
      </div>
    </div>
  );
}
