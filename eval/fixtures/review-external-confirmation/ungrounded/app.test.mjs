import test from 'node:test';
import assert from 'node:assert/strict';
import { launch } from './app.mjs';
for (const environment of ['local', 'remote']) {
  test(`launch preserves owner on ${environment}`, () => {
    assert.deepEqual(launch(environment, 'desk'), { running: true, environment, owner: 'desk' });
  });
}
test('unsupported environment fails', () => assert.throws(() => launch('unknown', 'desk')));
