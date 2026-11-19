import { useState } from "react";
import { api } from "../../services/api";
import type { NotionHit } from "../../types";
import "./notion.css";

export const looksLikeNotionLink = (s: string) => /notion\.(so|site)\/|^[0-9a-f-]{32,36}$/i.test(s.trim());

/** Finds a Notion page by title or pasted link. Calls `onPick` with the chosen page; nothing is changed in Notion. */
export function PagePicker({ onPick, busy: outerBusy = false }: { onPick: (hit: NotionHit) => void; busy?: boolean }) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<NotionHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const go = async () => {
    const q = query.trim();
    setError(null);
    if (looksLikeNotionLink(q)) { onPick({ id: q, title: "Page from link", url: q }); return; }
    setBusy(true);
    try { setHits(await api.notionSearch(q)); } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };

  return (
    <div className="notion-picker">
      <div className="voice-actions">
        <input className="search" style={{ flex: 1, margin: 0 }} aria-label="Find a Notion page" placeholder="Search by title, or paste a page link"
          value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void go()} />
        <button className="btn" disabled={busy || outerBusy} onClick={() => void go()}>{busy ? "…" : query.trim() ? "FIND" : "LIST ALL"}</button>
      </div>
      {hits && (
        <ul className="notion-hits">
          {hits.length === 0 && <li className="note">No pages found. With a connection token, share the page first (••• → Add connections). Search matches titles only.</li>}
          {hits.map((h) => <li key={h.id}><button className="btn" disabled={outerBusy} onClick={() => onPick(h)}>{h.title}</button></li>)}
        </ul>
      )}
      {error && <div className="error" role="alert">{error}</div>}
    </div>
  );
}
