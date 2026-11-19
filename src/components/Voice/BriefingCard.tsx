import { useEffect, useState } from "react";
import { api } from "../../services/api";
import { shortDate } from "../../services/tasks";
import type { NotionBriefing } from "../../types";
import "../Notion/notion.css";

/**
 * Before a meeting: earlier meetings that match the topic, the decisions written in them, and the open tasks linked to them.
 * Read from your Notion databases only; no AI is involved and nothing is sent anywhere.
 */
export function BriefingCard({ initialTopic }: { initialTopic: string }) {
  const [available, setAvailable] = useState(false);
  const [open, setOpen] = useState(false);
  const [topic, setTopic] = useState(initialTopic);
  const [brief, setBrief] = useState<NotionBriefing | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.notionConnected(), api.notionDestination("meetings")]).then(([c, d]) => setAvailable(c && d !== null)).catch(() => {});
  }, []);
  if (!available) return null;

  const load = async () => {
    setBusy(true); setError(null);
    try { setBrief(await api.notionBriefing(topic)); } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  const link = (url: string, text: string) => url ? <button className="ask-note" onClick={() => void api.openExternal(url).catch(() => {})}>{text}</button> : <>{text}</>;

  if (!open) return <button className="btn" onClick={() => { setOpen(true); void load(); }} title="Earlier meetings, their decisions and open tasks, from Notion">BRIEFING FROM NOTION</button>;
  return (
    <div className="notion-diff" style={{ margin: "8px 0" }}>
      <h3 className="voice-h">BRIEFING</h3>
      <div className="voice-actions">
        <input className="search" style={{ flex: 1, margin: 0 }} aria-label="Briefing topic" placeholder="Topic or project (empty: the latest meetings)" value={topic}
          onChange={(e) => setTopic(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void load()} />
        <button className="btn" disabled={busy} onClick={() => void load()}>{busy ? "…" : "UPDATE"}</button>
        <button className="btn" onClick={() => setOpen(false)}>CLOSE</button>
      </div>
      {error && <div className="error" role="alert">{error}</div>}
      {brief && (
        <>
          {brief.latest_instead && <p className="note">No earlier meeting matched “{topic}”, so the latest ones are shown.</p>}
          {brief.meetings.length === 0 && <p className="note">No earlier meetings in {brief.database} yet.</p>}
          {brief.meetings.map((m) => (
            <div key={m.url || m.title}>
              <strong>{link(m.url, m.title)}</strong> <span className="note">{m.date}</span>
              {m.decisions.length > 0 ? <ul>{m.decisions.map((d) => <li key={d}>{d}</li>)}</ul> : <p className="note">No decisions or takeaways written in this one.</p>}
            </div>
          ))}
          <h4 className="tasks-h">OPEN TASKS ({brief.tasks.length})</h4>
          {brief.tasks_note && <p className="note">{brief.tasks_note}</p>}
          {brief.tasks.length === 0 && !brief.tasks_note && <p className="note">No open tasks linked to these meetings.</p>}
          <ul>{brief.tasks.map((t) => <li key={t.id}>{link(t.url, t.title)} <span className="note">{[t.owner, t.due ? shortDate(t.due) : null].filter(Boolean).join(" · ")}</span></li>)}</ul>
        </>
      )}
    </div>
  );
}
