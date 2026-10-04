export function groupExportItems(items) {
  return Map.groupBy(items, (item) => item.category);
}
