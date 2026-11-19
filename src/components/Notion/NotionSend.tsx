import { useEffect, useMemo, useState } from "react";
import { api } from "../../services/api";
import { prepareForNotion } from "../../services/notionMarkdown";
import type { NotionDestination, NotionHit, NotionHome, NotionLinkInfo, NotionPushPlan } from "../../types";
import "./notion.css";

const LAST_PARENT = "notion-last-parent";
const read = (k: string): NotionHit | null => { try { return JSON.parse(localStorage.getItem(k) ?? "null"); } catch { return null; } };
const write = (k: string, v: NotionHit) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* optional */ } };

const looksLikeLink = (s: string) => /notion\.(so|site)\/|^[0-9a-f-]{32,36}$/i.test(s.trim());

/** Creates a new Notion page from the open note. It always makes a new page; nothing existing is changed. */
export function NotionSend({ noteId, content, fileName, onClose }: { noteId: string; content: string; fileName: string; onClose: () => void }) {
  const draft = useMemo(() => prepareForNotion(content, fileName.replace(/\.md$/i, "")), [content, fileName]);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [title, setTitle] = useState(draft.title);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<NotionHit[] | null>(null);
  const [parent, setParent] = useState<NotionHit | null>(() => read(LAST_PARENT));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ url: string; linked: boolean } | null>(null);
  const [link, setLink] = useState<NotionLinkInfo | null | undefined>(undefined); // undefined = loading
  const [msg, setMsg] = useState<string | null>(null);
  const [home, setHome] = useState<NotionHome | null>(null);
  const [useHome, setUseHome] = useState(true);
  const homeMode = !!home && useHome;
  // Databases set up in Settings can also receive the note as a row.
  const [dbs, setDbs] = useState<Record<string, NotionDestination>>({});
  const [target, setTarget] = useState<string>("notes"); // notes | meetings | practice
  const [warnings, setWarnings] = useState<string[]>([]);
  const rowMode = target !== "notes" && !!dbs[target];
  const [plan, setPlan] = useState<Extract<NotionPushPlan, { kind: "ready" }> | null>(null);

  useEffect(() => {
    api.notionConnected().then(setConnected).catch((e) => { setConnected(false); setError(String(e)); });
    api.notionLink(noteId).then(setLink).catch(() => setLink(null));
    api.notionHome().then(setHome).catch(() => {});
    for (const k of ["meetings", "practice"]) {
      api.notionDestination(k).then((d) => d && setDbs((cur) => ({ ...cur, [k]: d }))).catch(() => {});
    }
  }, [noteId]);

  const preview = async () => {
    setBusy(true); setError(null); setMsg(null); setPlan(null);
    try {
      const p = await api.notionPushPlan(noteId);
      if (p.kind === "ready") setPlan(p);
      else if (p.kind === "nothing_to_send") setMsg("Nothing to send: this note matches Notion.");
      else setMsg(p.both
        ? "The Notion page changed too, so sending would risk overwriting it. Nothing was sent. Copy your edits, press REFRESH, then redo them."
        : "The Notion page has changes you don't have yet. Press REFRESH first.");
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };

  const push = async () => {
    if (!plan) return;
    setBusy(true); setError(null);
    try {
      const r = await api.notionPush(noteId, plan.local_hash);
      setPlan(null);
      setMsg(r.warnings.length ? `Sent. Notion adjusted something: ${r.warnings.join("; ")}` : "Sent to Notion. The previous Notion text was saved as a backup on this computer.");
      setLink(await api.notionLink(noteId));
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };

  const refresh = async () => {
    setBusy(true); setError(null); setMsg(null);
    try {
      const r = await api.notionRefresh(noteId);
      setMsg(
        r.updated ? "Updated this note with the latest from Notion."
          : r.state === "in_sync" ? "Already up to date."
          : r.state === "local_changed" ? "You have edits here that are not in Notion. Nothing was changed."
          : "Both this note and the Notion page changed. Nothing was overwritten.",
      );
      setLink(await api.notionLink(noteId));
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };

  const choose = (h: NotionHit) => { setParent(h); setHits(null); write(LAST_PARENT, h); };

  const find = async () => {
    const q = query.trim();
    setError(null);
    if (looksLikeLink(q)) {
      choose({ id: q, title: "Page from link", url: q });
      return;
    }
    setBusy(true);
    try { setHits(await api.notionSearch(q)); } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };

  const send = async () => {
    if (!rowMode && !parent && !homeMode) return;
    setBusy(true);
    setError(null);
    try {
      if (rowMode) {
        const row = await api.notionCreateRow(target, title, draft.markdown, { date: new Date().toISOString().slice(0, 10), source: "Markdown Companion" }, { file_id: noteId, content });
        setWarnings(row.warnings);
        setDone({ url: row.url, linked: row.linked });
      } else {
        const made = await api.notionCreatePage(parent?.id ?? "", title, draft.markdown, { file_id: noteId, content }, homeMode ? "notes" : undefined);
        setDone({ url: made.url, linked: made.linked });
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="voice-export notion-send" role="dialog" aria-label="Send to Notion" onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <h3 className="voice-h">SEND TO NOTION</h3>
      {connected === false && <p className="note">Notion is not connected. Add a connection token in Settings → Notion first.</p>}
      {connected && link && !done && (
        <>
          <p className="note">Linked to the Notion page "{link.title}". {link.local_changed ? "This note has edits that are not in Notion." : "No unsent edits."}</p>
          <div className="voice-actions">
            <button className="btn primary" disabled={busy || !link.local_changed} onClick={() => void preview()} title="Review your edits, then send them to the Notion page">PUSH TO NOTION</button>
            <button className="btn" disabled={busy} onClick={() => void refresh()} title="Bring Notion's changes into this note. Never overwrites your edits.">{busy ? "…" : "REFRESH FROM NOTION"}</button>
            {link.url && <button className="btn" onClick={() => void api.openExternal(link.url).catch((e) => setError(String(e)))}>OPEN IN NOTION</button>}
            <button className="btn" onClick={onClose}>CLOSE</button>
          </div>
          {plan && (
            <div className="notion-diff">
              <p className="note">Only this part of the Notion page will change. Only saved edits are included.</p>
              <div className="notion-diff-label">IN NOTION NOW</div>
              <pre className="notion-diff-old">{plan.old_str}</pre>
              <div className="notion-diff-label">AFTER SENDING</div>
              <pre className="notion-diff-new">{plan.new_str}</pre>
              <div className="voice-actions">
                <button className="btn primary" disabled={busy} onClick={() => void push()}>{busy ? "SENDING…" : "SEND THIS CHANGE"}</button>
                <button className="btn" disabled={busy} onClick={() => setPlan(null)}>CANCEL</button>
              </div>
            </div>
          )}
          {msg && <p className="note">{msg}</p>}
        </>
      )}
      {connected && link === null && !done && (
        <>
          <label className="notion-field">Title
            <input className="search" value={title} maxLength={2000} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <div className="notion-field">Create it inside
            {Object.keys(dbs).length > 0 && (
              <select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Where to save">
                <option value="notes">{home ? `${home.title} › Notes` : "A page"}</option>
                {dbs.meetings && <option value="meetings">Meetings database: {dbs.meetings.title}</option>}
                {dbs.practice && <option value="practice">Practice database: {dbs.practice.title}</option>}
              </select>
            )}
            {rowMode ? (
              <p className="note">Adds a row to “{dbs[target].title}” with today's date, and the note as the row's page. The other columns stay empty.</p>
            ) : homeMode ? (
              <div className="notion-parent">
                <span title={home?.page_id}>{home?.title} › Notes</span>
                <button className="btn" onClick={() => setUseHome(false)}>CHOOSE ANOTHER</button>
              </div>
            ) : (
              <div className="notion-parent">
                <span title={parent?.id}>{parent ? parent.title : "No page chosen"}</span>
                {parent && <button className="btn" onClick={() => setParent(null)}>CHANGE</button>}
                {home && <button className="btn" onClick={() => setUseHome(true)}>USE {home.title.toUpperCase()}</button>}
              </div>
            )}
            {!rowMode && !homeMode && !parent && (
              <div className="voice-actions">
                <input className="search" style={{ flex: 1, margin: 0 }} aria-label="Find a Notion page" placeholder="Search by title, or paste a page link"
                  value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void find()} />
                <button className="btn" disabled={busy} onClick={() => void find()}>FIND</button>
              </div>
            )}
            {hits && (
              <ul className="notion-hits">
                {hits.length === 0 && <li className="note">No pages found. Pages must be shared with the connection in Notion.</li>}
                {hits.map((h) => <li key={h.id}><button className="btn" onClick={() => choose(h)}>{h.title}</button></li>)}
              </ul>
            )}
          </div>
          {draft.notes.length > 0 && <ul className="notion-notes">{draft.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
          <p className="note">A new page is created. Nothing already in Notion is changed.</p>
          <div className="voice-actions">
            <button className="btn primary" disabled={busy || (!rowMode && !parent && !homeMode) || !title.trim()} onClick={() => void send()}>{busy ? "SENDING…" : "SEND"}</button>
            <button className="btn" onClick={onClose}>CANCEL</button>
          </div>
        </>
      )}
      {done && (
        <div className="voice-actions">
          <span className="note">{warnings.length > 0 ? `Created, but: ${warnings.join(" ")} ` : ""}Created in Notion{done.linked ? " and linked to this note." : ". It could not be linked to this note."}</span>
          {done.url && <button className="btn" onClick={() => void api.openExternal(done.url).catch((e) => setError(String(e)))}>OPEN IN NOTION</button>}
          <button className="btn" onClick={onClose}>CLOSE</button>
        </div>
      )}
      {connected === false && <div className="voice-actions"><button className="btn" onClick={onClose}>CLOSE</button></div>}
      {error && <div className="error" role="alert">{error}</div>}
    </div>
  );
}
