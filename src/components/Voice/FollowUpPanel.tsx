import { useEffect, useRef, useState } from "react";
import { api } from "../../services/api";
import { streamChat } from "../../services/ai";
import { useReceipt } from "../Receipt/ReceiptProvider";
import type { ReceiptRequest } from "../../services/receipt";
import { limitTranscript, timedTranscript, type AnalysisResult } from "../../services/voice/analyses";
import {
  buildFollowUpSystemPrompt, buildFollowUpUserPrompt, buildTopicsSystemPrompt, buildTopicsUserPrompt, followUpMarkdown, matchCheckboxState,
  priorItemsText, priorSummariesText,
  toFollowUps, toTopics, type FollowUpReport, type PriorItem,
} from "../../services/voice/followups";
import type { Section } from "../../services/voice/templates";
import { dateStamp } from "../../services/voice/transcript";
import type { SessionMeta, TranscriptChunk } from "../../services/voice/types";
import { ExportDialog } from "./ExportDialog";

const MAX_MEETINGS = 8;
const MAX_ITEMS = 25;
const MAX_FILES = 80;

function parseResults(rows: string[]): AnalysisResult[] {
  const out: AnalysisResult[] = [];
  for (const r of rows) {
    try { out.push(JSON.parse(r) as AnalysisResult); } catch { /* skip a damaged file */ }
  }
  return out;
}
const newest = (list: AnalysisResult[], type: string) =>
  list.filter((r) => r.type === type).sort((a, b) => b.createdAtMs - a.createdAtMs)[0];

/**
 * Compares earlier meetings' action items with this meeting. The checkbox state comes from the user's real Markdown
 * files; nothing is ticked or edited, and a repeated mention never counts as "unfinished" by itself.
 */
