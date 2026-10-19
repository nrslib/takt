import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { init, newSnippet, complete, prune } from '../src/snippets.mjs';

test('completed work is removed and active work is retained', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'snippets-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  init(root);
  assert.equal(fs.readFileSync(path.join(root, '.snip', '.gitignore'), 'utf8'), '*\n');
  const first = newSnippet(root);
  const second = newSnippet(root);
  fs.writeFileSync(path.join(first.directory, 'draft.txt'), 'one');
  complete(root, first.id);
  assert.equal(prune(root), 1);
  assert.equal(fs.existsSync(first.directory), false);
  assert.equal(fs.existsSync(second.directory), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, '.snip', 'state.json'))), [
    { ...second, completed: false },
  ]);
});
