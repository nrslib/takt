import assert from 'node:assert/strict';
import test from 'node:test';
import { renderedFixtureLabel } from '../src/fixture.js';

test('mock integration renders the sample', () => {
  assert.equal(renderedFixtureLabel(), '  Alpha  Beta  ');
});
