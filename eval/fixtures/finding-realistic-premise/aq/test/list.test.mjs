import assert from 'node:assert/strict';
import test from 'node:test';
import childProcess from 'node:child_process';
import { listFiles } from '../src/list.mjs';

test('list displays tracked file paths and handles an empty project', t => {
  const command = t.mock.method(childProcess, 'execFileSync', () => 'notes/one.md\nnotes/two.md\n');
  assert.equal(listFiles('/project'), 'notes/one.md\nnotes/two.md');
  assert.deepEqual(command.mock.calls[0].arguments, [
    'git', ['ls-files', 'notes/'], { cwd: '/project', encoding: 'utf8' },
  ]);
  command.mock.mockImplementation(() => '');
  assert.equal(listFiles('/project'), '');
});
