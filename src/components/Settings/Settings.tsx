import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api } from "../../services/api";
import { acceleratorFromEvent, prettyAccelerator } from "../../services/accelerator";
import { THEME_OPTIONS } from "../../services/themeContext";
import { testKey } from "../../services/ai";
import { animationsEnabled, setAnimationsEnabled } from "../../services/animations";
import type { Settings as SettingsModel, ThemeName } from "../../types";

const isMac = typeof navigator !== "undefined" && /mac/i.test(navigator.platform);

export function Settings({ onBack, onChanged }: { onBack: () => void; onChanged: () => void }) {
  const [settings, setSettings] = useState<SettingsModel | null>(null);
  const [folders, setFolders] = useState<string[]>([]);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasKey, setHasKey] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");
  const [keyMsg, setKeyMsg] = useState<string | null>(null);
  const [saveDir, setSaveDir] = useState("");
  const [anim, setAnim] = useState(animationsEnabled());

  useEffect(() => {
    api.getGroqKey().then((k) => setHasKey(!!k)).catch(() => {});
    api.getSaveDir().then(setSaveDir).catch(() => {});
    api.getSettings().then(setSettings).catch((e) => setError(String(e)));
    api.listFolders().then(setFolders).catch((e) => setError(String(e)));
  }, []);

  const fail = (e: unknown) => setError(String(e));

  const save = (theme: ThemeName, reopen: boolean) => {
    setError(null);
    api.setSettings(theme, reopen).then(setSettings).catch(fail);
  };

  const addFolder = async () => {
    try {
      const picked = await open({ directory: true, multiple: false });
      if (typeof picked !== "string") return;
      await api.addFolder(picked);
      setFolders(await api.listFolders());
      setError(null);
      onChanged();
    } catch (e) {
      fail(e);
    }
  };

  const removeFolder = (path: string) => {
    api.removeFolder(path).then(async () => {
      setFolders(await api.listFolders());
      onChanged();
    }).catch(fail);
  };

  const saveKey = async (value: string) => {
    try {
      await api.setGroqKey(value);
      setHasKey(!!value.trim());
      setKeyDraft("");
      setKeyMsg(value.trim() ? "Key saved." : "Key removed.");
    } catch (e) {
      fail(e);
    }
  };

  const runKeyTest = async () => {
    setKeyMsg("Testing…");
    try {
      const key = keyDraft.trim() || (await api.getGroqKey());
      if (!key) return setKeyMsg("Enter a key first.");
      const model = await testKey(key);
      setKeyMsg(`Key works. Will use ${model}.`);
    } catch (e) {
      setKeyMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const chooseSaveDir = async (reset: boolean) => {
    try {
      if (reset) await api.setSaveDir(null);
      else {
        const picked = await open({ directory: true, multiple: false });
        if (typeof picked !== "string") return;
        await api.setSaveDir(picked);
      }
      setSaveDir(await api.getSaveDir());
      setError(null);
    } catch (e) {
      fail(e);
    }
  };

  const onRecordKey = (e: React.KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") return setRecording(false);
    const accel = acceleratorFromEvent(e.nativeEvent);
    if (!accel) return; // keep waiting for a valid combination
    setRecording(false);
    api
      .setShortcut(accel)
      .then((shortcut) => {
        setSettings((s) => (s ? { ...s, shortcut } : s));
        setError(null);
      })
      .catch(fail);
  };

  if (!settings) return <div className="settings">{error ?? "Loading…"}</div>;

  return (
    <div
      className="settings"
      onKeyDown={(e) => {
        if (e.key === "Escape") onBack();
      }}
    >
      <h2>THEME</h2>
      <fieldset>
        <legend>Appearance</legend>
        {THEME_OPTIONS.map((t) => (
          <label key={t.id}>
            <input
              type="radio"
              name="theme"
              checked={settings.theme === t.id}
              onChange={() => save(t.id, settings.reopen_on_launch)}
            />
            {t.label}
          </label>
        ))}
      </fieldset>

      <h2>SHORTCUT</h2>
      <div className="row-flex">
        <span className="kbd" aria-label="Current shortcut">{prettyAccelerator(settings.shortcut, isMac)}</span>
        {recording ? (
          <input
            className="search"
            style={{ margin: 0 }}
            autoFocus
            readOnly
            value="Press the new shortcut… (Esc cancels)"
            aria-label="Press the new shortcut"
            onKeyDown={onRecordKey}
            onBlur={() => setRecording(false)}
          />
        ) : (
          <button className="btn" onClick={() => setRecording(true)}>CHANGE</button>
        )}
      </div>

      <h2>STARTUP</h2>
      <label>
        <input
          type="checkbox"
          checked={settings.reopen_on_launch}
          onChange={(e) => save(settings.theme, e.target.checked)}
        />
        Reopen trackers that were open when the app quit
      </label>

      <h2>AI</h2>
      <div className="row-flex">
        <input
          className="search"
          style={{ margin: 0, flex: 1, minWidth: 140 }}
          type="password"
          autoComplete="off"
          placeholder={hasKey ? "Key saved. Paste a new one to replace" : "Groq API key (gsk_…)"}
          aria-label="Groq API key"
          value={keyDraft}
          onChange={(e) => setKeyDraft(e.target.value)}
        />
        <button className="btn primary" disabled={!keyDraft.trim()} onClick={() => void saveKey(keyDraft)}>SAVE</button>
        <button className="btn" disabled={!hasKey && !keyDraft.trim()} onClick={() => void runKeyTest()}>TEST</button>
        {hasKey && <button className="btn" onClick={() => void saveKey("")}>REMOVE</button>}
      </div>
      {keyMsg && <p className="note" role="status">{keyMsg}</p>}
      <p className="note">Stored only on this computer and sent only to api.groq.com.</p>
      <h2>AI FILES SAVE TO</h2>
      <div className="folder">
        <span title={saveDir}>{saveDir}</span>
        <button className="btn" onClick={() => void chooseSaveDir(false)}>CHANGE</button>
        <button className="btn" onClick={() => void chooseSaveDir(true)}>DEFAULT</button>
      </div>
      <h2>MOTION</h2>
      <label>
        <input
          type="checkbox"
          checked={anim}
          onChange={(e) => {
            setAnim(e.target.checked);
            setAnimationsEnabled(e.target.checked);
          }}
        />
        Animations (checkmarks, diffs, transitions)
      </label>

      <h2>WATCHED FOLDERS</h2>
      {folders.length === 0 && <p className="note">No folders. Add one to find Markdown files in it automatically.</p>}
      {folders.map((f) => (
        <div className="folder" key={f}>
          <span title={f}>{f}</span>
          <button className="btn" onClick={() => removeFolder(f)} aria-label={`Stop watching ${f}`}>✕</button>
        </div>
      ))}
      <p className="note">Scans up to 3 levels deep (500 files max); hidden folders and symlinks are skipped.</p>
      <div style={{ marginTop: 8 }}>
        <button className="btn primary" onClick={() => void addFolder()}>+ ADD FOLDER</button>
      </div>

      {error && <div className="error" role="alert" style={{ margin: "10px 0 0" }}>{error}</div>}
      <div style={{ marginTop: 12 }}>
        <button className="btn" onClick={onBack}>← BACK</button>
      </div>
    </div>
  );
}
