export function summarize(entries) {
  return { count: entries.length, total: entries.reduce((sum, entry) => sum + entry.amount, 0) };
}
