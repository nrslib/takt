import assert from 'node:assert/strict';
import { test } from 'node:test';
import { showFileNames } from '../src/file-list.js';

test('existing file list displays names', () => {
  const names = [];
  showFileNames([{ name: 'sample.txt' }], { addFilename: (name) => names.push(name) });
  assert.deepEqual(names, ['sample.txt']);
});
