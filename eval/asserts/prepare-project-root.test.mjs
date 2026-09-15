import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { findStepTarget, findStepThroughCall, composeConfiguredDynamicFacets } from '../scripts/prepare.mjs';
import { loadWorkflowByIdentifier } from '../../dist/infra/config/index.js';

function project(t) {
  const dir = mkdtempSync(join(tmpdir(), 'takt-eval-project-root-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const workflows = join(dir, '.takt', 'workflows');
  mkdirSync(workflows, { recursive: true });
  writeFileSync(join(workflows, 'fixture-child.yaml'), `name: fixture-child
max_steps: 3
steps:
  - name: nested
    call: fixture-leaf
    rules:
      - condition: COMPLETE
        next: COMPLETE
`);
  writeFileSync(join(workflows, 'fixture-leaf.yaml'), `name: fixture-leaf
max_steps: 3
steps:
  - name: fixture-task
    instruction: fixture project instruction
    rules:
      - condition: COMPLETE
        next: COMPLETE
`);
  return dir;
}

function parent() {
  return { name: 'parent', steps: [{ kind: 'workflow_call', name: 'child', call: 'fixture-child', rules: [] }] };
}

test('resolves nested named workflow calls from the fixture project', t => {
  const dir = project(t);
  const result = findStepTarget(parent(), 'fixture-task', dir);
  assert.equal(result.target.instruction, 'fixture project instruction');
});

test('keeps the fixture project when following an explicit call and its descendants', t => {
  const dir = project(t);
  const result = findStepThroughCall(parent(), 'child', 'fixture-task', dir);
  assert.equal(result.target.instruction, 'fixture project instruction');
});

test('loads dynamic facet sources and their child steps from the fixture project', t => {
  const dir = project(t);
  assert.ok(loadWorkflowByIdentifier('fixture-child', dir));
  assert.throws(() => composeConfiguredDynamicFacets({}, {
    sourceWorkflow: 'fixture-child', pool: 'unused', candidateIds: [],
  }, 'fixture-test', 'fixture-task', dir), /has no dynamicFacets configuration/);
});
