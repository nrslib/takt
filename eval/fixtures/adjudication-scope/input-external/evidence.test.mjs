import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { serve } from './src/entry.mjs';
import { count } from './src/count.mjs';
test('記録された現在の観測', async () => {
let saved;
const queue = { put: async value => { saved = value; }, take: async () => saved };
const fs = { readFile: async path => path };
assert.equal(await serve({ json: async () => ({ path: '/home/owner/private.txt' }) }, queue, fs), '/home/owner/private.txt');
});
test('引き継いだ検証の対象と受入条件', () => {
  assert.equal(count([]), 0);
  assert.equal(count([1, 2]), 2);
  const hash = createHash('sha256').update(readFileSync(new URL('./src/count.mjs', import.meta.url))).digest('hex');
  const report = readFileSync(new URL('./reports-seed/fix-verification.md', import.meta.url), 'utf8');
  assert.ok(report.includes(hash));
});
