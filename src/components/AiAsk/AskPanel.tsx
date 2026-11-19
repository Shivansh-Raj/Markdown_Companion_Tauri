import { useEffect, useRef, useState } from "react";
import { api } from "../../services/api";
import { MarkdownRenderer } from "../MarkdownRenderer/MarkdownRenderer";
import { streamChat } from "../../services/ai";
import { useReceipt } from "../Receipt/ReceiptProvider";
import {
  askHistoryText, buildAskSystemPrompt, buildAskUserPrompt, buildScopedSystemPrompt, buildScopedUserPrompt, isNotFound, excerptForAsk,
  archiveMarkdown, parseAskAnswer, parseScopedAnswer, retrievalQuery, type ParsedAnswer, type Turn,
} from "../../services/aiAsk";
import type { AskScopes } from "../../types";
import type { Passage } from "../../services/aiAsk";

/** Answers are Markdown (lists, bold, code): render them instead of showing raw characters. */
function Answer({ text }: { text: string }) {
  return (
    <div className="ask-body">
      <MarkdownRenderer source={text} busy onOpenLink={(u) => void api.openExternal(u).catch(() => {})} />
    </div>
  );
}

interface Item extends Turn { sources: ParsedAnswer["sources"]; error?: boolean; scoped?: boolean }

type Scope = "note" | "folder" | "vault";

const EXAMPLES = ["What is still left to do?", "Summarise this file in three bullets.", "What is due soonest?"];

