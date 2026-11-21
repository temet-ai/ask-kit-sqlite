// Helpers shared by the scripts.

/** Bytes as text: 77824 is "76 KB". */
export const human = (n) => {
  if (n == null) return null;
  const u = ["B", "KB", "MB", "GB", "TB"];
  let v = Number(n);
  let i = 0;
  while (v >= 1024 && i < u.length - 1) (v /= 1024), i++;
  return `${i && v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
};

/** A module result that is a failure, as a script's result: what was asked, the error and a verdict. */
export const failed = (r, what) => ({ ...r, verdict: `${what}: ${r.error}` });

export const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
