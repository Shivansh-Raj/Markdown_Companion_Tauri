import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TypingCat } from "./TypingCat";

describe("TypingCat", () => {
  it("shows the question mark only while waiting for the user", () => {
    const waiting = renderToStaticMarkup(<TypingCat mood="waiting" label="Keep it?" />);
    expect(waiting).toContain("cat waiting");
    expect(waiting).toContain("cat-question");
    expect(waiting).toContain("Keep it?");
    expect(waiting).not.toContain("cat-dots");           // no "typing…" dots while waiting
  });
  it("defaults to the typing mood without a question mark", () => {
    const typing = renderToStaticMarkup(<TypingCat label="Thinking" />);
    expect(typing).not.toContain("cat-question");
    expect(typing).not.toContain("cat waiting");
    expect(typing).toContain("cat-dots");
  });
});
