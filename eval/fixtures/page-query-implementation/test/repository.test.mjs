import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createRecordRepository } from '../src/repository.mjs';

test('export reads every record for the tenant in ID order', () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec('CREATE TABLE records (id INTEGER PRIMARY KEY, tenant_id TEXT, title TEXT)');
    const insert = database.prepare('INSERT INTO records VALUES (?, ?, ?)');
    for (let id = 1; id <= 45; id++) insert.run(id, 'tenant-a', `Record ${id}`);
    insert.run(46, 'tenant-b', 'Other');
    const rows = createRecordRepository(database).readRecords('tenant-a');
    assert.equal(rows.length, 45);
    assert.deepEqual(rows.map(({ id }) => id), Array.from({ length: 45 }, (_, index) => index + 1));
  } finally {
    database.close();
  }
});
