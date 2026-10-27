export type DiffLine =
  | { kind: 'same'; text: string; a: number; b: number }
  | { kind: 'del'; text: string; a: number }
  | { kind: 'add'; text: string; b: number };

/** Diff ligne à ligne (plus longue sous-séquence commune). Suffisant pour des requêtes de quelques centaines de lignes. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i], a: i + 1, b: j + 1 });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ kind: 'del', text: a[i], a: i + 1 });
      i++;
    } else {
      out.push({ kind: 'add', text: b[j], b: j + 1 });
      j++;
    }
  }
  while (i < n) out.push({ kind: 'del', text: a[i], a: ++i });
  while (j < m) out.push({ kind: 'add', text: b[j], b: ++j });
  return out;
}
