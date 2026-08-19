import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import test from 'node:test';

import {
  PROMPT_EVAL_SUITES,
  promptEvalPrepareTargets,
  selectPromptEvalSuites,
} from './suite-registry.mjs';

test('registry classifies every promptfoo config exactly once', () => {
  const configs = readdirSync(new URL('.', import.meta.url))
    .flatMap((fileName) => {
      const match = /^promptfooconfig\.(.+)\.yaml$/.exec(fileName);
      return match === null ? [] : [match[1]];
    })
    .sort();

  assert.deepEqual(PROMPT_EVAL_SUITES.map(({ name }) => name), configs);
  assert.equal(new Set(PROMPT_EVAL_SUITES.map(({ name }) => name)).size, configs.length);
  assert.ok(PROMPT_EVAL_SUITES.every(({ reason }) => reason.length > 0));
});
test('default selection is active and default-eligible only', () => {
  const selected = selectPromptEvalSuites();

  assert.ok(selected.length > 0);
  assert.ok(selected.every(({ tier, execution }) => tier === 'active' && execution.defaultEligible));
  assert.ok(!selected.some(({ name }) => name === 'fix-loop-convergence'));
});

test('retained tier selection is explicit and independent from auth or cost metadata', () => {
  const retained = selectPromptEvalSuites({ tier: 'retained' });

  assert.ok(retained.every(({ tier }) => tier === 'retained'));
  assert.ok(retained.some(({ execution }) => !execution.defaultEligible));
  assert.ok(retained.some(({ execution }) => execution.cost === 'high'));
});

test('individual suite selection preserves active and retained compatibility', () => {
  const selected = selectPromptEvalSuites({ names: ['arch', 'fix-closure'] });

  assert.deepEqual(selected.map(({ name }) => name), ['arch', 'fix-closure']);
  assert.deepEqual(selected.map(({ tier }) => tier), ['active', 'retained']);
});

test('prepare targets are resolved from the same suite registry', () => {
  const selected = selectPromptEvalSuites({
    names: ['coding', 'final-readiness-preservation', 'fix-loop-convergence'],
  });

  assert.deepEqual(
    promptEvalPrepareTargets(selected),
    ['coding-review', 'final-readiness-supervision-phase2'],
  );
});
