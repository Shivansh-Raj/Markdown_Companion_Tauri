import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../services/api";
import { GROUP_LABELS, groupNotionTasks, localDate, shortDate } from "../../services/tasks";
import type { NotionTask, NotionTasksView } from "../../types";
import { TaskCheckbox } from "../TaskCheckbox/TaskCheckbox";

const REFRESH_MS = 60_000; // Notion limits database queries, so this refreshes on open, on focus and once a minute

/** Open tasks from the Notion Tasks database. Ticking one sets its Status to Done, after checking it did not change. */
export function NotionTasksPane({ reloadTick }: { reloadTick: number }) {
  const [view, setView] = useState<NotionTasksView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [undo, setUndo] = useState<{ task: NotionTask; previous: string | null; done: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const undoTimer = useRef<number | undefined>(undefined);

  const load = useCallback(async () => {
    if (busyRef.current) return;
    try {
      setView(await api.notionTasks());
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, REFRESH_MS);
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", onFocus); window.clearTimeout(undoTimer.current); };
  }, [load, reloadTick]);

  const today = localDate();
  const groups = useMemo(() => (view ? groupNotionTasks(view.rows, today, query) : []), [view, today, query]);
  const overdue = view ? view.rows.filter((r) => r.due && r.due < today).length : 0;

  const setStatus = async (task: NotionTask, expect: string | null, to: string, offerUndo: boolean) => {
    busyRef.current = true;
    setBusy(true);
    setNotice(null);
    try {
      const outcome = await api.notionTaskSetStatus(task.id, expect, to);
      if (outcome === "stale") {
        setNotice(`"${task.title}" changed in Notion, so nothing was written. The list is refreshed.`);
        setUndo(null);
      } else if (offerUndo) {
        setUndo({ task, previous: expect, done: to });
        window.clearTimeout(undoTimer.current);
        undoTimer.current = window.setTimeout(() => setUndo(null), 8000);
      } else {
        setUndo(null);
      }
    } catch (e) {
      setNotice(String(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
      void load();
    }
  };

  const canTick = !!view?.done_status;

  return (
    <>
      <div className="tasks-tools">
        <input className="search tasks-search" placeholder="Filter tasks, owners or status" aria-label="Filter Notion tasks" value={query} onChange={(e) => setQuery(e.target.value)} />
        {overdue > 0 && <span className="tasks-overdue" role="status">{overdue} overdue</span>}
      </div>
      {error && <div className="error" role="alert">{error}</div>}
      {notice && <div className="error" role="alert">{notice} <button className="btn" onClick={() => setNotice(null)} aria-label="Dismiss">✕</button></div>}
      {view?.read_only_reason && <p className="tasks-empty">{view.read_only_reason}</p>}
      <div className="content tasks-list" role="region" aria-label="Open Notion tasks">
        {!view && !error && <p className="tasks-empty">Reading Notion…</p>}
        {view && view.rows.length === 0 && <p className="tasks-empty">Nothing left to do in {view.database}.</p>}
        {view && view.rows.length > 0 && groups.length === 0 && <p className="tasks-empty">No task matches "{query}".</p>}
        {groups.map((g) => (
          <section key={g.id}>
            <h4 className={g.id === "overdue" ? "tasks-h overdue" : "tasks-h"}>{GROUP_LABELS[g.id]} ({g.rows.length})</h4>
            <ul className="tasks-ul">
              {g.rows.map((r) => (
                <li key={r.id} className="tasks-row">
                  <TaskCheckbox checked={false} label={r.title} offset={0} disabled={busy || !canTick}
                    onToggle={() => void setStatus(r, r.status, view!.done_status!, true)} />
                  <div className="tasks-main">
                    <span className="tasks-title">{r.title}</span>
                    <span className="tasks-meta">
                      {r.url && <button className="tasks-note" onClick={() => void api.openExternal(r.url).catch((e) => setNotice(String(e)))} title="Open in Notion">Notion</button>}
                      {r.owner && <span>{r.owner}</span>}
                      {r.status && <span>{r.status}</span>}
                      {r.due && <span className={r.due < today ? "tasks-due overdue" : "tasks-due"}>{shortDate(r.due)}</span>}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))}
        {view?.truncated && <p className="tasks-empty">More tasks exist than are shown. Use the filter to narrow the list.</p>}
      </div>
      {undo && (
        <div className="tasks-undo" role="status">
          <span>Done: {undo.task.title}</span>
          <button className="btn" onClick={() => void setStatus(undo.task, undo.done, undo.previous ?? "Not started", false)} disabled={busy}>UNDO</button>
        </div>
      )}
    </>
  );
}
