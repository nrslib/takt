import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('../src/history.js', import.meta.url), 'utf8');

test('keeps the history module small and immutable', () => {
  assert.ok(source.split('\n').length <= 20);
  assert.ok(source.includes('Object.freeze'));
  assert.ok(!source.includes('deleteRecord'));
});
