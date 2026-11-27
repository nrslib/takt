export function summarize(items) {
  return { count: items.length, labels: items.map(item => item.label).sort() };
}
