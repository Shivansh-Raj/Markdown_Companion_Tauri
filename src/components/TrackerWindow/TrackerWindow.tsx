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
      if (e.key === "Escape") void getCurrentWindow().hide();
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
        <button className="btn" onClick={() => void win.hide()} aria-label="Hide tracker">–</button>
        <button className="btn" onClick={() => void win.close()} aria-label="Close tracker">✕</button>
      </div>
      {doc && doc.total > 0 && <ProgressBar done={doc.done} total={doc.total} />}
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
            />
          )
        )}
      </div>
    </div>
  );
}
