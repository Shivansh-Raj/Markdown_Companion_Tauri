import { describe, expect, it } from "vitest";
import { parseWhisper, pickSttModel } from "./transcriber";
import {
  dateStamp, formatClock, isPhantom, suggestFileName, transcriptMarkdown, transcriptText, upsertChunk, wordCount,
} from "./transcript";
import type { SessionMeta, TranscriptChunk } from "./types";

const chunk = (index: number, text: string, status: TranscriptChunk["status"] = "final"): TranscriptChunk => ({
  index, startMs: index * 5000, endMs: index * 5000 + 5000, text, words: [], status,
});

describe("transcript helpers", () => {
  it("keeps chunks ordered and replaces by index", () => {
    let list: TranscriptChunk[] = [];
    list = upsertChunk(list, chunk(2, "c"));
    list = upsertChunk(list, chunk(0, "a"));
    list = upsertChunk(list, chunk(1, "b", "pending"));
    list = upsertChunk(list, chunk(1, "b"));
    expect(list.map((c) => c.text)).toEqual(["a", "b", "c"]);
  });

  it("joins only finalised text", () => {
    expect(transcriptText([chunk(0, "Hello"), chunk(1, "later", "pending"), chunk(2, " world ")])).toBe("Hello world");
  });

  it("counts words and formats clocks", () => {
    expect(wordCount("  one two  three ")).toBe(3);
    expect(wordCount("")).toBe(0);
    expect(formatClock(65_000)).toBe("01:05");
    expect(formatClock(3_725_000)).toBe("1:02:05");
  });

  it("drops phantom text only for near-silent chunks", () => {
    expect(isPhantom("Thank you.", 300)).toBe(true);
    expect(isPhantom("Thank you.", 4000)).toBe(false);
    expect(isPhantom("The budget is fine", 300)).toBe(false);
  });

  it("suggests dated file names and renders a transcript document", () => {
    const meta: SessionMeta = {
      id: "1", title: "Sprint review", mode: "meeting", createdAtMs: new Date(2026, 10, 17, 10).getTime(),
      durationMs: 125_000, status: "stopped", device: "mic", chunks: 2,
    };
    expect(dateStamp(meta.createdAtMs)).toBe("2026-11-17");
    expect(suggestFileName(meta)).toBe("2026-11-17 Sprint review");
    const md = transcriptMarkdown(meta, [chunk(0, "We shipped it."), chunk(1, "", "failed")]);
    expect(md).toContain("# Sprint review — transcript");
    expect(md).toContain("**Length:** 02:05");
    expect(md).toContain("**[00:00]** We shipped it.");
    expect(md).not.toContain("[00:05]");
  });
});

describe("whisper parsing", () => {
  it("shifts word times onto the recording timeline and drops empty words", () => {
    const r = parseWhisper({ text: " hi there ", words: [{ word: " hi", start: 0.1, end: 0.4 }, { word: " ", start: 0.5, end: 0.6 }, { word: "there", start: 0.5, end: 0.9 }] }, 10_000);
    expect(r.text).toBe("hi there");
    expect(r.words).toEqual([{ w: "hi", start: 10_100, end: 10_400 }, { w: "there", start: 10_500, end: 10_900 }]);
  });

  it("tolerates a response without words", () => {
    expect(parseWhisper({ text: "ok" }, 0)).toEqual({ text: "ok", words: [] });
    expect(parseWhisper(null, 0)).toEqual({ text: "", words: [] });
  });

  it("prefers the turbo whisper model and never picks chat models", () => {
    expect(pickSttModel(["llama-3.3-70b-versatile", "whisper-large-v3", "whisper-large-v3-turbo"])).toBe("whisper-large-v3-turbo");
    expect(pickSttModel(["llama-3.3-70b-versatile"])).toBeNull();
  });
});
