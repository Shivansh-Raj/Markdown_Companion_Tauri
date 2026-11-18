import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ReceiptDialog } from "../components/Receipt/ReceiptProvider";
import { streamChat } from "./ai";
import { askHistoryText, buildAskUserPrompt } from "./aiAsk";
import { buildEditUserPrompt } from "./aiEdit";
import { buildUserPrompt } from "./voice/analyses";
import { buildCoachUserPrompt } from "./voice/coach";
import { buildFollowUpUserPrompt, buildTopicsUserPrompt, priorItemsText, priorSummariesText, type PriorItem } from "./voice/followups";
import { buildNoteUserPrompt } from "./voice/transcript";
import {
  approvedPayload, assertConsistent, fingerprint, hashText, mergedItems, mint, skipsDialog, type Approved, type ReceiptRequest,
} from "./receipt";

const req = (over: Partial<ReceiptRequest> = {}): ReceiptRequest => ({
  purpose: "Ask", system: "SYS", user: 'Document:\n"""\nthe file text\n"""\n\nQuestion: what?',
  mode: "review",
  items: [{ label: "notes.md", text: "the file text" }, { label: "Your question", text: "what?", typed: true }],
  ...over,
});

describe("approval", () => {
  it("carries exactly the approved text and nothing else", () => {
    const a = mint(req());
    expect(approvedPayload(a)).toEqual({ system: "SYS", user: req().user });
  });

  it("cannot be forged: an object that was not minted is rejected", () => {
    expect(() => approvedPayload({ purpose: "x", chars: 1 } as Approved)).toThrow(/approved receipt/);
  });

  it("streamChat refuses to send without a minted approval, before any network call", async () => {
    const fake = { purpose: "x", chars: 1 } as Approved;
    await expect(streamChat({ apiKey: "k", approval: fake, signal: new AbortController().signal, onText: () => {} })).rejects.toThrow(/approved receipt/);
  });

  it("refuses a receipt whose items are not part of what is sent", () => {
    expect(() => mint(req({ items: [{ label: "notes.md", text: "text that is not sent" }] }))).toThrow(/not part of the text/);
  });

  it("refuses 'typed' for text the user did not type", () => {
    expect(() => assertConsistent(req({ mode: "typed" }))).toThrow(/did not type/);
    const ok = req({ mode: "typed", items: [{ label: "Your question", text: "what?", typed: true }] });
    expect(() => assertConsistent(ok)).not.toThrow();
  });
});

describe("when a dialog is needed", () => {
  it("is skipped only for typed text and standing opt-ins", () => {
    expect(skipsDialog([req({ mode: "typed", items: [] })])).toBe(true);
    expect(skipsDialog([req({ mode: "standing" })])).toBe(true);
    expect(skipsDialog([req(), req({ mode: "typed", items: [] })])).toBe(false);
    expect(skipsDialog([req()])).toBe(false);
  });

  it("remembers approval only for unchanged, reviewed text", () => {
    const a = fingerprint(req());
    expect(fingerprint(req({ user: req().user.replace("what?", "something else"), items: [{ label: "notes.md", text: "the file text" }, { label: "Your question", text: "something else", typed: true }] }))).toBe(a);
    expect(fingerprint(req({ user: req().user.replace("the file text", "edited"), items: [{ label: "notes.md", text: "edited" }] }))).not.toBe(a);
    expect(hashText("a")).not.toBe(hashText("b"));
  });

  it("merges the same transcript only once across requests", () => {
    const t = { label: "Transcript", text: "hello world" };
    const merged = mergedItems([req({ items: [t] }), req({ items: [t, { label: "Other", text: "x" }] })]);
    expect(merged.map((i) => i.label)).toEqual(["Transcript", "Other"]);
  });
});

describe("every call site shows text that is really sent", () => {
  const consistent = (user: string, items: { label: string; text: string; typed?: boolean }[]) =>
    expect(() => mint({ purpose: "t", system: "s", user, items, mode: "review" })).not.toThrow();

  it("ask", () => {
    const turns = [{ question: "q1", answer: "a1" }];
    consistent(buildAskUserPrompt("q2", turns, "DOC"), [
      { label: "file", text: "DOC" }, { label: "history", text: askHistoryText(turns) }, { label: "q", text: "q2", typed: true },
    ]);
  });
  it("edit", () => consistent(buildEditUserPrompt("  shorten  ", "SECTION"), [{ label: "s", text: "SECTION" }, { label: "i", text: "shorten", typed: true }]));
  it("analyses, coach and quick note", () => {
    consistent(buildUserPrompt({ title: "T" }, "TRANSCRIPT"), [{ label: "t", text: "TRANSCRIPT" }]);
    consistent(buildCoachUserPrompt("T", "TRANSCRIPT"), [{ label: "t", text: "TRANSCRIPT" }]);
    consistent(buildNoteUserPrompt("TRANSCRIPT"), [{ label: "t", text: "TRANSCRIPT" }]);
  });
  it("follow-ups and recurring topics", () => {
    const items: PriorItem[] = [{ id: "a-1", task: "Send notes", owner: "Sam", deadline: null, meetingTitle: "Sprint", meetingDate: "2026-11-01", state: "unknown" }];
    consistent(buildFollowUpUserPrompt(items, "TRANSCRIPT"), [{ label: "i", text: priorItemsText(items) }, { label: "t", text: "TRANSCRIPT" }]);
    const sums = [{ title: "Sprint", date: "2026-11-01", markdown: "We agreed X." }];
    consistent(buildTopicsUserPrompt(sums, "TRANSCRIPT"), [{ label: "s", text: priorSummariesText(sums) }, { label: "t", text: "TRANSCRIPT" }]);
  });
});

describe("ReceiptDialog", () => {
  it("shows the destination, each item, sizes and the exact text", () => {
    const html = renderToStaticMarkup(<ReceiptDialog reqs={[req()]} onSend={() => {}} onCancel={() => {}} />);
    expect(html).toContain("api.groq.com");
    expect(html).toContain("notes.md");
    expect(html).toContain("the file text");
    expect(html).toContain("typed by you");
    expect(html).toContain("Exact text sent");
    expect(html).toContain("SEND");
    expect(html).toContain("CANCEL");
  });
  it("shortens long items but keeps all of the text available", () => {
    const long = "x".repeat(2000);
    const r = req({ user: long, items: [{ label: "big", text: long }] });
    const html = renderToStaticMarkup(<ReceiptDialog reqs={[r]} onSend={() => {}} onCancel={() => {}} />);
    expect(html).toContain("Show all 2,000 characters");
  });
});
