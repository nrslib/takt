import test from 'node:test';
import assert from 'node:assert/strict';
import { countDirectWorkflowCalls } from '../src/hierarchy-depth.js';

test('should count only direct workflow calls when non-call entries are present', () => {
  const entries = [
    { kind: 'workflow_call', children: [] },
    { kind: 'agent', children: [] },
    { kind: 'system', children: [] },
  ];

  assert.equal(countDirectWorkflowCalls(entries), 1);
});
