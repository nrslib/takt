export function readDirectoryPage(database, tenantId, offset) {
  const records = database.prepare(
    'SELECT id, title FROM records WHERE tenant_id = ? ORDER BY id LIMIT ? OFFSET ?',
  ).all(tenantId, 21, offset);
  return {
    items: records.slice(0, 20),
    hasMore: records.length > 20,
  };
}
