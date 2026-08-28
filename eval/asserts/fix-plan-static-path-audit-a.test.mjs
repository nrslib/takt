import assert from 'node:assert/strict';
import test from 'node:test';
import { schema } from '../fixtures/fix-plan-static-path-audit-a/src/schema.js';
import { buildPlan } from '../fixtures/fix-plan-static-path-audit-a/src/planner.js';

const input = {
  step: { name: 'fix', tags: ['review'] },
  facet_pool: {
    candidates: [
      { id: 'review-facet', tag: 'review' },
      { id: 'other-facet', tag: 'other' },
    ],
  },
  entry: 'input-entry-must-not-override-schema',
  cycleCount: 2,
};

test('planner reaches each consumer terminal through the loader', () => {
  const plan = buildPlan(input);

  assert.equal(plan.selector.candidateIds[0], 'review-facet');
  assert.equal(plan.selector.persona, 'dynamic facet selector');
  assert.deepEqual(plan.workflow.cycle, [
    'remediation-root',
    'review-child',
    'remediation-root',
  ]);
  assert.equal(plan.workflow.entry, schema.workflow.entry);
  assert.equal(plan.workflow.terminal, 'cycle path');
  assert.equal(plan.loop.threshold, 2);
  assert.equal(plan.loop.decision, 'terminal');
  assert.match(plan.loop.instruction, /cycle 2/);
});

test('selector persona mutation reaches the selector terminal through the planner entry', () => {
  const changed = structuredClone(schema);
  changed.dynamic_facets.selector.persona = 'changed selector persona';

  const plan = buildPlan(input, changed);

  assert.equal(plan.selector.persona, 'changed selector persona');
  assert.equal(plan.selector.terminal, 'selected facet ids');
});

test('selector instruction mutation reaches the selector terminal through the planner entry', () => {
  const changed = structuredClone(schema);
  changed.dynamic_facets.selector.instruction = 'Use the changed selector instruction.';

  const plan = buildPlan(input, changed);

  assert.equal(plan.selector.instruction, 'Use the changed selector instruction.');
  assert.equal(plan.selector.terminal, 'selected facet ids');
});

test('workflow entry mutation changes the cycle terminal through the planner entry', () => {
  const changed = structuredClone(schema);
  changed.workflow.entry = 'review-child';

  const plan = buildPlan(input, changed);

  assert.equal(plan.workflow.entry, 'review-child');
  assert.deepEqual(plan.workflow.cycle, [
    'review-child',
    'remediation-root',
    'review-child',
  ]);
  assert.equal(plan.workflow.terminal, 'cycle path');
});

test('workflow graph mutation changes the cycle terminal through the planner entry', () => {
  const changed = structuredClone(schema);
  changed.workflow.calls['review-child'] = [];

  const plan = buildPlan(input, changed);

  assert.deepEqual(plan.workflow.cycle, []);
  assert.equal(plan.workflow.terminal, 'no cycle');
});

test('loop cycle mutation reaches the loop terminal through the planner entry', () => {
  const changed = structuredClone(schema);
  changed.loop_monitor.cycle = ['changed-cycle'];

  const plan = buildPlan(input, changed);

  assert.deepEqual(plan.loop.cycle, ['changed-cycle']);
  assert.equal(plan.loop.terminal, 'judge decision');
});

test('threshold mutation changes the loop decision through the planner entry', () => {
  const changed = structuredClone(schema);
  changed.loop_monitor.threshold = 3;

  assert.equal(buildPlan({ ...input, cycleCount: 2 }, changed).loop.decision, 'continue');
  assert.equal(buildPlan({ ...input, cycleCount: 3 }, changed).loop.decision, 'terminal');
});

test('input mutations change selection and judge instruction through the planner entry', () => {
  const changedInput = {
    ...input,
    step: { name: 'fix', tags: ['other'] },
    cycleCount: 1,
  };

  const plan = buildPlan(changedInput);

  assert.deepEqual(plan.selector.candidateIds, ['other-facet']);
  assert.equal(plan.loop.decision, 'continue');
  assert.match(plan.loop.instruction, /cycle 1/);
});

test('judge instruction mutation reaches the loop terminal through the planner entry', () => {
  const changed = structuredClone(schema);
  changed.loop_monitor.judge.instruction = 'Judge cycle {cycle_count} with the changed instruction.';

  const plan = buildPlan(input, changed);

  assert.equal(plan.loop.instruction, 'Judge cycle 2 with the changed instruction.');
  assert.equal(plan.loop.terminal, 'judge decision');
});

test('unknown workflow entry is rejected instead of treated as a terminal path', () => {
  const changed = structuredClone(schema);
  changed.workflow.entry = 'missing-node';

  assert.throws(() => buildPlan(input, changed));
});
