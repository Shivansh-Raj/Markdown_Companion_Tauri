import { describe, expect, it } from "vitest";
import {
  buildQuestionSystemPrompt, followUpMarkdown, matchCheckboxState, parseCheckboxes, parseQuestions, recentContext, shouldSuggest,
  toFollowUps, toTopics, type PriorItem,
} from "./followups";

const item = (id: string, task: string, extra: Partial<PriorItem> = {}): PriorItem => ({
  id, task, owner: null, deadline: null, meetingTitle: "Sprint 1", meetingDate: "2026-11-10", state: "unknown", ...extra,
});

describe("checkbox state from Markdown", () => {
  it("reads task lines and ignores code fences", () => {
    const md = "# T\n- [x] done thing\n- [ ] open thing\n```\n- [ ] in code\n```\n1. [X] numbered";
    expect(parseCheckboxes(md)).toEqual([
      { checked: true, text: "done thing" }, { checked: false, text: "open thing" }, { checked: true, text: "numbered" },
    ]);
  });

  it("matches items to real checkbox states, treating an unchecked copy as still open", () => {
    const files = [
      { name: "plan.md", content: "- [x] Send the budget report to finance\n- [ ] Book the room" },
      { name: "old.md", content: "- [ ] Send the budget report to finance" },
    ];
    const out = matchCheckboxState([item("1", "Send the budget report to finance"), item("2", "book the room!"), item("3", "Something never written down")], files);
    expect(out.map((o) => o.state)).toEqual(["open", "open", "unknown"]);
    expect(out[0].file).toBe("old.md");
    const done = matchCheckboxState([item("1", "Send the budget report to finance")], [files[0]]);
    expect(done[0]).toMatchObject({ state: "done", file: "plan.md" });
  });
});

describe("follow-up validation", () => {
  const items = [item("a", "Send report"), item("b", "Book room")];
  const transcript = "Quick update: the report still has not gone out, we pushed it to next Tuesday. Nothing else.";

  it("resets statuses whose quote is not in the transcript and fills in skipped items", () => {
    const raw = JSON.stringify([
      { id: "a", status: "delayed", evidence: "we pushed it to next Tuesday", note: "New date." },
      { id: "b", status: "resolved", evidence: "the room is booked and confirmed", note: "Made up." },
      { id: "zzz", status: "resolved", evidence: "x", note: "unknown id" },
    ]);
    const { results, dropped } = toFollowUps(raw, items, transcript);
    expect(results.map((r) => [r.id, r.status])).toEqual([["a", "delayed"], ["b", "not_mentioned"]]);
    expect(results[0].evidence).toBe("we pushed it to next Tuesday");
    expect(results[1].evidence).toBe("");
    expect(dropped).toBe(1);
    expect(toFollowUps("[]", items, transcript).results.every((r) => r.status === "not_mentioned")).toBe(true);
  });

  it("rejects replies that are not a list", () => {
    expect(() => toFollowUps('{"a":1}', items, transcript)).toThrow(/list/);
  });

  it("only keeps recurring topics with a verifiable quote", () => {
    const raw = JSON.stringify([
      { topic: "Release date", meetings: ["Sprint 1"], evidence: "pushed it to next Tuesday" },
      { topic: "Hiring", meetings: ["Sprint 1"], evidence: "we are hiring three people" },
      { topic: "No meetings", meetings: [], evidence: "report" },
    ]);
    const { topics, dropped } = toTopics(raw, transcript);
    expect(topics.map((t) => t.topic)).toEqual(["Release date"]);
    expect(dropped).toBe(1);
  });

  it("writes a report that never claims anything was ticked", () => {
    const its = [item("a", "Send report", { state: "open", file: "plan.md", owner: "Priya" }), item("b", "Old done", { state: "done", file: "plan.md" })];
    const md = followUpMarkdown({
      createdAtMs: 1, items: its, topics: [], dropped: 0,
      results: [{ id: "a", status: "delayed", evidence: "pushed it", note: "New date." }, { id: "b", status: "not_mentioned", evidence: "", note: "" }],
    });
    expect(md).toContain("**Possibly delayed**");
    expect(md).toContain("Owner: Priya");
    expect(md).toContain("still unchecked in plan.md");
    expect(md).toContain("Already ticked in your notes");
    expect(md).toContain("Nothing was ticked or changed");
  });
});

describe("live question suggestions", () => {
  const base = { enabled: true, paused: false, inFlight: false, transcribing: 0, sinceMs: 60_000, newWords: 80 };

  it("only asks at a quiet, useful moment and never when off, paused or busy", () => {
    expect(shouldSuggest(base)).toBe(true);
    expect(shouldSuggest({ ...base, enabled: false })).toBe(false);
    expect(shouldSuggest({ ...base, paused: true })).toBe(false);
    expect(shouldSuggest({ ...base, inFlight: true })).toBe(false);
    expect(shouldSuggest({ ...base, transcribing: 1 })).toBe(false);
    expect(shouldSuggest({ ...base, sinceMs: 10_000 })).toBe(false);
    expect(shouldSuggest({ ...base, newWords: 5 })).toBe(false);
  });

  it("parses suggestions, drops repeats and survives bad replies without throwing", () => {
    const raw = '[{"question":"Who owns the migration?","reason":"No owner named.","kind":"owner"},{"question":"who owns the migration","kind":"owner"},{"question":"By when?","kind":"weird"}]';
    const out = parseQuestions(raw, ["When is the launch?"]);
    expect(out.map((q) => q.question)).toEqual(["Who owns the migration?", "By when?"]);
    expect(out[1].kind).toBe("clarify");
    expect(parseQuestions("sorry, no", [])).toEqual([]);
    expect(parseQuestions('[{"question":"When is the launch?"}]', ["when is the launch"])).toEqual([]);
  });

  it("limits context to the recent tail and tells the model not to over-suggest", () => {
    const long = "word ".repeat(2000);
    expect(recentContext(long).length).toBeLessThanOrEqual(2400);
    expect(recentContext("short")).toBe("short");
    expect(buildQuestionSystemPrompt()).toMatch(/real gap/);
    expect(buildQuestionSystemPrompt()).toMatch(/\[\]/);
  });
});
