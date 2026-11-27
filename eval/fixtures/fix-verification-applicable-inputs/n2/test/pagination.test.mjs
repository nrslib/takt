import assert from 'node:assert/strict';
import test from 'node:test';
import { runCli } from '../src/cli.mjs';

const items = ['one', 'two', 'three', 'four', 'five'];
test('上限超のページを最後のページに制限する', () => {
  assert.deepEqual(runCli(['9'], items), { page: 3, items: ['five'] });
});
test('最後のページの境界を保持する', () => {
  assert.deepEqual(runCli(['3'], items), { page: 3, items: ['five'] });
});
test('範囲内のページと最初のページを保持する', () => {
  assert.deepEqual(runCli(['2'], items), { page: 2, items: ['three', 'four'] });
  assert.deepEqual(runCli(['1'], items), { page: 1, items: ['one', 'two'] });
});
test('空の一覧を返す', () => {
  assert.deepEqual(runCli(['1'], []), { page: 1, items: [] });
});
