import { describe, expect, it } from "vitest";
import { computeAnalytics } from "./analytics";
import {
  buildCoachSystemPrompt, coachMarkdown, extractJson, inTranscript, selectedSentencesMarkdown, speakingAnalysisMarkdown, toCoachResult,
} from "./coach";
import type { TranscriptChunk } from "./types";

const TRANSCRIPT = "So basically the thing is that we kinda need to, um, make the dashboard faster because users are complaining about it.";

describe("extractJson", () => {
  it("finds arrays and objects inside fences and chatter, even with brackets in strings", () => {
    expect(extractJson('Sure!\n```json\n[{"a":"x ] y"}]\n```')).toEqual([{ a: "x ] y" }]);
    expect(extractJson('{"k": [1, {"z": 2}]} trailing')).toEqual({ k: [1, { z: 2 }] });
  });
  it("throws a readable error when there is no JSON", () => {
    expect(() => extractJson("no json at all")).toThrow(/structured/);
    expect(() => extractJson("[1, 2")).toThrow(/unreadable/);
  });
});

describe("quote validation", () => {
  const t = TRANSCRIPT.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, " ").replace(/\s+/g, " ").trim();
  it("accepts verbatim quotes regardless of punctuation or case, rejects invented ones", () => {
    expect(inTranscript("Make the dashboard faster", t)).toBe(true);
    expect(inTranscript("we kinda need to, um, make", t)).toBe(true);
    expect(inTranscript("we must accelerate the dashboard", t)).toBe(false);
    expect(inTranscript("", t)).toBe(false);
  });

  it("drops sentence fixes that quote words the speaker never said", () => {
    const raw = JSON.stringify([
      { original: "we kinda need to, um, make the dashboard faster", category: "casual", natural: "we need to speed up the dashboard", professional: "We should improve dashboard performance.", concise: "Speed up the dashboard.", why: "Filler and vague." },
      { original: "we will revolutionise the synergy", category: "wordy", natural: "x", professional: "y", concise: "z", why: "made up" },
    ]);
    const r = toCoachResult("sentences", raw, TRANSCRIPT, false, 1);
    expect(r.sentences).toHaveLength(1);
    expect(r.dropped).toBe(1);
    expect(r.sentences![0].professional).toContain("performance");
    expect(coachMarkdown(r)).toContain("left out because they did not match");
  });

  it("falls back to the natural version when other styles are missing and defaults bad categories", () => {
    const raw = '[{"original":"the thing is that we kinda need","natural":"we need","category":"???"}]';
    const f = toCoachResult("sentences", raw, TRANSCRIPT, false).sentences![0];
    expect(f).toMatchObject({ category: "awkward", professional: "we need", concise: "we need" });
  });
});

describe("other coach types", () => {
  it("validates clarity quotes and vocabulary words", () => {
    const clarity = toCoachResult("clarity", JSON.stringify([{ quote: "users are complaining about it", problem: "Which users?", suggestion: "Name the group." }, { quote: "invented", problem: "x", suggestion: "y" }]), TRANSCRIPT, false);
    expect(clarity.clarity).toHaveLength(1);
    const vocab = toCoachResult("vocabulary", JSON.stringify([{ said: "thing", better: ["issue", "point"], why: "vague" }, { said: "zzz", better: ["a"], why: "" }]), TRANSCRIPT, false);
    expect(vocab.vocabulary).toEqual([{ said: "thing", better: ["issue", "point"], why: "vague" }]);
  });

  it("parses a structure report and normalises statuses", () => {
    const raw = JSON.stringify({ introduction: { status: "weak", note: "No opening." }, mainExplanation: { status: "present", note: "Clear." }, supportingPoints: { status: "bogus" }, conclusion: { status: "missing", note: "" }, suggestions: ["Open with the goal", ""] });
    const s = toCoachResult("structure", raw, TRANSCRIPT, false).structure!;
    expect(s.introduction.status).toBe("weak");
    expect(s.supportingPoints.status).toBe("missing");
    expect(s.suggestions).toEqual(["Open with the goal"]);
    expect(coachMarkdown({ type: "structure", createdAtMs: 1, structure: s })).toContain("**Introduction:** Weak — No opening.");
    expect(() => toCoachResult("structure", "[1]", TRANSCRIPT, false)).toThrow();
  });

  it("tells the model to quote verbatim, keep the voice and avoid corporate language", () => {
    const p = buildCoachSystemPrompt("sentences");
    expect(p).toMatch(/EXACTLY/);
    expect(p).toMatch(/natural voice/);
    expect(p).toMatch(/corporate/);
  });
});

describe("markdown output", () => {
  it("renders only the selected improvements in the chosen style", () => {
    const fixes = [
      { original: "a", category: "casual" as const, natural: "n1", professional: "p1", concise: "c1", why: "w1" },
      { original: "b", category: "wordy" as const, natural: "n2", professional: "p2", concise: "c2", why: "w2" },
    ];
    const md = selectedSentencesMarkdown(fixes, [{ index: 1, style: "concise" }]);
    expect(md).toContain('**You said:** "b"');
    expect(md).toContain("**Better (concise):** c2");
    expect(md).not.toContain("n1");
    expect(selectedSentencesMarkdown(fixes, [])).toContain("No improvements selected");
  });

  it("includes the honest caveat in the speaking analysis", () => {
    const words = Array.from({ length: 40 }, (_, i) => ({ w: i % 7 === 0 ? "um" : `w${i}`, start: i * 500, end: i * 500 + 400 }));
    const c: TranscriptChunk = { index: 0, startMs: 0, endMs: 20_000, text: "", words, status: "final" };
    const md = speakingAnalysisMarkdown(computeAnalytics([c], 20_000));
    expect(md).toContain("**Pace**");
    expect(md).toContain('"um"');
    expect(md).toMatch(/not a rule/);
  });
});
