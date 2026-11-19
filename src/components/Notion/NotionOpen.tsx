import { useEffect, useState } from "react";
import { api } from "../../services/api";
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

  useEffect(() => { api.notionConnected().then(setConnected).catch((e) => { setConnected(false); setError(String(e)); }); }, []);

  const pull = async (page: string) => {
    setBusy(true); setError(null); setNotice(null);
    try {
      const r = await api.notionPull(page);
      if (r.unknown_blocks > 0) setNotice(`${r.unknown_blocks} block${r.unknown_blocks === 1 ? "" : "s"} could not be shown as Markdown and appear as <unknown> tags. Leave them as they are.`);
      onOpened();
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };

  const go = async () => {
    const q = query.trim();
    if (looksLikeLink(q)) { await pull(q); return; }
    setBusy(true); setError(null);
    try { setHits(await api.notionSearch(q)); } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };

  return (
    <div className="notion-open" onKeyDown={(e) => e.key === "Escape" && onBack()}>
      <h2>OPEN FROM NOTION</h2>
      {connected === false && <p className="note">Notion is not connected. Add a connection token in Settings → Notion first.</p>}
      {connected && (
        <>
          <div className="voice-actions">
            <input className="search" style={{ flex: 1, margin: 0 }} autoFocus aria-label="Find a Notion page" placeholder="Search by title, or paste a page link"
              value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void go()} />
            <button className="btn" disabled={busy} onClick={() => void go()}>{busy ? "…" : query.trim() ? "FIND" : "LIST ALL"}</button>
          </div>
          {hits && (
            <ul className="notion-hits">
              {hits.length === 0 && <li className="note">No pages found. Nothing may be shared with the connection yet: in Notion, open a page, click ••• → Add connections, and pick this connection. Search matches titles only.</li>}
              {hits.map((h) => <li key={h.id}><button className="btn" disabled={busy} onClick={() => void pull(h.id)}>{h.title}</button></li>)}
            </ul>
          )}
          <p className="note">The page is saved as a new local note and linked to it. Nothing in Notion is changed.</p>
        </>
      )}
      {notice && <p className="note">{notice}</p>}
      {error && <div className="error" role="alert">{error}</div>}
      <div className="voice-actions"><button className="btn" onClick={onBack}>← BACK</button></div>
    </div>
  );
}
