/**
 * Whether the "Send to AI?" dialog is skipped when only the open file's text (and what you typed) is sent.
 * Requests that include other notes (folder or vault questions) always show it.
 * Default: skipped. The text is still checked against what is sent; only the dialog is not shown.
 */
const KEY = "ai-skip-open-file-review";

export function skipOpenFileReview(): boolean {
  try {
    return localStorage.getItem(KEY) !== "0";
  } catch {
    return true;
  }
}

export function setSkipOpenFileReview(skip: boolean): void {
  try {
    localStorage.setItem(KEY, skip ? "1" : "0");
  } catch {
    /* optional */
  }
}