export function FollowUpPanel({ meta, chunks, ready }: { meta: SessionMeta; chunks: TranscriptChunk[]; ready: boolean }) {
  const approve = useReceipt();
  const [report, setReport] = useState<FollowUpReport | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  // Notion tasks the transcript suggests are finished. Marking one done is a separate click, and only if it is unchanged in Notion.
  const [marked, setMarked] = useState<Record<string, string>>({}); // item id -> "done" | message
  const markDone = async (item: PriorItem) => {
    if (!item.notion?.doneStatus) return;
    setMarked((m) => ({ ...m, [item.id]: "…" }));
    try {
      const out = await api.notionTaskSetStatus(item.notion.page, item.notion.status, item.notion.doneStatus);
      setMarked((m) => ({ ...m, [item.id]: out === "done" ? "done" : "That task changed in Notion since this check, so nothing was written." }));
    } catch (e) { setMarked((m) => ({ ...m, [item.id]: String(e) })); }
  };
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    let alive = true;
    api.voiceListAnalyses(meta.id).then((rows) => {
      if (!alive) return;
      const saved = parseResults(rows).filter((r) => (r.type as string) === "followups").sort((a, b) => b.createdAtMs - a.createdAtMs)[0];
      if (saved) setReport((saved as unknown as { report: FollowUpReport }).report ?? null);
    }).catch(() => {});
    return () => { alive = false; abort.current?.abort(); };
  }, [meta.id]);

  const run = async (rethink = false) => {
    setError(null);
    const ctl = new AbortController();
    abort.current = ctl;
    try {
      const apiKey = await api.getGroqKey();
      if (!apiKey) throw new Error("No Groq API key. Add one in the launcher: AI → key.");

      setStatus("Reading earlier meetings…");
      const sessions = (await api.voiceSessions())
        .filter((s) => s.mode === "meeting" && s.id !== meta.id && s.createdAtMs < meta.createdAtMs)
        .slice(0, MAX_MEETINGS);
      let items: PriorItem[] = [];
      const summaries: { title: string; date: string; markdown: string }[] = [];
      for (const s of sessions) {
        const saved = parseResults(await api.voiceListAnalyses(s.id).catch(() => []));
        const actions = newest(saved, "actions");
        const summary = newest(saved, "summary");
        if (summary) summaries.push({ title: s.title, date: dateStamp(s.createdAtMs), markdown: summary.markdown });
        for (const [n, a] of (actions?.items ?? []).entries()) {
          items.push({ id: `${s.id}-${n}`, task: a.task, owner: a.owner, deadline: a.deadline, meetingTitle: s.title, meetingDate: dateStamp(s.createdAtMs), state: "unknown" });
        }
      }
      // Open tasks from your Notion Tasks database join the comparison. They are never changed by the check itself.
      const notionItems: PriorItem[] = [];
      try {
        if (await api.notionConnected() && await api.notionDestination("tasks")) {
          const view = await api.notionTasks();
          for (const t of view.rows.slice(0, 20)) {
            notionItems.push({ id: `notion:${t.id}`, task: t.title, owner: t.owner, deadline: t.due, meetingTitle: `Notion: ${view.database}`, meetingDate: t.due ?? "",
              state: "open", notion: { page: t.id, status: t.status, doneStatus: view.done_status, url: t.url } });
          }
        }
      } catch { /* Notion is optional here: the check still works on earlier meetings */ }
      if (!items.length && !notionItems.length) {
        throw new Error("No earlier action items found. Generate ACTION ITEMS for an earlier meeting first, then check again.");
      }

      setStatus("Checking your Markdown files…");
      const tracked = (await api.listFiles()).slice(0, MAX_FILES);
      const files: { name: string; content: string }[] = [];
      for (const f of tracked) {
        try { files.push({ name: f.display_name, content: (await api.readTrackerFile(f.id)).content }); } catch { /* unreadable file: skip */ }
      }
      items = [...matchCheckboxState(items, files), ...notionItems].slice(0, MAX_ITEMS + 20);

      const { text } = limitTranscript(timedTranscript(chunks));
      const plain = text.replace(/^\[\d+(?::\d+)+\]\s*/gm, "");
      const open = items.filter((i) => i.state !== "done");
      let results: FollowUpReport["results"] = items.map((i) => ({ id: i.id, status: "not_mentioned" as const, evidence: "", note: "" }));
      let dropped = 0;
      // Review both requests together before anything is sent. Your other Markdown files were read on this
      // computer only to match checkbox states; their content is not part of either request.
      const transcriptItem = { label: `Transcript of "${meta.title}"`, text: plain };
      const reqs: ReceiptRequest[] = [];
      if (open.length) {
        reqs.push({
          purpose: "Check earlier action items", system: buildFollowUpSystemPrompt(), user: buildFollowUpUserPrompt(open, plain, rethink), mode: "review",
          items: [{ label: `Open action items from ${sessions.length} earlier meeting${sessions.length === 1 ? "" : "s"}${open.some((i) => i.notion) ? " and your Notion tasks" : ""}`, text: priorItemsText(open) }, transcriptItem],
        });
      }
      if (summaries.length) {
        reqs.push({
          purpose: "Find recurring topics", system: buildTopicsSystemPrompt(), user: buildTopicsUserPrompt(summaries, plain, rethink), mode: "review",
          items: [{ label: "Summaries of earlier meetings", text: priorSummariesText(summaries) }, transcriptItem],
        });
      }
      const approvals = reqs.length ? await approve(reqs) : [];
      if (!approvals) { setStatus(null); abort.current = null; return; }
      let next = 0;
      if (open.length) {
        setStatus("Comparing with this meeting…");
        const raw = await streamChat({ apiKey, approval: approvals[next++], signal: ctl.signal, onText: () => {} });
        const parsed = toFollowUps(raw, open, plain);
        dropped += parsed.dropped;
        results = results.map((r) => parsed.results.find((p) => p.id === r.id) ?? r);
      }
      let topics: FollowUpReport["topics"] = [];
      if (summaries.length) {
        setStatus("Looking for topics that keep coming up…");
        try {
          const raw = await streamChat({ apiKey, approval: approvals[next++], signal: ctl.signal, onText: () => {} });
          const t = toTopics(raw, plain);
          topics = t.topics;
          dropped += t.dropped;
        } catch (e) {
          if (ctl.signal.aborted) throw e; // topics are a bonus: a failure here must not lose the follow-up results
        }
      }
      const r: FollowUpReport = { createdAtMs: Date.now(), items, results, topics, dropped };
      await api.voiceSaveAnalysis(meta.id, "followups", JSON.stringify({ type: "followups", createdAtMs: r.createdAtMs, markdown: followUpMarkdown(r), report: r }));
      setReport(r);
    } catch (e) {
      if (!ctl.signal.aborted) setError(e instanceof Error ? e.message : String(e));
    }
    setStatus(null);
    abort.current = null;
  };

  const sections: Section[] = report
    ? [{ id: "followups", label: "Follow-ups from earlier meetings", suffix: "follow-ups", markdown: followUpMarkdown(report) }]
    : [];

  return (
    <div className="voice-analysis">
      <h3 className="voice-h">FOLLOW-UPS FROM EARLIER MEETINGS</h3>
      <p className="note">Compares earlier action items with this meeting. It reads your Markdown files for each item&apos;s real checkbox. Nothing is ticked or changed.</p>
      <div className="voice-actions">
        {status
          ? <button className="btn" onClick={() => abort.current?.abort()}>STOP</button>
          : <button className="btn" disabled={!ready} onClick={() => void run()}>{report ? "CHECK AGAIN" : "CHECK PREVIOUS MEETINGS"}</button>}
        {report && !status && (
          <button className="btn" onClick={() => void run(true)} title="Not satisfied? Ask the AI to reconsider more strictly">↻ RETHINK</button>
        )}
        {report && !status && <button className="btn" onClick={() => setExporting(true)}>EXPORT AS MARKDOWN…</button>}
        {status && <span className="note">{status}</span>}
      </div>
      {error && <div className="error" role="alert">{error}</div>}
      {report && <pre className="voice-pre">{followUpMarkdown(report)}</pre>}
      {report && report.results.filter((r) => r.status === "resolved" && r.id.startsWith("notion:")).map((r) => {
        const item = report.items.find((i) => i.id === r.id);
        if (!item?.notion) return null;
        return (
          <div key={r.id} className="notion-diff">
            <p className="note">This Notion task sounds finished: “{item.task}”{r.evidence ? ` — “${r.evidence}”` : ""}</p>
            {marked[r.id] === "done" ? <span className="note">Marked done in Notion.</span> : (
              <div className="voice-actions">
                <button className="btn" disabled={!item.notion.doneStatus || marked[r.id] === "…"} onClick={() => void markDone(item)}
                  title={item.notion.doneStatus ? "Sets the task's Status to Done in Notion" : "The Tasks database has no Done option"}>MARK DONE IN NOTION</button>
                {marked[r.id] && marked[r.id] !== "…" && <span className="error">{marked[r.id]}</span>}
              </div>
            )}
          </div>
        );
      })}
      {exporting && <ExportDialog meta={meta} docTitle="follow-ups" sections={sections} onClose={() => setExporting(false)} />}
    </div>
  );
}
