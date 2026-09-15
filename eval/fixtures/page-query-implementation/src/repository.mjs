export function createRecordRepository(database) {
  return {
    readRecords(tenantId) {
      return database.prepare(
        'SELECT id, title FROM records WHERE tenant_id = ? ORDER BY id',
      ).all(tenantId);
    },
  };
}
