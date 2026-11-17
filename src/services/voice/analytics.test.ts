import { describe, expect, it } from "vitest";
import { computeAnalytics, findFillers, norm } from "./analytics";
import type { TranscriptChunk, Word } from "./types";

/** words spoken at `wps` per second starting at `from` ms, optionally with `gapBefore` ms of silence. */
function speak(texts: string[], from: number, perWordMs = 400): Word[] {
  return texts.map((w, i) => ({ w, start: from + i * perWordMs, end: from + i * perWordMs + perWordMs - 50 }));
}
const chunk = (words: Word[], i = 0): TranscriptChunk => ({
  index: i, startMs: words[0]?.start ?? 0, endMs: words[words.length - 1]?.end ?? 0,
  text: words.map((w) => w.w).join(" "), words, status: "final",
});

describe("fillers", () => {
  it("finds single words and two-word phrases, counting a phrase once", () => {
    const f = findFillers("so um you know it was basically um fine and i mean actually like good".split(" "));
    expect(Object.fromEntries(f)).toEqual({ um: 2, "you know": 1, basically: 1, "i mean": 1, actually: 1, like: 1 });
  });
  it("normalises punctuation and case", () => {
    expect(norm("Um,")).toBe("um");
    expect(norm("don't!")).toBe("don't");
  });
});

describe("computeAnalytics", () => {
  it("computes pace, fillers and repeats from timed words", () => {
    // 100 words at 400 ms each = 40 s, mixed with fillers and a repeated phrase
    const base = "we should ship the new feature um because the new feature helps users and basically the new feature is simple".split(" ");
    const texts = Array.from({ length: 6 }, () => base).flat().slice(0, 100);
    const a = computeAnalytics([chunk(speak(texts, 0))], 40_000);
    expect(a.hasTimings).toBe(true);
    expect(a.wordCount).toBe(100);
    expect(a.wpm).toBe(150);
    expect(a.fillers.map((f) => f.term)).toContain("um");
    expect(a.fillerTotal).toBeGreaterThan(5);
    expect(a.repeatedPhrases.some((p) => p.term.includes("new feature"))).toBe(true);
  });

  it("detects pauses between words and long ones", () => {
    const first = speak("one two three four five six".split(" "), 0); // ends 2350
    const second = speak("seven eight nine ten".split(" "), first[5].end + 3500); // 3.5 s pause
    const third = speak("eleven twelve".split(" "), second[3].end + 1200);
    const a = computeAnalytics([chunk([...first, ...second, ...third])], 20_000);
    expect(a.pauses?.count).toBe(2);
    expect(a.pauses?.veryLong).toBe(1);
    expect(a.pauses?.longest[0]).toMatchObject({ before: "six", after: "seven" });
    expect(a.pauses!.longest[0].durationMs).toBeGreaterThanOrEqual(3500);
  });

  it("flags windows where the pace changes a lot", () => {
    const slow = speak(Array.from({ length: 30 }, (_, i) => `a${i}`), 0, 1000); // 60 wpm for 30 s
    const fast = speak(Array.from({ length: 150 }, (_, i) => `b${i}`), 30_000, 200); // 300 wpm for 30 s
    const a = computeAnalytics([chunk([...slow, ...fast])], 60_000);
    expect(a.pace?.windows).toHaveLength(2);
    expect(a.pace?.flagged.map((f) => f.kind).sort()).toEqual(["faster", "slower"]);
    expect(a.notes.join(" ")).toMatch(/varied a lot/);
  });

  it("detects immediate repeats but not intentional 'that that'", () => {
    const a = computeAnalytics([chunk(speak("the the plan is is good that that works".split(" "), 0))], 5000);
    expect(a.stutters.map((s) => s.phrase)).toEqual(["the the", "is is"]);
  });

  it("works without word timestamps (no pace/pause claims)", () => {
    const c: TranscriptChunk = { index: 0, startMs: 0, endMs: 10_000, text: "um hello there everyone", words: [], status: "final" };
    const a = computeAnalytics([c], 10_000);
    expect(a.hasTimings).toBe(false);
    expect(a.pace).toBeNull();
    expect(a.pauses).toBeNull();
    expect(a.wordCount).toBe(4);
    expect(a.wpm).toBe(24);
    expect(a.fillerTotal).toBe(1);
  });

  it("ignores failed and pending chunks", () => {
    const failed: TranscriptChunk = { ...chunk(speak(["lost"], 0), 1), status: "failed" };
    expect(computeAnalytics([failed], 1000).wordCount).toBe(0);
  });
});
