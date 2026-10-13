import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { StatusJudgmentBuilder } from '../dist/core/workflow/instruction/StatusJudgmentBuilder.js';
import { parseWorkflowRuleCondition } from '../dist/core/models/workflow-rule-condition.js';
import { generateStatusRulesComponents } from '../dist/core/workflow/instruction/status-rules.js';
import { renderTemplate } from '../dist/shared/prompts/index.js';
import { buildWrappedSystemPrompt } from '../dist/agents/runner-prompt.js';
import { invalidateAllResolvedConfigCache, invalidateGlobalConfigCache, loadPersonaPromptFromPath } from '../dist/infra/config/index.js';
import { runAgent } from '../dist/agents/runner.js';
import { MockProvider } from '../dist/infra/providers/mock.js';
import buildPrompt, { loadPhase3JudgmentRules } from './phase3-judgment-prompt.mjs';
import assertJudgment from './asserts/phase3-judgment.mjs';
import { selectPromptEvalSuites, promptEvalPrepareTargets } from './suite-registry.mjs';

const evalDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(evalDir, '..');
const suitePath = resolve(evalDir, 'agents/phase3-judgment/phase3-follow-input.yaml');
const suiteDir = dirname(suitePath);
const suite = parse(readFileSync(suitePath, 'utf8'), { merge: true });
const baseVars = {
  language: 'ja', variant: 'candidate', workflow: 'development-remediation-dynamic',
  step_name: 'fix-verifier', input_source: 'report', input: '検証対象を照合した。',
};

function caseVars(testCase, variant) {
  const vars = { ...suite.defaultTest.vars, ...testCase.vars, variant };
  vars.input = readFileSync(resolve(suiteDir, vars.input.slice('file://'.length)), 'utf8');
  return vars;
}

function sourceTemplate(variant, language) {
  const path = `src/shared/prompts/${language}/perform_phase3_message.md`;
  const source = variant === 'baseline'
    ? execFileSync('git', ['show', `${suite.defaultTest.vars.baseline_revision}:${path}`], { cwd: repoRoot, encoding: 'utf8' })
    : readFileSync(resolve(repoRoot, path), 'utf8');
  return source
    .replace(/^<!-- markdownlint-disable MD041 -->\r?\n/, '')
    .replace(/<!--[\s\S]*?-->/g, '');
}

function runnerSystem(variant, language) {
  const personaPath = variant === 'candidate'
    ? resolve(repoRoot, `builtins/${language}/facets/personas/conductor.md`)
    : undefined;
  const definition = personaPath === undefined ? 'conductor' : loadPersonaPromptFromPath(personaPath, repoRoot);
  return buildWrappedSystemPrompt(definition, { language, personaPath, providerRuntimeInstructions: null });
}

test('loads workflow-owned uses rules, parallel sub-step rules, and loop monitors', () => {
  const verifier = loadPhase3JudgmentRules(baseVars);
  assert.equal(verifier.name, 'fix-verifier');
  assert.equal(verifier.candidates[0].label, 'verified');
  assert.equal(verifier.candidates.length, 3);
  const reviewer = loadPhase3JudgmentRules({ language: 'en', workflow: 'review-backend', step_name: 'coding-review' });
  assert.deepEqual(reviewer.candidates.map(({ label }) => label), ['approved', 'needs_fix']);
  const monitor = loadPhase3JudgmentRules({ language: 'en', workflow: 'development-remediation-dynamic', loop_monitor_index: 2 });
  assert.equal(monitor.name, '_loop_judge_fix-retry_fix-verifier');
  assert.equal(monitor.candidates[3].label, 'No feasible path can satisfy the requirements');
  for (const language of ['ja', 'en']) {
    const finalGate = loadPhase3JudgmentRules({ language, workflow: 'peer-review', step_name: 'final-gate' });
    assert.equal(finalGate.name, 'final-gate');
    assert.deepEqual(finalGate.candidates.map(({ label }) => label), ['APPROVE', 'REJECT', 'BLOCKED']);
    const firstMonitor = loadPhase3JudgmentRules({ language, workflow: 'development-remediation-dynamic', loop_monitor_index: 1 });
    assert.equal(firstMonitor.name, '_loop_judge_fix');
    assert.equal(firstMonitor.candidates[0].label, language === 'ja'
      ? '健全（修正進捗があり、報告内容も収束している）'
      : 'Healthy (fix progress exists and report content is converging)');
  }
});

