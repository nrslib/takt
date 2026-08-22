import assert from 'node:assert/strict';
import test from 'node:test';

import { serializeExport } from '../src/export.js';

test('serializes an export value', () => {
  assert.equal(serializeExport('item'), 'export:item');
});
