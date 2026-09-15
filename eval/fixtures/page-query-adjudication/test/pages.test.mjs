import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readHistoryPage } from '../src/history.mjs';
import { readDirectoryPage } from '../src/directory.mjs';
import { readCategoryPage } from '../src/categories.mjs';

for (const readPage of [readHistoryPage, readDirectoryPage]) {
  test(`${readPage.name} returns the requested tenant page and continuation`, () => {
    const database = new DatabaseSync(':memory:');
    try {
      database.exec('CREATE TABLE records (id INTEGER PRIMARY KEY, tenant_id TEXT, title TEXT)');
      const insert = database.prepare('INSERT INTO records VALUES (?, ?, ?)');
      for (let id = 1; id <= 45; id++) insert.run(id, 'tenant-a', `Record ${id}`);
      insert.run(46, 'tenant-b', 'Other tenant');

      for (const offset of [0, 20, 40, 60]) {
        const page = readPage(database, 'tenant-a', offset);
        assert.deepEqual(page.items.map(({ id }) => id),
          Array.from({ length: Math.max(0, Math.min(20, 45 - offset)) }, (_, index) => offset + index + 1));
        assert.equal(page.hasMore, offset + 20 < 45);
      }
      assert.deepEqual(readPage(database, 'empty', 0), { items: [], hasMore: false });
    } finally {
      database.close();
    }
  });
}

test('categories expose the fixed product vocabulary', () => {
  assert.deepEqual(readCategoryPage(0), {
    items: ['draft', 'submitted', 'approved', 'archived', 'cancelled', 'failed'],
    hasMore: false,
  });
  assert.deepEqual(readCategoryPage(20), { items: [], hasMore: false });
});
