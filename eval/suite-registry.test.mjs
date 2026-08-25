import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  PROMPT_EVAL_SUITES,
  discoverPromptEvalConfigs,
  promptEvalPrepareTargets,
  selectPromptEvalSuites,
} from './suite-registry.mjs';
import { PREPARE_TARGET_IDS } from './scripts/prepare.mjs';

test('registry classifies every promptfoo config exactly once', () => {
  const configs = discoverPromptEvalConfigs();

  assert.deepEqual(
    PROMPT_EVAL_SUITES.map(({ name, config }) => ({ name, config })),
    configs,
  );
  assert.equal(new Set(PROMPT_EVAL_SUITES.map(({ name }) => name)).size, configs.length);
  assert.ok(PROMPT_EVAL_SUITES.every(({ reason }) => reason.length > 0));
  assert.ok(PROMPT_EVAL_SUITES.every(({ config }) => /^(agents|scenarios)\//.test(config)));
});

test('recursive discovery rejects duplicate suite names across categories', () => {
  const directory = mkdtempSync(join(tmpdir(), 'takt-eval-registry-'));
  try {
    const agentDirectory = join(directory, 'agents', 'review-adjudication');
    const scenarioDirectory = join(directory, 'scenarios', 'review-to-adjudication');
    mkdirSync(agentDirectory, { recursive: true });
    mkdirSync(scenarioDirectory, { recursive: true });
    writeFileSync(join(agentDirectory, 'duplicate.yaml'), 'description: agent\n');
    writeFileSync(join(scenarioDirectory, 'duplicate.yml'), 'description: scenario\n');

    assert.throws(
      () => discoverPromptEvalConfigs(directory),
      /Prompt eval suite name duplicated: duplicate/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('recursive discovery returns nested configs with root-relative paths and ignores non-YAML files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'takt-eval-registry-'));
  try {
    const agentDirectory = join(directory, 'agents', 'review', 'nested');
    const scenarioDirectory = join(directory, 'scenarios', 'flow');
    mkdirSync(agentDirectory, { recursive: true });
    mkdirSync(scenarioDirectory, { recursive: true });
    writeFileSync(join(agentDirectory, 'alpha.yaml'), 'description: alpha\n');
    writeFileSync(join(scenarioDirectory, 'beta.yml'), 'description: beta\n');
    writeFileSync(join(agentDirectory, 'README.md'), '# ignored\n');

    const discovered = discoverPromptEvalConfigs(directory);

    assert.deepEqual(discovered, [
      { name: 'alpha', config: 'agents/review/nested/alpha.yaml' },
      { name: 'beta', config: 'scenarios/flow/beta.yml' },
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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

test('every registered prepare target resolves to an actual prepare target', () => {
  const availableTargets = new Set(PREPARE_TARGET_IDS);
  const unresolvedTargets = promptEvalPrepareTargets(PROMPT_EVAL_SUITES)
    .filter((target) => !availableTargets.has(target));

  assert.deepEqual(unresolvedTargets, []);
});
