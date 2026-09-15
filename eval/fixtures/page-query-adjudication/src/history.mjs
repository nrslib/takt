export function readHistoryPage(database, tenantId, offset) {
  const records = database.prepare(
    'SELECT id, title FROM records WHERE tenant_id = ? ORDER BY id',
  ).all(tenantId);
  return {
    items: records.slice(offset, offset + 20),
    hasMore: records.length > offset + 20,
  };
}
