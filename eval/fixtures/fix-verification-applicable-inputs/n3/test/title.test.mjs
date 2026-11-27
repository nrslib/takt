import assert from 'node:assert/strict';
import test from 'node:test';
import { renderPullRequest } from '../src/cli.mjs';
import { fetchPullRequest } from '../src/integration.mjs';

test('PR タイトルの文字列を保持する', () => {
  assert.equal(renderPullRequest({ title: '表示の修正' }), '表示の修正');
});
test('タイトル中の CSI を表示前に除く', () => {
  assert.equal(renderPullRequest({ title: '\x1b[31m表示の修正\x1b[0m' }), '表示の修正');
});

test('連携 API の取得からタイトル本文の表示まで通す', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () =>
    new Response(JSON.stringify({ title: '表示の修正' })));
  const pullRequest = await fetchPullRequest('https://example.test/pull/1');
  assert.equal(fetch.mock.calls[0].arguments[0], 'https://example.test/pull/1');
  assert.equal(renderPullRequest(pullRequest), '表示の修正');
});

test('連携 API の取得失敗と不正なタイトルを拒否する', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 503 }));
  await assert.rejects(fetchPullRequest('https://example.test/pull/1'));
  fetch.mock.mockImplementation(async () => new Response(JSON.stringify({ title: 123 })));
  await assert.rejects(fetchPullRequest('https://example.test/pull/1'));
});
