import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';

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

test('frontend suite prompts bind to their matching prepared run directories', () => {
  for (const configName of ['frontend.yaml', 'frontend-opus.yaml']) {
    const source = readFileSync(
      new URL(`./agents/frontend-review/${configName}`, import.meta.url),
      'utf8',
    );
    assert.match(
      source,
      /label: frontend-review\s+raw: file:\/\/\.\.\/\.\.\/prompts\/frontend-review\.phase1\.j2\s+config:\s+working_dir: \.work\/frontend-review/s,
    );
    assert.match(
      source,
      /label: frontend-review-react\s+raw: file:\/\/\.\.\/\.\.\/prompts\/frontend-review-react\.phase1\.j2\s+config:\s+working_dir: \.work\/frontend-review-react/s,
    );
    assert.match(
      source,
      /required_snapshots:\s+- \.takt\/eval-snapshots\/frontend-review(?:-react)?-policies\.md\s+- \.takt\/eval-snapshots\/frontend-review(?:-react)?-knowledge\.md/s,
    );
    assert.doesNotMatch(source, /working_dir: fixtures\/frontend-design/);
  }

  const selected = selectPromptEvalSuites({ names: ['frontend', 'frontend-opus'] });
  assert.deepEqual(
    promptEvalPrepareTargets(selected),
    ['frontend-review', 'frontend-review-react'],
  );
});

test('every registered prepare target resolves to an actual prepare target', () => {
  const availableTargets = new Set(PREPARE_TARGET_IDS);
  const unresolvedTargets = promptEvalPrepareTargets(PROMPT_EVAL_SUITES)
    .filter((target) => !availableTargets.has(target));

  assert.deepEqual(unresolvedTargets, []);
});

test('threat model and platform cases bind each task to its own isolated fixture', () => {
  for (const [suite, directory, cases] of [
    ['security-threat-model', 'security-review', ['a1', 'a2', 'a3', 'a4', 'a5']],
    ['secondary-platform-adjudication', 'review-adjudication',
      Array.from({ length: 12 }, (_, index) => `b${index + 1}`)],
  ]) {
    const source = readFileSync(new URL(`./agents/${directory}/${suite}.yaml`, import.meta.url), 'utf8');
    const config = parse(source);
    assert.deepEqual(config.prompts.map(({ label }) => label), cases);
    assert.deepEqual(config.tests.map(({ description }) => description.toLowerCase()), cases);

    for (const caseId of cases) {
      const target = `${suite}-${caseId}`;
      const prompt = config.prompts.find(({ label }) => label === caseId);
      const testCase = config.tests.find(({ description }) => description.toLowerCase() === caseId);
      assert.equal(prompt.raw, `file://../../prompts/${target}.phase1.j2`);
      assert.equal(prompt.config.working_dir, `fixtures/${suite}/${caseId}`);
      assert.deepEqual(testCase.prompts, [caseId]);
      assert.equal(testCase.vars.task, `file://../../cases/${target}-task.md`);
      assert.equal(testCase.vars.previous_response, '');
      assert.equal(prompt.config.required_snapshots[0],
        `.takt/eval-snapshots/${target}-policies.md`);
      if (suite === 'security-threat-model' && ['a1', 'a3', 'a5'].includes(caseId)) {
        assert.deepEqual(prompt.config.required_snapshots, [
          `.takt/eval-snapshots/${target}-policies.md`,
          `.takt/eval-snapshots/${target}-knowledge.md`,
        ]);
      }
      assert.ok(testCase.assert.some(({ type }) => type === 'llm-rubric'));
      if (suite === 'security-threat-model') {
        const result = testCase.assert.find(({ type }) => type === 'regex');
        if (['a1', 'a2'].includes(caseId)) {
          assert.equal(result, undefined);
        } else {
          assert.equal(result.value, '(結果|Result)\\s*[:：]\\s*REJECT');
        }
      } else {
        assert.deepEqual(testCase.assert.map(({ metric }) => metric),
          [`${suite}/${caseId}-boundary`]);
        if (caseId === 'b2') {
          assert.match(testCase.assert[0].value, /実装.*または.*停止/);
        }
        if (caseId === 'b11') {
          assert.match(testCase.assert[0].value, /実装とこの環境で動くテスト、または.*処理前/);
        }
        if (caseId === 'b12') {
          assert.match(testCase.assert[0].value, /修正対象または外部確認待ちを残した場合だけ不合格/);
        }
      }
    }

    assert.deepEqual(config.providers.map(({ label }) => label),
      ['codex-sol-low', 'claude-opus-5', 'codex-luna-max']);
    assert.ok(config.providers.every(({ id, config: provider }) =>
      id === 'file://../../providers/cli-review.mjs'
      && provider.isolate_working_dir === true
      && provider.working_dir === undefined));
    assert.deepEqual(promptEvalPrepareTargets(selectPromptEvalSuites({ names: [suite] })),
      cases.map((caseId) => `${suite}-${caseId}`));
  }
});
