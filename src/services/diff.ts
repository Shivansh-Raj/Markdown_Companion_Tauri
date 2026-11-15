export type DiffRow = { kind: "add" | "del" | "ctx"; text: string } | { kind: "gap"; hidden: number };

const MAX_CELLS = 4_000_000;

/** Line diff: common prefix/suffix are trimmed, the middle uses an LCS table. */
export function diffLines(oldText: string, newText: string): DiffRow[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const ma = a.slice(pre, a.length - suf);
  const mb = b.slice(pre, b.length - suf);

  const rows: DiffRow[] = a.slice(0, pre).map((text) => ({ kind: "ctx", text }));
  if (ma.length * mb.length > MAX_CELLS) {
    ma.forEach((text) => rows.push({ kind: "del", text }));
    mb.forEach((text) => rows.push({ kind: "add", text }));
  } else {
    const n = ma.length;
    const m = mb.length;
    const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        lcs[i][j] = ma[i] === mb[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (ma[i] === mb[j]) {
        rows.push({ kind: "ctx", text: ma[i] });
        i++;
        j++;
      } else if (lcs[i + 1][j] >= lcs[i][j + 1]) rows.push({ kind: "del", text: ma[i++] });
      else rows.push({ kind: "add", text: mb[j++] });
    }
    while (i < n) rows.push({ kind: "del", text: ma[i++] });
    while (j < m) rows.push({ kind: "add", text: mb[j++] });
  }
  a.slice(a.length - suf).forEach((text) => rows.push({ kind: "ctx", text }));
  return rows;
}

/** Collapses unchanged runs, keeping `context` lines around each change (like a GitHub diff). */
export function withContext(rows: DiffRow[], context = 2): DiffRow[] {
  const keep = rows.map((r) => r.kind !== "ctx");
  const near = keep.map((_, i) => {
    for (let d = -context; d <= context; d++) if (keep[i + d]) return true;
    return false;
  });
  const out: DiffRow[] = [];
  let hidden = 0;
  rows.forEach((r, i) => {
    if (near[i]) {
      if (hidden) out.push({ kind: "gap", hidden });
      hidden = 0;
      out.push(r);
    } else hidden++;
  });
  if (hidden && out.length) out.push({ kind: "gap", hidden });
  return out;
}

export function hasChanges(rows: DiffRow[]): boolean {
  return rows.some((r) => r.kind === "add" || r.kind === "del");
}
