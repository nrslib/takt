export function formatReport(items) {
  return items.map(item => `${item.id}: ${item.name}`).join('\n');
}
