import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "../../services/api";
import { parseDocument, type TaskInfo } from "../../services/markdownParser";
import {
  applyToggle,
  describeToggleError,
  resolveTaskAfterChange,
  staleSnapshot,
  statusFromEvent,
  utf8Offset,
} from "../../services/markdownSync";
import { MarkdownRenderer } from "../MarkdownRenderer/MarkdownRenderer";
import { ProgressBar } from "../ProgressBar/ProgressBar";
import { AiEditPanel } from "../AiEdit/AiEditPanel";
import { NotionSend } from "../Notion/NotionSend";
import { AskPanel } from "../AiAsk/AskPanel";
import { ContextPanel } from "../Context/ContextPanel";
import { locateSelection } from "../../services/aiEdit";
import type { FileSnapshot, FileStatus, SyncEvent, TrackedFile } from "../../types";

export function TrackerWindow({ id }: { id: string }) {
  const [info, setInfo] = useState<TrackedFile | null>(null);
  const [snap, setSnap] = useState<FileSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [status, setStatus] = useState<FileStatus>({ kind: "ok" });
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const snapRef = useRef<FileSnapshot | null>(null);
  const pendingExternal = useRef<SyncEvent | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const savedScroll = useRef<number | null>(null);
  // Edit mode: `draft` is the textarea text, `editBase` the file version it was started from.
  const [draft, setDraft] = useState<string | null>(null);
  const editBase = useRef<FileSnapshot | null>(null);
  const editing = draft !== null;
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // AI edit: results land in the edit draft (never straight on disk); `aiUndo` holds earlier drafts.
  const [aiOpen, setAiOpen] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const [notionOpen, setNotionOpen] = useState(false);
  const [ctxOpen, setCtxOpen] = useState(false);
  const [aiUndo, setAiUndo] = useState<string[]>([]);
  const [aiSelection, setAiSelection] = useState<{ start: number; end: number } | null>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const editingRef = useRef(false);
  editingRef.current = editing;

  snapRef.current = snap;

  useEffect(() => {
    api.trackerInfo(id).then(setInfo).catch((e) => setError(String(e)));
    api.readTrackerFile(id).then(setSnap).catch((e) => setError(String(e)));
  }, [id]);

  // Keep the reader's place when the content is replaced by an external change.
  useLayoutEffect(() => {
    if (savedScroll.current != null && contentRef.current) {
      contentRef.current.scrollTop = savedScroll.current;
      savedScroll.current = null;
    }
  }, [snap]);

  const applyExternal = (ev: SyncEvent) => {
    setStatus(statusFromEvent(ev));
    if (ev.kind !== "changed") return;
    if (snapRef.current?.hash === ev.hash) return; // already showing this version
    savedScroll.current = contentRef.current?.scrollTop ?? null;
    setSnap({ content: ev.content, hash: ev.hash });
    setNotice(null);
  };
  const applyExternalRef = useRef(applyExternal);
  applyExternalRef.current = applyExternal;

  useEffect(() => {
    const un = listen<SyncEvent>("tracker-sync", (e) => {
      // While a write is in flight the displayed snapshot is provisional; apply afterwards.
      if (busyRef.current) pendingExternal.current = e.payload;
      else applyExternalRef.current(e.payload);
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  const toggle = async (task: TaskInfo) => {
    if (busyRef.current || !snap) return;
    busyRef.current = true;
    setBusy(true);
    setNotice(null);
    let known = snap; // last version known to match the file on disk
    const next = !task.checked;
    const send = (s: FileSnapshot, t: TaskInfo) =>
      api.toggleTask(id, s.hash, utf8Offset(s.content, t.offset), next);
    try {
      // Optimistic update; confirmed or rolled back once the native write returns.
      setSnap({ ...known, content: applyToggle(known.content, task.offset, next) });
      try {
        setSnap(await send(known, task));
      } catch (e) {
        const fresh = staleSnapshot(e);
        if (!fresh) throw e;
        // The file changed under us: never write stale offsets. Re-identify the task first.
        known = fresh;
        const r = resolveTaskAfterChange(parseDocument(fresh.content), task, next);
        if (r.action === "retry") {
          setSnap(fresh);
          setSnap(await send(fresh, r.task));
          setNotice("The file changed externally; your change was applied to the latest version.");
        } else {
          setSnap(fresh);
          setNotice(
            r.action === "satisfied"
              ? "The file changed externally; that task already had the requested state."
              : "The file changed externally and that task could not be identified safely, so nothing was written.",
          );
        }
      }
    } catch (e) {
      const { snapshot, message } = describeToggleError(e);
      setSnap(snapshot ?? known);
      setNotice(message);
    } finally {
      busyRef.current = false;
      setBusy(false);
      const queued = pendingExternal.current;
      pendingExternal.current = null;
      if (queued) applyExternalRef.current(queued);
    }
  };

  const startEdit = () => {
    if (!snap || busy) return;
    editBase.current = snap;
    setNotice(null);
    setDraft(snap.content);
  };

  const cancelEdit = () => {
    if (draft !== null && draft !== editBase.current?.content && !confirmDiscard) {
      setConfirmDiscard(true); // second press discards
      return;
    }
    setConfirmDiscard(false);
    setDraft(null);
    setAiUndo([]);
    editBase.current = null;
  };

  const openAi = () => {
    if (!snap) return;
    let sel: { start: number; end: number } | null = null;
    const ta = editorRef.current;
    if (ta) {
      if (ta.selectionEnd > ta.selectionStart && ta.value.slice(ta.selectionStart, ta.selectionEnd).trim()) {
        sel = { start: ta.selectionStart, end: ta.selectionEnd };
      }
    } else {
      const text = window.getSelection()?.toString() ?? "";
      if (text.trim() && contentRef.current?.contains(window.getSelection()?.anchorNode ?? null)) {
        sel = locateSelection(snap.content, text);
      }
    }
    setAiSelection(sel);
    setAiOpen(true);
  };

  const applyAi = (next: string) => {
    if (!snap) return;
    if (draft === null) editBase.current = snap;
    setAiUndo((u) => [...u, draft ?? snap.content]);
    setDraft(next);
    setNotice(null);
    setAiOpen(false);
  };

  const undoAi = () => {
    setAiUndo((u) => {
      if (!u.length) return u;
      setDraft(u[u.length - 1]);
      return u.slice(0, -1);
    });
  };

  const saveEdit = async () => {
    const base = editBase.current;
    if (draft === null || !base || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      if (draft === base.content && snapRef.current?.hash === base.hash) {
        setDraft(null);
        setAiUndo([]);
        return;
      }
      const saved = await api.saveTrackerContent(id, base.hash, draft);
      setSnap(saved);
      setDraft(null);
      setAiUndo([]);
      editBase.current = null;
      setNotice(null);
    } catch (e) {
      const { snapshot, message } = describeToggleError(e);
      if (snapshot) {
        // Keep the user's text; the next SAVE deliberately replaces the newer disk version.
        editBase.current = snapshot;
        setSnap(snapshot);
        setNotice("The file changed on disk while you were editing. Your text is kept; press SAVE again to overwrite it, or CANCEL to discard yours.");
      } else {
        setNotice(message);
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
      const queued = pendingExternal.current;
      pendingExternal.current = null;
      if (queued) applyExternalRef.current(queued);
    }
  };

  const retry = async () => {
    try {
      const fresh = await api.reloadTracker(id);
      setStatus({ kind: "ok" });
      setSnap(fresh);
      setNotice(null);
    } catch (e) {
      setNotice(String(e));
    }
  };

  // Keyboard: Esc hides the tracker (it keeps its state and can be summoned again).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !editingRef.current) void getCurrentWindow().hide();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const doc = useMemo(() => (snap ? parseDocument(snap.content) : null), [snap]);
  const win = getCurrentWindow();
  const unavailable = status.kind !== "ok";

  return (
    <div className="tracker">
      <div className="titlebar" data-tauri-drag-region>
        <span className="title" data-tauri-drag-region>{info?.display_name ?? "…"}</span>
        <button className="btn" onClick={openAi} onMouseDown={(e) => e.preventDefault()} disabled={!snap || unavailable || busy || aiOpen} aria-label="Edit with AI">AI</button>
        <button className="btn" onClick={() => setAskOpen(true)} disabled={!snap || askOpen || aiOpen} aria-label="Ask AI about this file" title="Ask a question about this file">ASK</button>
        <button className="btn" onClick={() => setCtxOpen((o) => !o)} disabled={!snap} aria-pressed={ctxOpen} aria-label="Show linked notes" title="Backlinks, links and tags">LINKS</button>
        <button className="btn" onClick={() => setNotionOpen(true)} disabled={!snap || unavailable || notionOpen} aria-label="Send to Notion" title="Create a Notion page from this note">NOTION</button>
        {!editing && (
          <button className="btn" onClick={startEdit} disabled={!snap || unavailable} aria-label="Edit Markdown source">EDIT</button>
        )}
        <button className="btn" onClick={() => void win.hide()} aria-label="Hide tracker">–</button>
        <button className="btn" onClick={() => void win.close()} aria-label="Close tracker">✕</button>
      </div>
      {ctxOpen && !editing && !aiOpen && !askOpen && <ContextPanel
          id={id}
          refreshKey={snap?.hash ?? ""}
          onClose={() => setCtxOpen(false)}
        />}
      {!editing && !aiOpen && !askOpen && doc && doc.total > 0 && <ProgressBar done={doc.done} total={doc.total} />}
      {unavailable && (
        <div className="error" role="alert">
          {status.kind === "missing"
            ? "File not found. It may have been deleted, moved or renamed. Showing the last known content."
            : `${status.kind === "unreadable" ? status.message : ""} Showing the last known content.`}{" "}
          <button className="btn" onClick={() => void retry()}>RETRY</button>
        </div>
      )}
      {notice && (
        <div className="error" role="alert">
          {notice}{" "}
          <button className="btn" onClick={() => setNotice(null)} aria-label="Dismiss">✕</button>
        </div>
      )}
      {editing && !aiOpen && !askOpen && (
        <div className="editbar">
          <button className="btn primary" onClick={() => void saveEdit()} disabled={busy}>SAVE</button>
          <button className="btn" onClick={cancelEdit} disabled={busy}>{confirmDiscard ? "DISCARD?" : "CANCEL"}</button>
          <button className="btn" onClick={undoAi} disabled={busy || aiUndo.length === 0} title="Undo the last AI edit">UNDO AI</button>
          <span className="hint">Cmd/Ctrl+S saves</span>
        </div>
      )}
      {notionOpen && snap && <NotionSend noteId={id} content={draft ?? snap.content} fileName={info?.display_name ?? "note"} onClose={() => setNotionOpen(false)} />}
      {askOpen && snap ? (
        <AskPanel noteId={id} content={draft ?? snap.content} fileName={info?.display_name ?? "this file"} onClose={() => setAskOpen(false)} />
      ) : aiOpen && snap ? (
        <AiEditPanel
          content={draft ?? snap.content}
          currentHash={snap.hash}
          selection={aiSelection}
          onApply={applyAi}
          onClose={() => setAiOpen(false)}
        />
      ) : editing ? (
        <textarea
          ref={editorRef}
          className="editor"
          value={draft}
          autoFocus
          spellCheck={false}
          aria-label="Markdown source"
          onChange={(e) => { setDraft(e.target.value); setConfirmDiscard(false); }}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
              e.preventDefault();
              void saveEdit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancelEdit();
            }
          }}
        />
      ) : (
      <div
        className="content"
        ref={contentRef}
        tabIndex={0}
        role="region"
        aria-label={info?.display_name ?? "Document"}
      >
        {error ? (
          <div className="error" role="alert">{error}</div>
        ) : (
          snap && (
            <MarkdownRenderer
              source={snap.content}
              doc={doc ?? undefined}
              busy={busy || unavailable}
              onToggleTask={(t) => void toggle(t)}
              onOpenLink={(u) => void api.openExternal(u).catch((e) => setError(String(e)))}
              onOpenWikilink={(t) =>
                void api
                  .openWikilink(id, t)
                  .then((found) => setNotice(found ? null : `No note named "${t.split("#")[0].split("|")[0]}" was found in this vault or your watched folders.`))
                  .catch((e) => setNotice(String(e)))
              }
            />
          )
        )}
      </div>
      )}
    </div>
  );
}
