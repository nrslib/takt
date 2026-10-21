export function formatReport(items) {
  return items.map(item => item.name).join('\n');
}
