import { describe, expect, it } from "vitest";
import { acceleratorFromEvent, keyName, prettyAccelerator } from "./accelerator";

const ev = (code: string, m: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({
  code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...m,
});

describe("accelerator", () => {
  it("builds accelerators in a stable modifier order", () => {
    expect(acceleratorFromEvent(ev("KeyK", { shiftKey: true, ctrlKey: true }))).toBe("Control+Shift+K");
    expect(acceleratorFromEvent(ev("Space", { metaKey: true, altKey: true }))).toBe("Alt+Super+Space");
    expect(acceleratorFromEvent(ev("Digit7", { ctrlKey: true }))).toBe("Control+7");
    expect(acceleratorFromEvent(ev("F5", { altKey: true }))).toBe("Alt+F5");
    expect(acceleratorFromEvent(ev("ArrowUp", { ctrlKey: true }))).toBe("Control+Up");
  });
  it("requires a modifier and a supported key", () => {
    expect(acceleratorFromEvent(ev("KeyK"))).toBeNull();
    expect(acceleratorFromEvent(ev("ShiftLeft", { shiftKey: true }))).toBeNull();
    expect(acceleratorFromEvent(ev("Comma", { ctrlKey: true }))).toBeNull();
    expect(keyName("Escape")).toBeNull();
  });
  it("prettifies per platform", () => {
    expect(prettyAccelerator("CommandOrControl+Shift+Space", true)).toBe("⌘ ⇧ Space");
    expect(prettyAccelerator("CommandOrControl+Shift+Space", false)).toBe("Ctrl+Shift+Space");
  });
});
