import assert from 'node:assert/strict';
import test from 'node:test';
import { schema } from '../fixtures/fix-plan-static-path-audit-c/src/schema.js';
import {
  resolveCapabilities,
  resolveCompanionReference,
  resolveDirectCompanion,
  resolveScopedFacet,
} from '../fixtures/fix-plan-static-path-audit-c/src/companion-consumer.js';
import { buildCompanionPlan } from '../fixtures/fix-plan-static-path-audit-c/src/planner.js';

test('planner reaches the direct companion terminal', () => {
  const plan = buildCompanionPlan({
    explicitArgs: { task: 'explicit-task' },
    mode: 'workflow',
    packageName: '@takt/core',
    facetName: 'audit',
  });

  assert.equal(plan.direct.name, 'audit-companion');
  assert.equal(plan.direct.entry, 'runDirect');
});

test('planner reaches the companion reference terminal', () => {
  const plan = buildCompanionPlan({
    explicitArgs: { task: 'explicit-task' },
    mode: 'workflow',
    packageName: '@takt/core',
    facetName: 'audit',
  });

  assert.deepEqual(plan.reference.args, {
    task: 'explicit-task',
    previous_response: 'no-previous-response',
  });
});

test('planner reaches the capability mode terminal', () => {
  const plan = buildCompanionPlan({
    explicitArgs: { task: 'explicit-task' },
    mode: 'workflow',
    packageName: '@takt/core',
    facetName: 'audit',
  });

  assert.equal(plan.capability.mode, 'workflow');
  assert.deepEqual(plan.capability.capabilities, ['read', 'write', 'review']);
});

test('planner reaches the package-scoped facet terminal', () => {
  const plan = buildCompanionPlan({
    explicitArgs: { task: 'explicit-task' },
    mode: 'workflow',
    packageName: '@takt/core',
    facetName: 'audit',
  });

  assert.equal(plan.facet.content, 'core audit facet');
});

test('explicit arguments replace defaults without changing the declared contract', () => {
  const result = resolveCompanionReference(schema, {
    explicitArgs: {
      task: 'new-task',
      previous_response: 'earlier-answer',
    },
  });

  assert.deepEqual(result.args, {
    task: 'new-task',
    previous_response: 'earlier-answer',
  });
  assert.deepEqual(result.defaults, {
    task: 'default-task',
    previous_response: 'no-previous-response',
  });
});

test('direct companion name mutation changes the direct terminal', () => {
  const changed = structuredClone(schema);
  changed.companion.direct.name = 'changed-companion';

  assert.deepEqual(resolveDirectCompanion(changed), {
    name: 'changed-companion',
    entry: 'runDirect',
    terminal: 'direct companion entry',
  });
});

test('direct companion entry mutation changes the direct terminal', () => {
  const changed = structuredClone(schema);
  changed.companion.direct.entry = 'changed-entry';

  assert.deepEqual(resolveDirectCompanion(changed), {
    name: 'audit-companion',
    entry: 'changed-entry',
    terminal: 'direct companion entry',
  });
});

test('workflow capability mode resolves its declared set', () => {
  assert.deepEqual(resolveCapabilities(schema, 'workflow').capabilities, ['read', 'write', 'review']);
});

test('normal capability mode resolves its declared set', () => {
  assert.deepEqual(resolveCapabilities(schema, 'normal').capabilities, ['read', 'review']);
});

test('parallel capability mode resolves its declared set', () => {
  assert.deepEqual(resolveCapabilities(schema, 'parallel').capabilities, ['read']);
});

test('package identity selects the matching same-named facet', () => {
  assert.equal(resolveScopedFacet(schema, '@takt/extended', 'audit').content, 'extended audit facet');
});

test('unknown package is rejected', () => {
  assert.throws(() => resolveScopedFacet(schema, '@takt/unknown', 'audit'));
});

test('unknown package facet is rejected', () => {
  assert.throws(() => resolveScopedFacet(schema, '@takt/core', 'missing'));
});

test('unknown capability mode is rejected', () => {
  assert.throws(() => resolveCapabilities(schema, 'background'));
});

test('undeclared companion arguments are rejected', () => {
  assert.throws(() => resolveCompanionReference(schema, { explicitArgs: { task: 'x', extra: 'y' } }));
});

test('capability schema mutation reaches the capability terminal', () => {
  const changed = structuredClone(schema);
  changed.capabilities.normal[0] = 'changed';

  assert.deepEqual(resolveCapabilities(changed, 'normal').capabilities, ['changed', 'review']);
});

test('facet schema mutation reaches the package terminal', () => {
  const changed = structuredClone(schema);
  changed.repertoires.packages['@takt/core'].facets.audit = 'changed facet';

  assert.equal(resolveScopedFacet(changed, '@takt/core', 'audit').content, 'changed facet');
});
