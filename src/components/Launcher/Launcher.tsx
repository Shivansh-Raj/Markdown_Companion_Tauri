import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { api } from "../../services/api";
import { prettyAccelerator } from "../../services/accelerator";
import { filterFiles } from "../../services/search";
import { Settings } from "../Settings/Settings";
import { AiCreate } from "../AiCreate/AiCreate";
import type { DiscoveredFile, FileEntry, LauncherInfo } from "../../types";

const isMac = typeof navigator !== "undefined" && /mac/i.test(navigator.platform);

type Item =
  | (FileEntry & { kind: "tracked" })
  | (DiscoveredFile & { kind: "discovered"; last_opened_at?: null });

function parentFolder(path: string) {
  const parts = path.split(/[\\/]/);
  return parts.slice(0, -1).join("/") || "/";
}

export function Launcher() {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [discovered, setDiscovered] = useState<DiscoveredFile[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<LauncherInfo | null>(null);
  const [view, setView] = useState<"list" | "settings" | "ai">("list");
  const input = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    setFiles(await api.listFiles());
    setInfo(await api.launcherInfo());
    setDiscovered(await api.listDiscovered());
  }, []);

  useEffect(() => {
    refresh().catch((e) => setError(String(e)));
    const un = listen<{ view: "list" | "settings" }>("launcher-shown", (e) => {
      setQuery("");
      setSelected(0);
      setError(null);
      setView(e.payload?.view === "settings" ? "settings" : "list");
      refresh().catch((err) => setError(String(err)));
      input.current?.focus();
    });
    return () => {
      un.then((f) => f());
    };
  }, [refresh]);

  const items = useMemo<Item[]>(
    () =>
      filterFiles<Item>(
        [
          ...files.map((f) => ({ ...f, kind: "tracked" as const })),
          ...discovered.map((d) => ({ ...d, kind: "discovered" as const })),
        ],
        query,
      ),
    [files, discovered, query],
  );

  // Keep the highlighted row visible when navigating with the keyboard.
  useEffect(() => {
    document.getElementById(`opt-${selected}`)?.scrollIntoView({ block: "nearest" });
  }, [selected, items.length]);

  const openItem = async (item: Item) => {
    try {
      const id = item.kind === "tracked" ? item.id : (await api.registerFile(item.canonical_path)).id;
      await api.openTracker(id);
      await api.hideLauncher();
    } catch (e) {
      setError(String(e));
    }
  };

  const forget = async (item: Item) => {
    if (item.kind !== "tracked") return;
    try {
      await api.unregisterFile(item.id);
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  const addFile = async () => {
    try {
      const picked = await open({
        multiple: false,
        filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
      });
      if (typeof picked !== "string") return;
      const file = await api.registerFile(picked);
      await refresh();
      await api.openTracker(file.id);
      await api.hideLauncher();
    } catch (e) {
      setError(String(e));
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === ",") {
      e.preventDefault();
      setView((v) => (v === "settings" ? "list" : "settings"));
    } else if (view === "settings" || view === "ai") {
      return; // these panels handle their own keys
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === "Home" && e.ctrlKey) {
      setSelected(0);
    } else if (e.key === "Enter" && items[selected]) {
      void openItem(items[selected]);
    } else if (e.key === "Escape") {
      void api.hideLauncher();
    }
  };

  return (
    <div className="launcher" onKeyDown={onKeyDown}>
      <div className="titlebar" data-tauri-drag-region>
        <span className="title" data-tauri-drag-region>MD COMPANION</span>
        <button
          className="btn"
          onClick={() => setView((v) => (v === "settings" ? "list" : "settings"))}
          aria-label={view === "settings" ? "Back to files" : "Settings"}
          aria-pressed={view === "settings"}
        >
          ⚙
        </button>
        <button className="btn" onClick={() => void api.hideLauncher()} aria-label="Close launcher">
          ✕
        </button>
      </div>

      {view === "ai" ? (
        <AiCreate
          onBack={() => setView("list")}
          onCreated={() => {
            void refresh().catch(() => {});
            setView("list");
            void api.hideLauncher();
          }}
        />
      ) : view === "settings" ? (
        <Settings onBack={() => setView("list")} onChanged={() => void refresh().catch(() => {})} />
      ) : (
        <>
          <input
            ref={input}
            className="search"
            autoFocus
            placeholder="Search Markdown files…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(0);
            }}
            role="combobox"
            aria-expanded="true"
            aria-controls="launcher-results"
            aria-activedescendant={items[selected] ? `opt-${selected}` : undefined}
            aria-label="Search files"
          />
          <ul className="results" role="listbox" id="launcher-results" aria-label="Markdown files">
            {items.map((item, i) => (
              <li
                key={item.canonical_path}
                id={`opt-${i}`}
                role="option"
                aria-selected={i === selected}
                className={i === selected ? "row selected" : "row"}
                onMouseEnter={() => setSelected(i)}
                onClick={() => void openItem(item)}
              >
                <span className="name">{item.display_name}</span>
                <span>
                  {item.kind === "tracked" && item.is_open && <span className="badge">OPEN</span>}
                  {item.kind === "discovered" && <span className="badge">FOLDER</span>}
                  {item.kind === "tracked" && (
                    <button
                      className="btn"
                      style={{ marginLeft: 6, padding: "0 5px" }}
                      aria-label={`Remove ${item.display_name} from the list`}
                      title="Remove from list (the file is not deleted)"
                      tabIndex={-1}
                      onClick={(e) => {
                        e.stopPropagation();
                        void forget(item);
                      }}
                    >
                      ✕
                    </button>
                  )}
                </span>
                <span className="path">{parentFolder(item.canonical_path)}</span>
              </li>
            ))}
            {items.length === 0 && (
              <li className="empty" role="presentation">
                {files.length + discovered.length === 0
                  ? "No files yet. Add a Markdown file or a watched folder."
                  : "No matches."}
              </li>
            )}
          </ul>
          {error && <div className="error" role="alert">{error}</div>}
          {info?.shortcut_error && <div className="error" role="alert">{info.shortcut_error}</div>}
          <div className="footer">
            <span style={{ display: "flex", gap: 8 }}>
              <button className="btn primary" onClick={() => void addFile()}>+ ADD FILE</button>
              <button className="btn" onClick={() => setView("ai")}>✎ NEW WITH AI</button>
            </span>
            <span className="hint">
              ↑↓ select · Enter open · Esc close · {isMac ? "⌘" : "Ctrl+"}, settings
              {info && ` · ${prettyAccelerator(info.shortcut, isMac)} toggles`}
            </span>
          </div>
        </>
      )}
      {view === "settings" && error && <div className="error" role="alert">{error}</div>}
    </div>
  );
}
