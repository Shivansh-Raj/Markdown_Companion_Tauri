import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api } from "../../services/api";
import { DASHBOARD_FOLDER, dashboardFiles } from "../../services/dashboards";
import type { InstallResult, VaultCandidate } from "../../types";

/** Adds Obsidian Bases dashboards (`.base` files) for the properties MC writes in Obsidian-format exports. */
export function DashboardsInstaller() {
  const [vaults, setVaults] = useState<VaultCandidate[]>([]);
  const [vault, setVault] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<InstallResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const files = dashboardFiles();

  useEffect(() => {
    api.vaultCandidates().then((v) => { setVaults(v); setVault((cur) => cur || v[0]?.path || ""); }).catch(() => {});
  }, []);

  const choose = async () => {
    try {
      const picked = await open({ directory: true, multiple: false });
      if (typeof picked === "string") { setVault(picked); setResult(null); setError(null); }
    } catch (e) {
      setError(String(e));
    }
  };

  const install = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await api.installBaseFiles(vault, DASHBOARD_FOLDER, files.map(({ name, content }) => ({ name, content }))));
    } catch (e) {
      setError(String(e));
    }
    setBusy(false);
  };

  return (
    <>
      <h2>OBSIDIAN DASHBOARDS</h2>
      <p className="note">
        Adds {files.length} Obsidian Bases files that chart what MC exports: meetings, speaking practice and all voice sessions. They read your notes'
        properties, so export with <strong>Obsidian format</strong> ticked. Nothing is sent anywhere, and existing files are never overwritten.
      </p>
      <div className="row-flex">
        {vaults.length > 0 && (
          <select className="search" style={{ margin: 0, flex: 1, minWidth: 140 }} aria-label="Vault" value={vault} onChange={(e) => { setVault(e.target.value); setResult(null); }}>
            {!vaults.some((v) => v.path === vault) && vault && <option value={vault}>{vault}</option>}
            {vaults.map((v) => <option key={v.path} value={v.path}>{v.name}</option>)}
          </select>
        )}
        <button className="btn" onClick={() => void choose()}>CHOOSE VAULT</button>
      </div>
      {vault && <p className="note" title={vault}>Files go in <code>{DASHBOARD_FOLDER}/</code> inside {vault}</p>}
      <ul className="dash-list">
        {files.map((f) => <li key={f.name}><strong>{f.name}</strong>: {f.summary}</li>)}
      </ul>
      <button className="btn primary" disabled={!vault || busy} onClick={() => void install()}>{busy ? "ADDING…" : "ADD DASHBOARDS"}</button>
      {result && (
        <ul className="dash-list" role="status">
          {result.map((r) => <li key={r.name}>{r.written ? "Added" : "Already there, left unchanged"}: {r.name}</li>)}
        </ul>
      )}
      {error && <div className="error" role="alert" style={{ margin: "8px 0 0" }}>{error}</div>}
    </>
  );
}
