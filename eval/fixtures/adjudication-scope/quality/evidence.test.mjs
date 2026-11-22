import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { publish, preview } from './src/entry.mjs';
import { auditHeading } from './src/audit.mjs';
import { count } from './src/count.mjs';
test('配信は同じ契約の結果、監査は独立した結果を返す', () => {
  const raw = { recipient: ' Owner@Example.test ', subject: ' Report ', retries: 2.9 };
  const expected = { recipient: 'owner@example.test', subject: 'Report', retries: 2 };
  assert.deepEqual(publish(raw), { delivery: expected, status: 'published' });
  assert.deepEqual(preview(raw), { delivery: expected, status: 'preview' });
  assert.equal(auditHeading({ subject: ' Mixed CASE ' }), 'Mixed CASE');
});
test('引き継いだ検証の対象と受入条件', () => {
  assert.equal(count([]), 0);
  assert.equal(count([1, 2]), 2);
  const hash = createHash('sha256').update(readFileSync(new URL('./src/count.mjs', import.meta.url))).digest('hex');
  const report = readFileSync(new URL('./reports-seed/fix-verification.md', import.meta.url), 'utf8');
  assert.ok(report.includes(hash));
});
