import assert from 'node:assert/strict';
import test from 'node:test';
import { executeTool } from '../src/public-tool.mjs';

test('explains why a read-only session cannot publish', () => {
  const result = executeTool({ action: 'publish', projectPath: 'docs' }, { readOnly: true });
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, 'This session does not permit project changes.');
});

test('explains why an unsupported operation is rejected', () => {
  const result = executeTool({ action: 'remove', projectPath: 'docs' }, { readOnly: false });
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, 'This operation is not supported.');
});

test('rejects paths outside the project', () => {
  for (const projectPath of ['../archive', '/srv/archive']) {
    assert.equal(executeTool({ action: 'publish', projectPath }, { readOnly: false }).isError, true);
  }
});

test('publishes a permitted project path', () => {
  assert.deepEqual(executeTool({ action: 'publish', projectPath: 'docs' }, { readOnly: false }), {
    isError: false,
    content: [{ type: 'text', text: 'Published docs.' }],
  });
});
