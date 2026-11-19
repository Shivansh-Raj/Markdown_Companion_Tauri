import { useCallback, useEffect, useState } from "react";
import { api } from "../../services/api";
import type { NoteContext, NoteRef } from "../../types";
import "./context.css";

function NoteButton({ n, onOpen, suffix, title }: { n: NoteRef; onOpen: (n: NoteRef) => void; suffix?: string; title?: string }) {
  return (
    <button className="ctx-note" onClick={() => onOpen(n)} title={title ?? n.rel}>
      {n.name}
      {suffix && <span className="ctx-count">{suffix}</span>}
    </button>
  );
}

/** Backlinks, outgoing links and tags for the open note, read from a local index of its vault or watched folder. */
export function ContextPanel({ id, refreshKey, onClose, onOpenInObsidian }: { id: string; refreshKey: string; onClose: () => void; onOpenInObsidian?: () => void }) {
  const [ctx, setCtx] = useState<NoteContext | null | undefined>(undefined); // undefined = loading, null = not in a vault
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    api
      .noteContext(id)
      .then((c) => { if (live) { setCtx(c); setError(null); } })
      .catch((e) => { if (live) setError(String(e)); });
    return () => { live = false; };
  }, [id, refreshKey, tick]);

  const open = useCallback(
    (n: NoteRef) => void api.openVaultNote(id, n.path).catch((e) => setError(String(e))),
    [id],
  );

  return (
    <div className="ctx-panel" role="region" aria-label="Linked notes">
      <div className="ctx-head">
        <strong>{ctx ? `${ctx.is_vault ? "VAULT" : "FOLDER"}: ${ctx.vault_name}` : "LINKED NOTES"}</strong>
        {onOpenInObsidian && (
          <button className="btn" onClick={onOpenInObsidian} title="Open this note in Obsidian (it must be inside a vault)">OBSIDIAN</button>
        )}
        <button className="btn" onClick={() => setTick((t) => t + 1)} aria-label="Refresh links">↻</button>
        <button className="btn" onClick={onClose} aria-label="Close linked notes">✕</button>
      </div>
      {error && <div className="error" role="alert">{error}</div>}
      {ctx === undefined && !error && <div className="ctx-empty">Indexing…</div>}
      {ctx === null && (
        <div className="ctx-empty">
          This note is not in an Obsidian vault or a watched folder. Add its folder in the launcher to see links.
        </div>
      )}
      {ctx && (
        <>
          <section>
            <h4>BACKLINKS ({ctx.backlinks.length})</h4>
            {ctx.backlinks.length === 0 ? (
              <div className="ctx-empty">No other note links here.</div>
            ) : (
              <div className="ctx-list">
                {ctx.backlinks.map((b) => <NoteButton key={b.path} n={b} onOpen={open} suffix={b.count > 1 ? `×${b.count}` : undefined} />)}
              </div>
            )}
          </section>
          <section>
            <h4>LINKS ({ctx.outgoing.length})</h4>
            {ctx.outgoing.length === 0 ? (
              <div className="ctx-empty">This note links to nothing.</div>
            ) : (
              <div className="ctx-list">
                {ctx.outgoing.map((o) =>
                  o.target ? (
                    <NoteButton key={o.target.path + o.label} n={o.target} onOpen={open} />
                  ) : (
                    <span key={o.label} className="ctx-missing" title="No note with this name in the vault">{o.label}</span>
                  ),
                )}
              </div>
            )}
          </section>
          {ctx.related.length > 0 && (
            <section>
              <h4>RELATED, NOT LINKED ({ctx.related.length})</h4>
              <div className="ctx-list">
                {ctx.related.map((r) => (
                  <NoteButton key={r.note.path} n={r.note} onOpen={open} title={`${r.note.rel}\nShares: ${r.why.join(", ")}`} suffix={r.why.slice(0, 2).join(" · ")} />
                ))}
              </div>
            </section>
          )}
          {ctx.tags.length > 0 && (
            <section>
              <h4>TAGS</h4>
              <div className="ctx-list">{ctx.tags.map((t) => <span key={t} className="ctx-tag">#{t}</span>)}</div>
            </section>
          )}
          <div className="ctx-foot">
            {ctx.note_count} notes indexed
            {ctx.skipped.length > 0 && (
              <span title={ctx.skipped.join("\n")}> · {ctx.skipped.length} skipped</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
