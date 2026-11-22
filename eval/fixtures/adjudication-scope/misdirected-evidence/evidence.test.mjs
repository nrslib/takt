import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { page } from './src/entry.mjs';
import { count } from './src/count.mjs';
test('指定された返却件数の前に全行を取得している', async () => {
  const rows = Array.from({ length: 100 }, (_, id) => ({ id }));
  let fetched = 0;
  const store = { scan: async () => { fetched += rows.length; return rows; } };
  assert.deepEqual(await page(store, 10, 2), rows.slice(10, 12));
  assert.equal(fetched, 100);
});
test('引き継いだ検証の対象と受入条件', () => {
  assert.equal(count([]), 0);
  assert.equal(count([1, 2]), 2);
  const hash = createHash('sha256').update(readFileSync(new URL('./src/count.mjs', import.meta.url))).digest('hex');
  const report = readFileSync(new URL('./reports-seed/fix-verification.md', import.meta.url), 'utf8');
  assert.ok(report.includes(hash));
});
