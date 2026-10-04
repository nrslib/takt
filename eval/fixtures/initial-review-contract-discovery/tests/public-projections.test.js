import test from 'node:test';
import assert from 'node:assert/strict';
import { controlNode, taskNode } from '../src/node-model.js';
import { renderPreview } from '../src/preview.js';
import { summarizeNode } from '../src/summary.js';

test('renders an executable task', () => {
  assert.match(renderPreview(taskNode('build', 'worker-a')), /worker-a/);
});

test('summarizes a control node without task metadata', () => {
  assert.deepEqual(summarizeNode(controlNode('delegate', 'child-flow')), {
    kind: 'control',
    name: 'delegate',
    child: 'child-flow',
  });
});
