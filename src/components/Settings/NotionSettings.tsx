import { useEffect, useState } from "react";
import { api } from "../../services/api";
import type { NotionHome } from "../../types";
import { NotionDestinations } from "../Notion/NotionDestinations";
import { PagePicker } from "../Notion/PagePicker";

/** Connects Notion with a token the user creates in Notion. The token is checked, then kept in the system credential store. */
export function NotionSettings() {
  const [connected, setConnected] = useState(false);
  const [draft, setDraft] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [home, setHome] = useState<NotionHome | null>(null);
  const [choosing, setChoosing] = useState(false);

  useEffect(() => {
    api.notionConnected().then(setConnected).catch((e) => setError(String(e)));
    api.notionHome().then(setHome).catch(() => {});
  }, []);

  const pickHome = (hit: { id: string }) => run(async () => {
    const h = await api.notionSetHome(hit.id);
    setHome(h); setChoosing(false);
    setMsg(`Home page set to "${h.title}". Notes, Meetings and the other pages are created inside it when first used.`);
  });

  const run = async (f: () => Promise<void>) => {
    setBusy(true); setError(null); setMsg(null);
    try { await f(); } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };

  const connect = () => run(async () => {
    const me = await api.notionConnect(draft);
    setDraft(""); setConnected(true);
    setMsg(`Connected${me.workspace ? ` to ${me.workspace}` : ""}.`);
  });
  const test = () => run(async () => {
    const me = await api.notionTest();
    setMsg(`Working${me.workspace ? `: ${me.workspace}` : ""}.`);
  });
  const disconnect = () => run(async () => { await api.notionDisconnect(); setConnected(false); setMsg("Disconnected. The token was removed from this computer."); });

  return (
    <>
      <h2>NOTION</h2>
      {connected ? (
        <div className="folder">
          <span>Connected</span>
          <button className="btn" disabled={busy} onClick={() => void test()}>TEST</button>
          <button className="btn" disabled={busy} onClick={() => void disconnect()}>DISCONNECT</button>
        </div>
      ) : (
        <>
          <p className="note">
            Paste a token from Notion's Developer portal. A connection token only reaches pages you share with it (••• → Add connections).
            A personal access token acts as you and reaches every page you can see, so use it only if you want that. The token is stored in
            your system credential store and sent only to api.notion.com.
          </p>
          <input className="search" style={{ margin: "6px 0" }} type="password" autoComplete="off" placeholder="Connection token" aria-label="Notion connection token"
            value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && draft.trim() && void connect()} />
          <button className="btn primary" disabled={busy || !draft.trim()} onClick={() => void connect()}>{busy ? "CHECKING…" : "CONNECT"}</button>
        </>
      )}
      {connected && (
        <>
          <h2>NOTION HOME PAGE</h2>
          <p className="note">Everything MC creates goes inside this page, in Notes, Meetings, Practice sessions and AI answers. Create an empty page in Notion first (for example "Markdown Companion"), then choose it here.</p>
          {home && !choosing ? (
            <div className="folder">
              <span title={home.page_id}>{home.title}</span>
              <button className="btn" disabled={busy} onClick={() => setChoosing(true)}>CHANGE</button>
              <button className="btn" disabled={busy} onClick={() => void run(async () => { await api.notionClearHome(); setHome(null); })}>CLEAR</button>
            </div>
          ) : (
            <>
              <PagePicker busy={busy} onPick={(h) => void pickHome(h)} />
              {choosing && <button className="btn" onClick={() => setChoosing(false)}>CANCEL</button>}
            </>
          )}
        </>
      )}
      {connected && <NotionDestinations />}
      {msg && <p className="note">{msg}</p>}
      {error && <div className="error" role="alert">{error}</div>}
    </>
  );
}
