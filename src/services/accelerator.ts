/** Builds a Tauri accelerator string (e.g. "Control+Shift+K") from a keyboard event. */
export interface KeyLike {
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

const NAMED: Record<string, string> = {
  Space: "Space", Enter: "Enter", Tab: "Tab", Backspace: "Backspace", Delete: "Delete",
  Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
  ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
};

export function keyName(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1];
  const digit = /^Digit(\d)$/.exec(code);
  if (digit) return digit[1];
  if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return code;
  return NAMED[code] ?? null;
}

/** Returns null until a supported key is pressed together with at least one modifier. */
export function acceleratorFromEvent(e: KeyLike): string | null {
  const key = keyName(e.code);
  const mods = [e.ctrlKey && "Control", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Super"].filter(
    Boolean,
  ) as string[];
  if (!key || mods.length === 0) return null;
  return [...mods, key].join("+");
}

export function prettyAccelerator(accel: string, mac: boolean): string {
  const map: Record<string, string> = mac
    ? { CommandOrControl: "⌘", Command: "⌘", Cmd: "⌘", Super: "⌘", Control: "⌃", Ctrl: "⌃", Alt: "⌥", Option: "⌥", Shift: "⇧" }
    : { CommandOrControl: "Ctrl", Command: "Win", Cmd: "Win", Super: "Win", Control: "Ctrl", Ctrl: "Ctrl", Option: "Alt" };
  return accel.split("+").map((p) => map[p] ?? p).join(mac ? " " : "+");
}
