const EXPECTED = new Map([
  ["src/gui-patterns/guard-a.tsx", "REJECT"],
  ["src/gui-patterns/guard-b.tsx", "OK"],
]);

export default function assertGuardReview(output) {
  if (typeof output !== "string") return { pass: false, score: 0, reason: "output is not a string" };
  let rows;
  try {
    rows = JSON.parse(output.trim());
  } catch {
    return { pass: false, score: 0, reason: "output is not strict JSON" };
  }
  if (!Array.isArray(rows) || rows.length !== EXPECTED.size) {
    return { pass: false, score: 0, reason: "expected exactly two verdict rows" };
  }
  const seen = new Set();
  for (const row of rows) {
    if (row === null || typeof row !== "object" || seen.has(row.file) || !EXPECTED.has(row.file)
      || row.verdict !== EXPECTED.get(row.file) || typeof row.reason !== "string" || row.reason.trim() === "") {
      return { pass: false, score: 0, reason: "wrong verdict, duplicate/distinct file, or empty reason" };
    }
    seen.add(row.file);
  }
  if (seen.size !== EXPECTED.size) {
    return { pass: false, score: 0, reason: "missing distinct file" };
  }
  return { pass: true, score: 1, reason: "strict two-row guard review matched" };
}