/** Ask a question about the open file; the answer comes only from the file, with quotes you can check. */
export function AskPanel({ noteId, content, fileName, onClose, notionPage = false, notice, sourceUrl }: { noteId?: string; content: string; fileName: string; onClose: () => void; notionPage?: boolean; notice?: string; sourceUrl?: string }) {
  const [scopes, setScopes] = useState<AskScopes | null>(null);
  const [scope, setScope] = useState<Scope>("note");
  const [excluded, setExcluded] = useState(0);
  const [items, setItems] = useState<Item[]>([]);
  const [question, setQuestion] = useState("");
  const [live, setLive] = useState<string | null>(null); // answer being streamed
  const [asked, setAsked] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Approved answers can be saved to the "AI answers" page in Notion. Only on a button press; never automatically.
  const [canArchive, setCanArchive] = useState(false);
  const [archived, setArchived] = useState<Record<number, string>>({}); // item index -> page url, or "…" while saving
  useEffect(() => {
    Promise.all([api.notionConnected(), api.notionHome()]).then(([c, h]) => setCanArchive(c && !!h)).catch(() => {});
  }, []);
  const archive = async (i: number, it: Item) => {
    setArchived((a) => ({ ...a, [i]: "…" }));
    try {
      const md = archiveMarkdown(it.question, it.answer, it.sources, { name: fileName, url: sourceUrl });
      const made = await api.notionCreatePage("", it.question.trim().slice(0, 200), md, undefined, "answers");
      setArchived((a) => ({ ...a, [i]: made.url || "saved" }));
    } catch (e) {
      setArchived((a) => { const n = { ...a }; delete n[i]; return n; });
      setError(String(e));
    }
  };
  const abort = useRef<AbortController | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const [partial, setPartial] = useState<string | null>(null);
  const approve = useReceipt();

  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    if (noteId) api.askScopes(noteId).then(setScopes).catch(() => setScopes(null));
  }, [noteId]);
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
    const turns = items.filter((i) => !i.error);
    const where = scope === "folder" ? `the folder ${scopes?.folder_name}` : `${scopes?.is_vault ? "the vault" : "the folder"} ${scopes?.vault_name}`;
    let passages: Passage[] = [];
    let system: string;
    let user: string;
    let reqItems: { label: string; text: string; typed?: boolean; note?: string }[];
    let doc = "";
    if (scope === "note" || !noteId) {
      const ex = excerptForAsk(content, text);
      doc = ex.text;
      const note = ex.partial ? `This file is long, so only the most relevant parts are sent (${ex.sent} of ${ex.total} pieces). Groq's free plan limits how much it takes per minute.` : undefined;
      setPartial(note ?? null);
      system = buildAskSystemPrompt();
      user = buildAskUserPrompt(text, turns, doc);
      reqItems = [{ label: `${fileName}${ex.partial ? " (the most relevant parts)" : notionPage ? " (whole Notion page)" : " (whole file)"}`, text: doc, note }];
    } else {
      // Retrieval happens on this computer. Nothing is sent until the receipt below is approved.
      let found;
      try {
        found = await api.askRetrieve(noteId, scope, retrievalQuery(text, turns[turns.length - 1]?.question));
      } catch (e) {
        setError(String(e));
        return;
      }
      setExcluded(found.excluded);
      passages = found.passages;
      if (!passages.length) {
        setQuestion("");
        setItems((cur) => [...cur, { question: text, answer: `I couldn't find anything about that in ${where}. Nothing was sent to the AI.`, sources: [], scoped: true }]);
        return;
      }
      system = buildScopedSystemPrompt();
      user = buildScopedUserPrompt(text, turns, passages);
      reqItems = passages.map((p) => ({ label: `${p.rel}${p.heading ? ` › ${p.heading}` : ""}`, text: p.text }));
    }
    const approved = await approve([{
      purpose: scope === "note" || !noteId ? `Ask about ${fileName}` : `Ask ${where}`, system, user, mode: "review",
      // A Notion page is other people's workspace content, so its text always goes through the review dialog.
      openFile: (scope === "note" || !noteId) && !notionPage,
      items: [
        ...reqItems,
        ...(turns.length ? [{ label: "Earlier answers in this chat", text: askHistoryText(turns) }] : []),
        { label: "Your question", text, typed: true },
      ],
    }]);
    if (!approved) return; // declined: nothing was sent, and the question stays in the box
    setQuestion("");
    setAsked(text);
    setLive("");
    const ctl = new AbortController();
    abort.current = ctl;
    try {
      const raw = await streamChat({
        apiKey, approval: approved[0],
        signal: ctl.signal, onText: (t) => setLive(t.replace(/\n?\s*SOURCES:[\s\S]*$/i, "")),
      });
      const scoped = passages.length > 0;
      const parsed = scoped ? parseScopedAnswer(raw, passages) : parseAskAnswer(raw, doc);
      if (!parsed.answer) throw new Error("The AI returned nothing. Try rephrasing the question.");
      setItems((cur) => [...cur, { question: text, answer: parsed.answer, sources: parsed.sources, scoped }]);
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
      {scopes && (
        <div className="ask-scope">
          <label htmlFor="ask-scope">Look in</label>
          <select id="ask-scope" className="search" style={{ margin: 0 }} value={scope} disabled={live !== null} onChange={(e) => setScope(e.target.value as Scope)}>
            <option value="note">This note</option>
            <option value="folder">Folder: {scopes.folder_name} ({scopes.folder_notes} notes)</option>
            <option value="vault">{scopes.is_vault ? "Vault" : "Watched folder"}: {scopes.vault_name} ({scopes.vault_notes} notes)</option>
          </select>
        </div>
      )}
      <p className="note">
        {scope === "note"
          ? notionPage
            ? "Answers come only from this Notion page. You review exactly what is sent first. Quotes below each answer are checked against the page and name their section."
            : "Answers come only from this file. Quotes below each answer are checked against the file."
          : "Only the passages that best match your question are sent, and you review them first. Quotes are checked against those passages and name their note."}
        {scope !== "note" && excluded > 0 && ` ${excluded} note${excluded === 1 ? " is" : "s are"} never sent (marked ai: false).`}
      </p>
      {notice && <div className="error" role="status">{notice}</div>}
      {scope === "note" && partial && <div className="error" role="status">{partial}</div>}

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
              <span className="voice-tag">{it.scoped ? "NOTES SAY" : notionPage ? "PAGE SAYS" : "FILE SAYS"}</span>
              {it.error ? <p>{it.answer}</p> : <Answer text={it.answer} />}
            </div>
            {!it.error && !isNotFound(it.answer) && (
              it.sources.some((s) => s.verified) ? (
                <ul className="ask-src" aria-label="Quotes from the file">
                  {it.sources.filter((s) => s.verified).map((s) => (
                    <li key={s.quote}>
                      “{s.quote}”
                      {s.heading && <span className="note"> › {s.heading}</span>}
                      {s.passage && noteId && (
                        <>
                          {" "}
                          <button className="ask-note" title={s.passage.rel} onClick={() => void api.openVaultNote(noteId, s.passage!.path).catch((e) => setError(String(e)))}>
                            {s.passage.name}
                          </button>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              ) : <p className="note">No exact quote could be matched in the file, so double-check this answer.</p>
            )}
            {canArchive && !it.error && !isNotFound(it.answer) && (
              <div className="voice-actions">
                {archived[i] === undefined ? (
                  <button className="btn" onClick={() => void archive(i, it)} title="Save this question, answer and its checked quotes to the AI answers page in Notion">SAVE TO NOTION</button>
                ) : archived[i] === "…" ? <span className="note">Saving…</span> : (
                  <span className="note">Saved to Notion › AI answers.{archived[i].startsWith("http") && <> <button className="ask-note" onClick={() => void api.openExternal(archived[i]).catch(() => {})}>Open</button></>}</span>
                )}
              </div>
            )}
          </div>
        ))}
        {live !== null && (
          <div className="ask-turn">
            <p className="ask-q"><span className="voice-tag">YOU</span> {asked}</p>
            <div className="ask-a">
              <span className="voice-tag">{scope === "note" ? "FILE SAYS" : "NOTES SAY"}</span>
              {live ? <Answer text={live} /> : <p>Reading {scope === "note" ? "the file" : "the passages"}…</p>}
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
