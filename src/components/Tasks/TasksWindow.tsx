import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "../../services/api";
import { GROUP_LABELS, groupTasks, localDate, plainTitle, shortDate } from "../../services/tasks";
import type { TaskRow, TasksView } from "../../types";
import { TaskCheckbox } from "../TaskCheckbox/TaskCheckbox";
import "./tasks.css";

const REFRESH_MS = 5000;

interface Undo {
  row: TaskRow;
}

/** Always-on-top list of unchecked tasks from your vaults, watched folders and tracked files. */
export function TasksWindow() {
  const [view, setView] = useState<TasksView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [undo, setUndo] = useState<Undo | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const undoTimer = useRef<number | undefined>(undefined);
  const win = getCurrentWindow();

  const load = useCallback(async () => {
    if (busyRef.current) return;
    try {
      setView(await api.openTasks());
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      window.clearTimeout(undoTimer.current);
    };
  }, [load]);

  const today = localDate();
  const groups = useMemo(() => (view ? groupTasks(view.rows, today, query) : []), [view, today, query]);
  const overdue = view ? view.rows.filter((r) => r.due && r.due < today).length : 0;

  const toggle = async (row: TaskRow, checked: boolean) => {
    busyRef.current = true;
    setBusy(true);
    setNotice(null);
    try {
      const outcome = await api.toggleVaultTask(row.path, row.offset, row.raw, checked);
      if (outcome === "stale") {
        setNotice(`"${plainTitle(row.title)}" changed in its note, so nothing was written. The list is refreshed.`);
        setUndo(null);
      } else if (checked) {
        setUndo({ row });
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

  const openNote = (row: TaskRow) => void api.openNoteByPath(row.path).catch((e) => setNotice(String(e)));

  return (
    <div className="tracker tasks-window">
      <div className="titlebar" data-tauri-drag-region>
        <span className="title" data-tauri-drag-region>
          OPEN TASKS{view ? ` (${view.rows.length}${view.truncated ? "+" : ""})` : ""}
        </span>
        <button className="btn" onClick={() => void load()} aria-label="Refresh tasks" title="Refresh">↻</button>
        <button className="btn" onClick={() => void win.hide()} aria-label="Hide tasks window">–</button>
        <button className="btn" onClick={() => void win.close()} aria-label="Close tasks window">✕</button>
      </div>
      <div className="tasks-tools">
        <input className="search tasks-search" placeholder="Filter tasks or notes" aria-label="Filter tasks" value={query} onChange={(e) => setQuery(e.target.value)} />
        {overdue > 0 && <span className="tasks-overdue" role="status">{overdue} overdue</span>}
      </div>
      {error && <div className="error" role="alert">{error}</div>}
      {notice && (
        <div className="error" role="alert">
          {notice} <button className="btn" onClick={() => setNotice(null)} aria-label="Dismiss">✕</button>
        </div>
      )}
      <div className="content tasks-list" role="region" aria-label="Open tasks">
        {!view && !error && <p className="tasks-empty">Reading your notes…</p>}
        {view && view.sources.length === 0 && view.rows.length === 0 && (
          <p className="tasks-empty">No vault or folder to read yet. Add a folder in Settings, or open a note from the launcher.</p>
        )}
        {view && view.rows.length === 0 && view.sources.length > 0 && <p className="tasks-empty">Nothing left to do in {view.sources.join(", ")}.</p>}
        {view && view.rows.length > 0 && groups.length === 0 && <p className="tasks-empty">No task matches "{query}".</p>}
        {groups.map((g) => (
          <section key={g.id}>
            <h4 className={g.id === "overdue" ? "tasks-h overdue" : "tasks-h"}>{GROUP_LABELS[g.id]} ({g.rows.length})</h4>
            <ul className="tasks-ul">
              {g.rows.map((r) => (
                <li key={`${r.path}:${r.offset}`} className="tasks-row">
                  <TaskCheckbox
                    checked={false}
                    label={plainTitle(r.title)}
                    offset={r.offset}
                    disabled={busy || r.recurring}
                    onToggle={() => void toggle(r, true)}
                  />
                  <div className="tasks-main">
                    <span className="tasks-title">{plainTitle(r.title)}</span>
                    <span className="tasks-meta">
                      <button className="tasks-note" onClick={() => openNote(r)} title={`${r.source}: ${r.rel}`}>{r.note}</button>
                      {r.due && <span className={r.due < today ? "tasks-due overdue" : "tasks-due"}>{shortDate(r.due)}</span>}
                      {r.recurring && <span className="tasks-repeat" title="Repeats. Complete it in the app that manages it so the next occurrence is created.">repeats</span>}
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
          <span>Done: {plainTitle(undo.row.title)}</span>
          <button className="btn" onClick={() => void toggle(undo.row, false)} disabled={busy}>UNDO</button>
        </div>
      )}
    </div>
  );
}
