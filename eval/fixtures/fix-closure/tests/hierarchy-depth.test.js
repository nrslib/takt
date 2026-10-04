import test from 'node:test';
import assert from 'node:assert/strict';
import { countDirectWorkflowCalls } from '../src/hierarchy-depth.js';

test('should count direct workflow calls across boundary cases', () => {
  assert.equal(countDirectWorkflowCalls([
    { kind: 'agent', children: [{ kind: 'workflow_call', children: [] }] },
    { kind: 'system', children: [] },
  ]), 0);
  assert.equal(countDirectWorkflowCalls([
    { kind: 'workflow_call', children: [] },
    { kind: 'agent', children: [] },
    { kind: 'system', children: [] },
  ]), 1);
  assert.equal(countDirectWorkflowCalls([
    { kind: 'workflow_call', children: [] },
    { kind: 'agent', children: [] },
    { kind: 'workflow_call', children: [] },
  ]), 2);
});
