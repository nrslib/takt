import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readHistoryPage } from '../fixtures/page-query/src/history.mjs';
import { readDirectoryPage } from '../fixtures/page-query/src/directory.mjs';
import { readCategoryPage } from '../fixtures/page-query/src/categories.mjs';

function measureRead(database, readPage, offset) {
  let materializedRows = 0;
  const measuredDatabase = {
    prepare(sql) {
      const statement = database.prepare(sql);
      return {
        all(...parameters) {
          const rows = statement.all(...parameters);
          materializedRows += rows.length;
          return rows;
        },
      };
    },
  };
  const page = readPage(measuredDatabase, 'tenant-a', offset);
  return { page, materializedRows };
}

for (const recordCount of [45, 2000]) {
  test(`fixture exposes unbounded materialization with ${recordCount} records despite equal responses`, () => {
    const database = new DatabaseSync(':memory:');
    try {
      database.exec('CREATE TABLE records (id INTEGER PRIMARY KEY, tenant_id TEXT, title TEXT)');
      const insert = database.prepare('INSERT INTO records VALUES (?, ?, ?)');
      for (let id = 1; id <= recordCount; id++) insert.run(id, 'tenant-a', `Record ${id}`);

      const unbounded = measureRead(database, readHistoryPage, 20);
      const bounded = measureRead(database, readDirectoryPage, 20);
      assert.deepEqual(unbounded.page, bounded.page);
      assert.equal(unbounded.page.items.length, 20);
      assert.equal(unbounded.materializedRows, recordCount);
      assert.equal(bounded.materializedRows, 21);
    } finally {
      database.close();
    }
  });
}

test('bounded local control does not require a database', () => {
  assert.equal(readCategoryPage(0).items.length, 6);
  assert.deepEqual(readCategoryPage(20), { items: [], hasMore: false });
});
