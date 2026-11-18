import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import {
  approxTokens, DESTINATION, fingerprint, mergedItems, mint, skipsDialog, totalChars,
  type Approved, type ReceiptRequest,
} from "../../services/receipt";
import "./receipt.css";

interface Pending {
  reqs: ReceiptRequest[];
  resolve: (a: Approved[] | null) => void;
}

type ApproveFn = (reqs: ReceiptRequest[]) => Promise<Approved[] | null>;

const ReceiptContext = createContext<ApproveFn | null>(null);

/**
 * Asks for approval of one or more requests. Resolves to one `Approved` per request, in order, or null when the user
 * declined. Several requests that share a transcript are shown in a single dialog.
 */
export function useReceipt(): ApproveFn {
  const fn = useContext(ReceiptContext);
  if (!fn) throw new Error("ReceiptProvider is missing: AI calls need an approval dialog.");
  return fn;
}

export function ReceiptProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const queue = useRef<Pending[]>([]);
  const remembered = useRef(new Set<string>());

  const show = useCallback(() => setPending(queue.current[0] ?? null), []);

  const approve = useCallback<ApproveFn>((reqs) => {
    if (skipsDialog(reqs) || reqs.every((r) => remembered.current.has(fingerprint(r)))) {
      return Promise.resolve(reqs.map(mint));
    }
    return new Promise((resolve) => {
      queue.current.push({ reqs, resolve });
      if (queue.current.length === 1) show();
    });
  }, [show]);

  const settle = (result: Approved[] | null, rememberIt: boolean) => {
    const head = queue.current.shift();
    if (!head) return;
    if (result && rememberIt) head.reqs.forEach((r) => remembered.current.add(fingerprint(r)));
    head.resolve(result);
    show();
  };

  return (
    <ReceiptContext.Provider value={approve}>
      {children}
      {pending && (
        <ReceiptDialog
          reqs={pending.reqs}
          onSend={(remember) => settle(pending.reqs.map(mint), remember)}
          onCancel={() => settle(null, false)}
        />
      )}
    </ReceiptContext.Provider>
  );
}

const PREVIEW_CHARS = 600;

export function ReceiptDialog({ reqs, onSend, onCancel }: { reqs: ReceiptRequest[]; onSend: (remember: boolean) => void; onCancel: () => void }) {
  const [remember, setRemember] = useState(false);
  const sendRef = useRef<HTMLButtonElement>(null);
  const items = mergedItems(reqs);
  const chars = reqs.reduce((n, r) => n + totalChars(r), 0);
  const purposes = [...new Set(reqs.map((r) => r.purpose))];

  useEffect(() => {
    sendRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

  return (
    <div className="receipt-overlay" role="dialog" aria-modal="true" aria-label="Review what will be sent">
      <div className="receipt">
        <h3 className="receipt-title">SEND TO AI?</h3>
        <p className="receipt-lead">
          {purposes.join(" · ")}. This text leaves your computer and goes to <strong>{DESTINATION}</strong>. Nothing else is sent.
        </p>
        <div className="receipt-body">
        <div className="receipt-items">
          {items.map((i, n) => (
            <div className="receipt-item" key={`${i.label}-${n}`}>
              <div className="receipt-item-head">
                <strong>{i.label}</strong>
                <span>{i.text.length.toLocaleString()} characters{i.typed ? " · typed by you" : ""}</span>
              </div>
              {i.note && <div className="receipt-note">{i.note}</div>}
              <pre className="receipt-text">{i.text.length > PREVIEW_CHARS ? `${i.text.slice(0, PREVIEW_CHARS)}…` : i.text}</pre>
              {i.text.length > PREVIEW_CHARS && (
                <details>
                  <summary>Show all {i.text.length.toLocaleString()} characters</summary>
                  <pre className="receipt-text">{i.text}</pre>
                </details>
              )}
            </div>
          ))}
        </div>
        <details className="receipt-exact">
          <summary>Exact text sent{reqs.length > 1 ? ` (${reqs.length} requests)` : ""}, including instructions to the AI</summary>
          {reqs.map((r, n) => (
            <div key={n}>
              <div className="receipt-note">{r.purpose}: instructions</div>
              <pre className="receipt-text">{r.system}</pre>
              <div className="receipt-note">{r.purpose}: message</div>
              <pre className="receipt-text">{r.user}</pre>
            </div>
          ))}
        </details>
        <p className="receipt-total">
          Total about {chars.toLocaleString()} characters (roughly {approxTokens(chars).toLocaleString()} tokens)
          {reqs.length > 1 ? ` across ${reqs.length} requests` : ""}.
        </p>
        <label className="receipt-remember">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Don't ask again for this unchanged text while the app is open
        </label>
        </div>
        <div className="receipt-actions">
          <button ref={sendRef} className="btn primary" onClick={() => onSend(remember)}>SEND</button>
          <button className="btn" onClick={onCancel}>CANCEL</button>
        </div>
      </div>
    </div>
  );
}
