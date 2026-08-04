export function exportReport(items) {
  return items.map((item) => `${item.category}: ${item.label}`).join('\n');
}
