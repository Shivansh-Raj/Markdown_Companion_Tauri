import { useEffect, useState } from "react";
import { api } from "../../services/api";
import { AskPanel } from "../AiAsk/AskPanel";
import type { NotionHit } from "../../types";
import "./notion.css";

const looksLikeLink = (s: string) => /notion\.(so|site)\/|^[0-9a-f-]{32,36}$/i.test(s.trim());

/** Opens a Notion page as a local note: search by title or paste a link. Reading never changes the page. */
export function NotionOpen({ onBack, onOpened }: { onBack: () => void; onOpened: () => void }) {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<NotionHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Ask a question about a Notion page without opening it as a note. The page is read live and nothing is saved locally.
  const [asking, setAsking] = useState<{ title: string; markdown: string; notice?: string } | null>(null);

  useEffect(() => { api.notionConnected().then(setConnected).catch((e) => { setConnected(false); setError(String(e)); }); }, []);

  const pull = async (page: string) => {
    setBusy(true); setError(null); setNotice(null);
    try {
      const r = await api.notionPull(page);
      if (r.unknown_blocks > 0) setNotice(`${r.unknown_blocks} block${r.unknown_blocks === 1 ? "" : "s"} could not be shown as Markdown and appear as <unknown> tags. Leave them as they are.`);
      onOpened();
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };

  const ask = async (page: string, title: string) => {
    setBusy(true); setError(null); setNotice(null);
    try {
      const p = await api.notionReadPage(page);
      // <unknown …/> tags stand for blocks Markdown cannot show; they carry links, not words, so they are not sent to the AI.
      const markdown = p.markdown.replace(/<unknown[^>]*\/>/g, "").trim();
      if (!markdown) { setError("That page has no text to ask about."); return; }
      setAsking({
        title,
        markdown,
        notice: p.truncated ? "This page is very large or partly shared with the connection, so only the part Notion returned is used." : undefined,
      });
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };

  const go = async () => {
    const q = query.trim();
    if (looksLikeLink(q)) { await pull(q); return; }
    setBusy(true); setError(null);
    try { setHits(await api.notionSearch(q)); } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };

  return (
    asking ? (
      <AskPanel content={asking.markdown} fileName={asking.title} notionPage notice={asking.notice} onClose={() => setAsking(null)} />
    ) : (
    <div className="notion-open" onKeyDown={(e) => e.key === "Escape" && onBack()}>
      <h2>OPEN FROM NOTION</h2>
      {connected === false && <p className="note">Notion is not connected. Add a connection token in Settings → Notion first.</p>}
      {connected && (
        <>
          <div className="voice-actions">
            <input className="search" style={{ flex: 1, margin: 0 }} autoFocus aria-label="Find a Notion page" placeholder="Search by title, or paste a page link"
              value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void go()} />
            <button className="btn" disabled={busy} onClick={() => void go()}>{busy ? "…" : query.trim() ? "FIND" : "LIST ALL"}</button>
            {looksLikeLink(query) && <button className="btn" disabled={busy} onClick={() => void ask(query.trim(), "Notion page")} title="Ask a question about this page instead of opening it">ASK</button>}
          </div>
          {hits && (
            <ul className="notion-hits">
              {hits.length === 0 && <li className="note">No pages found. Nothing may be shared with the connection yet: in Notion, open a page, click ••• → Add connections, and pick this connection. Search matches titles only.</li>}
              {hits.map((h) => (
                <li key={h.id} className="notion-hit-row">
                  <button className="btn" disabled={busy} onClick={() => void pull(h.id)} title="Open as a note">{h.title}</button>
                  <button className="btn" disabled={busy} onClick={() => void ask(h.id, h.title)} title="Ask a question about this page">ASK</button>
                </li>
              ))}
            </ul>
          )}
          <p className="note">Click a title to save the page as a new local note, or ASK to question it without saving anything. Nothing in Notion is changed.</p>
        </>
      )}
      {notice && <p className="note">{notice}</p>}
      {error && <div className="error" role="alert">{error}</div>}
      <div className="voice-actions"><button className="btn" onClick={onBack}>← BACK</button></div>
    </div>
    )
  );
}
