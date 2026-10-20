import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { init, add } from '../src/bookmarks.mjs';

test('add retains existing bookmarks and stores tags', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bookmarks-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  init(root);
  add(root, 'https://example.test/one', ['reading']);
  const stored = add(root, 'https://example.test/two', []);
  assert.deepEqual(stored, [
    { url: 'https://example.test/one', tags: ['reading'] },
    { url: 'https://example.test/two', tags: [] },
  ]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'bookmarks.json'))), stored);
});