for (const language of ['ja', 'en']) {
  test(`matches the system actually assembled by the production runner (${language})`, async (t) => {
    const globalDir = mkdtempSync(resolve(tmpdir(), 'phase3-eval-runner-'));
    const previousConfigDir = process.env.TAKT_CONFIG_DIR;
    process.env.TAKT_CONFIG_DIR = globalDir;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    t.mock.method(MockProvider.prototype, 'setup', () => ({
      call: async () => ({ persona: 'conductor', status: 'done', content: '', timestamp: new Date() }),
    }));
    try {
      for (const variant of ['baseline', 'candidate']) {
        const personaPath = variant === 'candidate'
          ? resolve(repoRoot, `builtins/${language}/facets/personas/conductor.md`)
          : undefined;
        let productionSystem;
        await runAgent('conductor', 'judge', {
          cwd: globalDir, language, personaPath, allowedTools: [],
          resolvedExecution: { provider: 'mock', model: undefined, providerOptions: undefined, permissionMode: undefined },
          onPromptResolved: ({ systemPrompt }) => { productionSystem = systemPrompt; },
        });
        assert.equal(productionSystem, runnerSystem(variant, language));
        const prompt = buildPrompt({ vars: {
          ...baseVars, language, variant, baseline_revision: suite.defaultTest.vars.baseline_revision,
        } });
        assert.ok(prompt.startsWith(`${productionSystem}\n\n`));
      }
    } finally {
      if (previousConfigDir === undefined) delete process.env.TAKT_CONFIG_DIR;
      else process.env.TAKT_CONFIG_DIR = previousConfigDir;
      invalidateGlobalConfigCache();
      invalidateAllResolvedConfigCache();
      rmSync(globalDir, { recursive: true, force: true });
    }
  });

  test(`switches both system and source template for baseline / candidate (${language})`, () => {
    const vars = { ...baseVars, language, baseline_revision: suite.defaultTest.vars.baseline_revision };
    const { name, candidates } = loadPhase3JudgmentRules(vars);
    const { criteriaTable } = generateStatusRulesComponents(name, candidates, language);
    const prompts = {};
    for (const variant of ['baseline', 'candidate']) {
      const system = runnerSystem(variant, language);
      const user = renderTemplate(sourceTemplate(variant, language), {
        structuredOutput: true, reportContent: vars.input, criteriaTable,
      });
      prompts[variant] = buildPrompt({ vars: { ...vars, variant } });
      assert.equal(prompts[variant], `${system}\n\n${user}`);
      assert.doesNotMatch(prompts[variant], /<!--|\{\{#if|template: perform_phase3/);
    }
    assert.notEqual(prompts.baseline, prompts.candidate);
    assert.equal(runnerSystem('baseline', language), 'conductor');
    assert.match(runnerSystem('candidate', language), /^# TAKT$/m);
    assert.notEqual(sourceTemplate('baseline', language), sourceTemplate('candidate', language));
  });

  test(`matches the production StatusJudgmentBuilder for report and response (${language})`, () => {
    const definition = parse(readFileSync(resolve(repoRoot, `builtins/${language}/workflows/development-remediation-dynamic.yaml`), 'utf8'));
    const rawStep = definition.steps.find(({ name }) => name === 'fix-verifier');
    const step = {
      name: rawStep.name,
      rules: rawStep.rules.map((rule) => ({
        condition: parseWorkflowRuleCondition(rule.condition),
        interactiveOnly: rule.interactive_only, appendix: rule.appendix,
      })),
    };
    const system = runnerSystem('candidate', language);
    for (const inputSource of ['report', 'response']) {
      const production = new StatusJudgmentBuilder(step, {
        language, inputSource, structuredOutput: true,
        ...(inputSource === 'report' ? { reportContent: baseVars.input } : { lastResponse: baseVars.input }),
      }).build();
      const prompt = buildPrompt({ vars: { ...baseVars, language, input_source: inputSource } });
      assert.equal(prompt, `${system}\n\n${production}`);
      assert.equal(prompt.includes('\n## Agent Response\n\n'), inputSource === 'response');
    }
  });
}

test('adds the same JSON instruction only for Claude or an explicit json_instruction', () => {
  for (const language of ['ja', 'en']) {
    const instruction = language === 'ja'
      ? '出力は {"step": <整数>, "reason": "<文字列>"} の JSON オブジェクトだけにしてください。'
      : 'Return only a JSON object of the form {"step": <integer>, "reason": "<string>"}.';
    for (const variant of ['baseline', 'candidate']) {
      const vars = { ...baseVars, language, variant, baseline_revision: suite.defaultTest.vars.baseline_revision };
      const codex = buildPrompt({ vars, provider: { config: { model: 'gpt-6.1-sol' } } });
      assert.ok(!codex.includes(instruction));
      assert.equal(buildPrompt({ vars, provider: { config: { cli: 'claude' } } }), `${codex}\n\n${instruction}`);
      assert.equal(buildPrompt({ vars: { ...vars, json_instruction: true } }), `${codex}\n\n${instruction}`);
    }
  }
});

test('rejects missing or malformed input, baseline revisions, and ambiguous rule sources', () => {
  for (const [overrides, error] of [
    [{ variant: 'unknown' }, /Unknown variant/],
    [{ variant: 'baseline' }, /required for baseline/],
    [{ baseline_revision: 'HEAD' }, /full commit SHA/],
    [{ baseline_revision: '-'.repeat(40) }, /full commit SHA/],
    [{ language: 'fr' }, /Unknown language/],
    [{ workflow: '../review-backend' }, /builtin workflow name/],
    [{ step_name: '' }, /non-empty string/],
    [{ step_name: 'missing' }, /Missing rules/],
    [{ step_name: undefined }, /exactly one/],
    [{ loop_monitor_index: 2 }, /exactly one/],
    [{ step_name: undefined, loop_monitor_index: 0 }, /1-based integer/],
    [{ step_name: undefined, loop_monitor_index: 99 }, /Missing rules/],
    [{ input_source: 'code' }, /Unknown input_source/],
    [{ input: '' }, /non-empty text/],
  ]) {
    assert.throws(() => buildPrompt({ vars: { ...baseVars, ...overrides } }), error);
  }
});

test('covers eight cases in both languages and variants without rendering grading expectations', () => {
  assert.equal(suite.tests.length, 16);
  assert.deepEqual(suite.defaultTest.vars.variant, ['baseline', 'candidate']);
  const expectedLabels = {
    ja: ['verified', 'approved', '要件を満たす実現可能な打開手段がない', 'needs_fix', 'needs_fix', 'verified',
      'APPROVE', '健全（修正進捗があり、報告内容も収束している）'],
    en: ['verified', 'approved', 'No feasible path can satisfy the requirements', 'needs_fix', 'needs_fix', 'verified',
      'APPROVE', 'Healthy (fix progress exists and report content is converging)'],
  };
  const seen = new Set();
  let rows = 0;
  for (const testCase of suite.tests) {
    const caseNumber = Number(testCase.description.split(' ')[0]);
    for (const variant of suite.defaultTest.vars.variant) {
      const vars = caseVars(testCase, variant);
      assert.equal(vars.expected_label, expectedLabels[vars.language][caseNumber - 1]);
      const { candidates } = loadPhase3JudgmentRules(vars);
      const step = candidates.findIndex(({ label }) => label === vars.expected_label) + 1;
      assert.ok(step > 0);
      assert.equal(assertJudgment(JSON.stringify({ step, reason: 'Input evidence.' }), { vars }).pass, true);
      const prompt = buildPrompt({ vars });
      const marker = 'GRADING_EXPECTATION_MUST_STAY_PRIVATE';
      assert.equal(buildPrompt({ vars: { ...vars, expected_label: marker } }), prompt);
      assert.ok(!prompt.includes(marker));
      assert.doesNotMatch(prompt, /expected_label|baseline_revision|file:\/\/|variant:/);
      if (caseNumber === 6) assert.doesNotMatch(vars.input, /^## (結果|Result)/m);
      assert.equal(vars.input_source, [3, 8].includes(caseNumber) ? 'response' : 'report');
      seen.add(`${caseNumber}/${vars.language}/${variant}`);
      rows += testCase.providers.length;
    }
  }
  assert.equal(seen.size, 32);
  assert.equal(rows, 96);
});

test('binds every case to only its fixture and the required native-schema and strengthened providers', () => {
  assert.equal(suite.evaluateOptions.repeat, 3);
  assert.equal(suite.evaluateOptions.maxConcurrency, 3);
  assert.equal(suite.defaultTest.assert[0].metric, 'phase3-follow-input/row');
  const schema = JSON.parse(readFileSync(resolve(repoRoot, 'builtins/schemas/judgment.json'), 'utf8'));
  const fixtures = ['tool-refusal', 'refund', 'ingestion', 'config', 'refund', 'tool-refusal', 'signup', 'inventory'];
  assert.equal(suite.providers.length, 18);
  assert.equal(new Set(suite.providers.map(({ label }) => label)).size, 18);
  for (const testCase of suite.tests) {
    const fixture = fixtures[Number(testCase.description.split(' ')[0]) - 1];
    assert.equal(testCase.providers.length, 3);
    const providers = testCase.providers.map((label) => suite.providers.find((provider) => provider.label === label));
    assert.ok(providers.every(Boolean));
    assert.deepEqual(providers.map(({ config }) => config.model), ['gpt-6.1-sol', 'gpt-6-luna', 'claude-opus-5']);
    for (const provider of providers) {
      const { config } = provider;
      const root = provider.id === 'openai:codex-sdk' ? suiteDir : evalDir;
      assert.equal(resolve(root, config.working_dir), resolve(evalDir, 'fixtures/phase3-judgment', fixture));
      if (provider.id === 'openai:codex-sdk') {
        assert.equal(config.sandbox_mode, 'read-only');
        assert.equal(config.approval_policy, 'never');
        assert.equal(config.skip_git_repo_check, true);
        assert.equal(config.model_reasoning_effort, config.model === 'gpt-6.1-sol' ? 'low' : 'max');
        assert.deepEqual(config.output_schema, schema);
      } else {
        assert.equal(provider.id, 'file://../../providers/cli-review.mjs');
        assert.match(provider.label, /強めた条件/);
        assert.equal(config.cli, 'claude');
        assert.equal(config.isolate_working_dir, true);
      }
    }
  }
  const [registered] = selectPromptEvalSuites({ names: ['phase3-follow-input'] });
  assert.equal(registered.execution.defaultEligible, false);
  assert.deepEqual(registered.execution.credentials, ['codex', 'claude']);
  assert.equal(registered.execution.cost, 'high');
  assert.deepEqual(promptEvalPrepareTargets([registered]), []);
});

for (const fixture of ['tool-refusal', 'refund', 'ingestion', 'config', 'signup', 'inventory']) {
  test(`fixture node --test passes (${fixture})`, () => {
    const cwd = resolve(evalDir, 'fixtures/phase3-judgment', fixture);
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const output = execFileSync(process.execPath, ['--test', '--test-reporter=tap'], { cwd, env, encoding: 'utf8' });
    assert.match(output, /# tests [1-9]\d*/);
    assert.match(output, /# fail 0/);
  });
}

test('refund fixture retains a payment whose rounding differs from the README half-cent rule', async () => {
  const { refundPayment } = await import('./fixtures/phase3-judgment/refund/src/refund.mjs');
  // 1.20 × (1 - 0.25) × (1 - 0.05) = 0.855。README の規則では 0.86 になる。
  assert.equal(refundPayment('order-1048').amount, 0.85);
});

test('signup fixture retains the registration after confirmation delivery fails', async () => {
  const { registerMember } = await import('./fixtures/phase3-judgment/signup/src/signup.mjs');
  const members = new Map();
  const failure = new Error('Delivery unavailable');
  await assert.rejects(registerMember('member@example.test', members, async () => {
    throw failure;
  }), (error) => error === failure);
  assert.equal(members.has('member@example.test'), true);
  await assert.rejects(registerMember('member@example.test', members, async () => {}), /already registered/);
});

test('inventory fixture retains an unconverted case count in a warehouse absent from the findings list', async () => {
  const { syncInventory } = await import('./fixtures/phase3-judgment/inventory/src/sync-stock.mjs');
  const [stock] = syncInventory([{ warehouse: 'FUKUOKA', sku: 'paper-01', cases: 2, looseUnits: 1 }]);
  assert.equal(stock.quantity, 3);
  assert.notEqual(stock.quantity, 2 * 6 + 1);
});
