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

test('planner reaches direct, reference, mode, and package terminals', () => {
  const plan = buildCompanionPlan({
    explicitArgs: { task: 'explicit-task' },
    mode: 'workflow',
    packageName: '@takt/core',
    facetName: 'audit',
  });

  assert.equal(plan.direct.name, 'audit-companion');
  assert.equal(plan.direct.entry, 'runDirect');
  assert.deepEqual(plan.reference.args, {
    task: 'explicit-task',
    previous_response: 'no-previous-response',
  });
  assert.equal(plan.capability.mode, 'workflow');
  assert.deepEqual(plan.capability.capabilities, ['read', 'write', 'review']);
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

test('direct companion mutation changes the direct terminal', () => {
  const changed = structuredClone(schema);
  changed.companion.direct.name = 'changed-companion';
  changed.companion.direct.entry = 'changed-entry';

  assert.deepEqual(resolveDirectCompanion(changed), {
    name: 'changed-companion',
    entry: 'changed-entry',
    terminal: 'direct companion entry',
  });
});

test('each capability mode is resolved from its own input state', () => {
  assert.deepEqual(resolveCapabilities(schema, 'workflow').capabilities, ['read', 'write', 'review']);
  assert.deepEqual(resolveCapabilities(schema, 'normal').capabilities, ['read', 'review']);
  assert.deepEqual(resolveCapabilities(schema, 'parallel').capabilities, ['read']);
});

test('package identity selects the matching same-named facet', () => {
  assert.equal(resolveScopedFacet(schema, '@takt/extended', 'audit').content, 'extended audit facet');
  assert.throws(() => resolveScopedFacet(schema, '@takt/unknown', 'audit'));
  assert.throws(() => resolveScopedFacet(schema, '@takt/core', 'missing'));
});

test('unknown mode and undeclared arguments are rejected', () => {
  assert.throws(() => resolveCapabilities(schema, 'background'));
  assert.throws(() => resolveCompanionReference(schema, { explicitArgs: { task: 'x', extra: 'y' } }));
});

test('schema mutations reach their corresponding terminals', () => {
  const changed = structuredClone(schema);
  changed.capabilities.normal = ['changed'];
  changed.repertoires.packages['@takt/core'].facets.audit = 'changed facet';

  assert.deepEqual(resolveCapabilities(changed, 'normal').capabilities, ['changed']);
  assert.equal(resolveScopedFacet(changed, '@takt/core', 'audit').content, 'changed facet');
});
