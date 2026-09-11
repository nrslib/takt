import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { URL } from 'node:url';
import Ajv from 'ajv';
import { parse } from 'yaml';
import buildCompletionRoutingPrompt, { loadCompletionRoutingStep } from '../completion-routing-prompt.mjs';
import { parseKimiAssistantOutput } from '../scripts/development-loop-eval.mjs';
import { scoreTransition } from './completion-routing.mjs';

const baseline_revision = 'fef072115677cc1b99e6416b05944ebdf8af0c53';

async function configuredAssertion(configName, output, vars) {
  const configUrl = new URL(`../agents/implement/${configName}.yaml`, import.meta.url);
  const config = parse(readFileSync(configUrl, 'utf8'));
  const schema = config.providers[0].config.output_schema;
  if (schema) {
    try {
      if (!new Ajv().validate(schema, JSON.parse(output))) return { pass: false, reason: 'invalid_provider_schema' };
    } catch {
      return { pass: false, reason: 'invalid_provider_schema' };
    }
  }
  const assertion = config.defaultTest.assert[0];
  const context = { vars: { ...config.defaultTest.vars, ...vars } };
  if (assertion.value.startsWith('file://')) {
    const moduleUrl = new URL(assertion.value.slice('file://'.length), configUrl);
    return (await import(moduleUrl.href)).default(output, context);
  }
  return new Function('output', 'context', assertion.value)(output, context);
}

for (const config of ['completion-scope-routing', 'completion-scope-structured']) {
  for (const language of ['ja', 'en']) {
    for (const scenario of [
      { workflow: 'development-implement-dynamic', tag: 'IMPLEMENT', number: 3, next: 'ABORT' },
      { workflow: 'development-remediation-dynamic', tag: 'FIX-PLAN', number: 2, next: 'investigate' },
    ]) {
      test(`${config}/${language}/${scenario.workflow} scores the actual transition when the number stays the same`, async () => {
        const vars = {
          language, workflow: scenario.workflow, expected_rule: scenario.number,
          expected_transition: { next: scenario.next },
        };
        const output = config.endsWith('structured')
          ? JSON.stringify({ step: scenario.number, reason: 'Required local work remains.' })
          : `[${scenario.tag}:${scenario.number}]`;
        assert.equal((await configuredAssertion(config, output, { ...vars, baseline_revision })).pass, false);
        assert.equal((await configuredAssertion(config, output, vars)).pass, true);
      });
    }
  }
}

test('the structured suite rejects malformed decisions and interactive-only candidate numbers', async () => {
  const vars = {
    language: 'en', workflow: 'development-implement-dynamic',
    expected_transition: { next: 'implement' },
  };
  for (const output of ['not json', 'null', '{}', '{"step":"3","reason":"Pending"}',
    '{"step":3,"reason":" "}', '{"step":0,"reason":"Pending"}',
    '{"step":3.5,"reason":"Pending"}', '{"step":6,"reason":"Pending"}']) {
    assert.equal((await configuredAssertion('completion-scope-structured', output, vars)).pass, false);
  }
});

test('the same tag resolves to different real transitions before and after the change', () => {
  for (const language of ['ja', 'en']) {
    const vars = { language, workflow: 'development-implement-dynamic' };
    const before = loadCompletionRoutingStep({ ...vars, baseline_revision });
    const after = loadCompletionRoutingStep(vars);
    assert.deepEqual(scoreTransition('[IMPLEMENT:3]', before, { next: 'implement' }), {
      pass: false, reason: 'wrong_transition', transition: { return: 'need_replan' },
    });
    assert.equal(scoreTransition('[IMPLEMENT:3]', after, { next: 'ABORT' }).pass, true);
  }
});

test('local investigation is absent before the change; old rule 2 is a full replan', () => {
  const before = loadCompletionRoutingStep({ language: 'ja', workflow: 'development-remediation-dynamic', baseline_revision });
  assert.equal(scoreTransition('[FIX-PLAN:2]', before, { next: 'investigate' }).pass, false);
  assert.deepEqual(scoreTransition('[FIX-PLAN:2]', before, { next: 'investigate' }).transition, { return: 'need_replan' });
});

test('missing, out-of-range, and user-input results cannot count as automatic continuation', () => {
  const step = { name: 'implement', rules: [{ condition: 'Needs user input', next: 'implement', requires_user_input: true }] };
  for (const output of ['[IMPLEMENT:0]', '[IMPLEMENT:2]', '[OTHER:1]']) {
    assert.equal(scoreTransition(output, step, { next: 'implement' }).pass, false);
  }
  assert.equal(scoreTransition('[IMPLEMENT:1]', step, { next: 'implement' }).pass, false);
});

test('routing uses the production tag parser and excludes interactive-only candidates', () => {
  const step = { name: 'implement', rules: [
    { condition: 'Ask user', next: 'implement', interactive_only: true },
    { condition: 'Ready', next: 'COMPLETE' },
    { condition: 'Incomplete', next: 'implement' },
  ] };
  assert.equal(scoreTransition('[IMPLEMENT:1] then [implement:2]', step, { next: 'implement' }).pass, true);
  assert.equal(scoreTransition('• [IMPLEMENT:1]\nExplanation', step, { next: 'COMPLETE' }).pass, true);
});

test('interactive evaluation includes the user-input candidate and preserves its transition flag', async () => {
  const step = loadCompletionRoutingStep({ language: 'en', workflow: 'development-implement' });
  const expected = { next: 'implement', requires_user_input: true };
  assert.equal(scoreTransition('[IMPLEMENT:6]', step, expected, true).pass, true);
  assert.equal(scoreTransition('[IMPLEMENT:6]', step, expected, false).pass, false);
  assert.equal(scoreTransition('[IMPLEMENT:6]', step, { next: 'implement' }, true).pass, false);
  const vars = { language: 'en', workflow: 'development-implement', report: 'An answer can unblock this work.' };
  assert.ok(buildCompletionRoutingPrompt({ vars: { ...vars, interactive: true } }).includes('[IMPLEMENT:6]'));
  assert.ok(!buildCompletionRoutingPrompt({ vars: { ...vars, interactive: false } }).includes('[IMPLEMENT:6]'));
  const output = JSON.stringify({ step: 6, reason: 'An available answer unblocks this work.' });
  assert.equal((await configuredAssertion('completion-scope-structured', output, {
    ...vars, interactive: true, expected_transition: expected,
  })).pass, true);
  assert.equal((await configuredAssertion('completion-scope-structured', output, {
    ...vars, interactive: false, expected_transition: expected,
  })).pass, false);
});

test('the structured config connects fixed input-request cases through its provider schema', async () => {
  const configUrl = new URL('../agents/implement/completion-scope-structured.yaml', import.meta.url);
  const config = parse(readFileSync(configUrl, 'utf8'));
  const caseFile = config.tests.find(file => file.endsWith('.mjs'));
  const cases = (await import(new URL(caseFile.slice('file://'.length), configUrl).href)).default();
  assert.equal(cases.length, 1);
  for (const language of config.defaultTest.vars.language) {
    const vars = { ...cases[0].vars, language };
    const decision = { step: 6, reason: 'A user answer unblocks the planned local work.' };
    assert.equal((await configuredAssertion('completion-scope-structured', JSON.stringify(decision), vars)).pass, true);
    for (const invalid of [
      { ...decision, step: 7 }, { ...decision, step: 5.5 }, { ...decision, extra: true },
    ]) {
      assert.deepEqual(await configuredAssertion('completion-scope-structured', JSON.stringify(invalid), vars), {
        pass: false, reason: 'invalid_provider_schema',
      });
    }
  }
});

test('Kimi JSON events preserve only actual assistant content', () => {
  const jsonl = [
    { role: 'meta', type: 'system.version', version: 'test' },
    { role: 'assistant', content: '[IMPLEMENT:3]' },
    { role: 'meta', type: 'session.resume_hint', sessionId: 'test-session' },
  ].map(event => JSON.stringify(event)).join('\n');
  assert.equal(parseKimiAssistantOutput(jsonl), '[IMPLEMENT:3]');
  for (const invalid of ['{}', 'not json', '{"role":"meta"}', '{"role":"assistant","content":[]}']) {
    assert.throws(() => parseKimiAssistantOutput(invalid));
  }
});

test('handoff decisions reject reuse of invalidated checks and narrowed observation criteria', async () => {
  const { scoreHandoffDecision } = await import('../scripts/development-handoff-eval.mjs');
  const expected = { run: ['npm run build', 'npm test'], carry: [], acceptance: [
    { state: 'draft', operation: 'read', time: 'before-publish', target: 'http-response', expected: '403' },
  ] };
  assert.equal(scoreHandoffDecision(JSON.stringify(expected), { expected }).pass, true);
  assert.equal(scoreHandoffDecision(JSON.stringify({ ...expected, run: ['npm test'], carry: ['npm run build'] }), { expected }).pass, false);
  assert.equal(scoreHandoffDecision(JSON.stringify({ ...expected, acceptance: [{ ...expected.acceptance[0], target: 'callback-argument' }] }), { expected }).pass, false);
  for (const output of ['null', '{}', '{"run":[1],"carry":[],"acceptance":[]}', '{"run":[],"carry":[],"acceptance":[null]}']) {
    assert.equal(scoreHandoffDecision(output, { expected }).pass, false);
  }
});

test('content audit separates explanation formatting from the fixed decision expectation', async () => {
  const { scoreHandoffDecision, scoreHandoffContent } = await import('../scripts/development-handoff-eval.mjs');
  const expected = { run: ['npm test'], carry: [], acceptance: [] };
  const output = `\`\`\`json\n${JSON.stringify(expected)}\n\`\`\`\nExplanation`;
  assert.equal(scoreHandoffDecision(output, { expected }).pass, false);
  assert.equal(scoreHandoffContent(output, { expected }).pass, true);
  assert.equal(scoreHandoffContent(output.replace('npm test', 'npm run build'), { expected }).pass, false);
  assert.equal(scoreHandoffContent(`${output}\n${output}`, { expected }).pass, false);
});

test('handoff decisions reject extra top-level fields including claims of execution', async () => {
  const { scoreHandoffDecision, scoreHandoffContent } = await import('../scripts/development-handoff-eval.mjs');
  const expected = { run: ['npm test'], carry: [], acceptance: [] };
  const output = JSON.stringify({ ...expected, executed: true });
  assert.equal(scoreHandoffDecision(output, { expected }).pass, false);
  assert.equal(scoreHandoffContent(`\`\`\`json\n${output}\n\`\`\``, { expected }).pass, false);
  assert.equal(scoreHandoffDecision(JSON.stringify({ acceptance: [], carry: [], run: ['npm test'] }), { expected }).pass, true);
});

test('action evaluation requires completed verification and rejects modified checks', async () => {
  const { scoreActionArtifacts } = await import('../scripts/development-implementation-actions.mjs');
  const directory = mkdtempSync(join(tmpdir(), 'takt-action-score-test-'));
  const files = { 'scripts/check.mjs': 'original check', 'package.json': '{}', 'TASK.md': 'task', 'reports/plan.md': 'plan' };
  const sample = { files, expected_checks: ['artifact'], expected_labels: ['LABEL'] };
  try {
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(dirname(join(directory, name)), { recursive: true });
      writeFileSync(join(directory, name), content);
    }
    mkdirSync(join(directory, 'output'));
    writeFileSync(join(directory, 'output/labels.json'), '["LABEL"]');
    assert.equal(scoreActionArtifacts(sample, directory).pass, false);
    writeFileSync(join(directory, 'checks.jsonl'), '{"check":"artifact","success":false}\n');
    assert.equal(scoreActionArtifacts(sample, directory).pass, false);
    writeFileSync(join(directory, 'checks.jsonl'), '{"check":"artifact","success":true}\n');
    assert.equal(scoreActionArtifacts(sample, directory).pass, false);
    const command = JSON.stringify({ type: 'item.completed', item: { type: 'command_execution',
      command: 'npm run test:artifact', aggregated_output: 'artifact passed\n', exit_code: 0 } });
    assert.equal(scoreActionArtifacts(sample, directory, command, 'codex').pass, true);
    const fake = command.replace('npm run test:artifact', 'node -e 0');
    assert.equal(scoreActionArtifacts(sample, directory, fake, 'codex').pass, false);
    writeFileSync(join(directory, 'scripts/check.mjs'), 'weakened check');
    assert.equal(scoreActionArtifacts(sample, directory, command, 'codex').pass, false);
    writeFileSync(join(directory, 'output/labels.json'), 'not json');
    const malformed = scoreActionArtifacts(sample, directory);
    assert.equal(malformed.pass, false);
    assert.equal(malformed.reason, 'malformed_artifacts');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('action evidence requires a completed command result, not an assistant claim', async () => {
  const { executionEvidence } = await import('../scripts/development-implementation-actions.mjs');
  const claim = { type: 'item.completed', item: { type: 'agent_message', text: 'artifact passed' } };
  const command = { type: 'item.completed', item: { type: 'command_execution',
    command: 'npm run test:artifact', aggregated_output: 'artifact passed\n', exit_code: 0 } };
  assert.equal(executionEvidence(JSON.stringify(claim), 'codex', ['artifact']).pass, false);
  assert.equal(executionEvidence(JSON.stringify(command), 'codex', ['artifact']).pass, true);
  assert.equal(executionEvidence(JSON.stringify({ ...command, item: { ...command.item, exit_code: 1 } }), 'codex', ['artifact']).pass, false);
});

test('action evidence rejects fake success output without an exact fixture check command', async () => {
  const { executionEvidence } = await import('../scripts/development-implementation-actions.mjs');
  for (const command of [
    'node -e "console.log(\'artifact passed\')"',
    'echo "npm run test:artifact; artifact passed"',
    'cat "npm run test:artifact"',
    'npm run test:artifact; echo "artifact passed"',
    'npm run test:artifact || node -e "console.log(\'artifact passed\')"',
  ]) {
    const fake = { type: 'item.completed', item: { type: 'command_execution',
      command, aggregated_output: 'artifact passed\n', exit_code: 0 } };
    assert.equal(executionEvidence(JSON.stringify(fake), 'codex', ['artifact']).pass, false, command);
  }
});

test('action evidence supports only fixed npm commands and literal sequential loops', async () => {
  const { invokedChecks } = await import('../scripts/development-implementation-actions.mjs');
  const expected = ['build', 'lint', 'unit', 'integration', 'artifact'];
  assert.deepEqual(invokedChecks('npm run build && npm run lint && npm test && npm run test:it && npm run test:artifact'), expected);
  assert.deepEqual(invokedChecks('/bin/zsh -lc \'npm run test:artifact\''), ['artifact']);
  assert.deepEqual(invokedChecks('set -e; for s in build lint test test:it test:artifact; do echo "== npm run $s"; npm run --silent $s; echo "exit=$?"; done; cat output/labels.json; echo; tail -n 5 checks.jsonl'), expected);
  for (const command of [
    'npm run test:artifact > checks.jsonl',
    'for s in test:artifact; do echo "artifact passed"; done',
    'for s in $SCRIPTS; do npm run $s; done',
    'for s in test:artifact; do npm run $s',
    'npm run test:artifact\necho "artifact passed"',
  ]) assert.deepEqual(invokedChecks(command), [], command);
});

test('Kimi action evidence records unavailable exit codes and rejects explicit failure output', async () => {
  const { executionEvidence } = await import('../scripts/development-implementation-actions.mjs');
  const call = { role: 'assistant', tool_calls: [{ id: 'check', function: { name: 'Bash',
    arguments: JSON.stringify({ command: 'npm run test:artifact' }) } }] };
  const response = content => [call, { role: 'tool', tool_call_id: 'check', content }].map(JSON.stringify).join('\n');
  assert.equal(executionEvidence(JSON.stringify(call), 'kimi', ['artifact']).pass, false);
  const evidence = executionEvidence(response('artifact passed\n'), 'kimi', ['artifact']);
  assert.equal(evidence.pass, true);
  assert.equal(evidence.evidence, 'command_and_checker_output_exit_code_unavailable');
  assert.equal(evidence.commands[0].toolStatus, 'exit_code_unavailable');
  assert.equal(evidence.commands[0].exitCode, null);
  assert.equal(Object.hasOwn(evidence.commands[0], 'completed'), false);
  for (const failure of ['Error: check failed', 'AssertionError [ERR_ASSERTION]: check failed', 'Process exit code: 1']) {
    assert.equal(executionEvidence(response(`artifact passed\n${failure}\n`), 'kimi', ['artifact']).pass, false, failure);
  }
});

test('action gates reject absent configuration with an explicit preparation error', async () => {
  const { actionGateCondition } = await import('../scripts/development-implementation-actions.mjs');
  for (const config of [null, {}, { workflow_overrides: { steps: { implement: { quality_gates: {} } } } }]) {
    assert.throws(() => actionGateCondition(JSON.stringify(config), 'candidate'), {
      code: 'ERR_ASSERTION', message: /candidate: .*no implement quality gate for npm run test:e2e:smoke/,
    });
  }
});

test('action gates ignore command objects and validate the selected string condition', async () => {
  const { actionGateCondition } = await import('../scripts/development-implementation-actions.mjs');
  const config = quality_gates => JSON.stringify({ workflow_overrides: { steps: { implement: { quality_gates } } } });
  const gate = 'Run npm run test:e2e:smoke only when CLI startup, workflow execution, or config loading changes, and verify success.';
  assert.equal(actionGateCondition(config([{ command: 'npm test' }, null, gate]), 'candidate'),
    'only when tools/platform, command startup, or configuration loading changes');
  assert.throws(() => actionGateCondition(config([{ command: 'npm run test:e2e:smoke' }]), 'candidate'), {
    code: 'ERR_ASSERTION', message: /no implement quality gate/,
  });
  assert.throws(() => actionGateCondition(config(['Run npm run test:e2e:smoke.']), 'candidate'), {
    code: 'ERR_ASSERTION', message: /candidate: smoke gate wording does not match/,
  });
});

test('Codex action evidence counts non-JSON diagnostics while retaining command results', async () => {
  const { executionEvidence } = await import('../scripts/development-implementation-actions.mjs');
  const event = JSON.stringify({ type: 'item.completed', item: { type: 'command_execution',
    command: 'npm run test:artifact', aggregated_output: 'artifact passed\n', exit_code: 0 } });
  const evidence = executionEvidence(`diagnostic before\n${event}\ndiagnostic after\n`, 'codex', ['artifact']);
  assert.equal(evidence.pass, true);
  assert.equal(evidence.unparsedLines, 2);
  assert.equal(executionEvidence('diagnostics only\n', 'codex', ['artifact']).pass, false);
  for (const cli of ['claude', 'kimi']) {
    assert.throws(() => executionEvidence(`diagnostic\n${event}`, cli, ['artifact']), SyntaxError);
  }
});

for (const cli of ['codex', 'kimi']) {
  test(`${cli} action evidence rejects missing or non-string output without throwing`, async () => {
    const { executionEvidence } = await import('../scripts/development-implementation-actions.mjs');
    for (const output of [undefined, null, { text: 'artifact passed' }, ['artifact passed']]) {
      const events = cli === 'codex' ? [{ type: 'item.completed', item: { type: 'command_execution',
        command: 'npm run test:artifact', aggregated_output: output, exit_code: 0 } }] : [
        { role: 'assistant', tool_calls: [{ id: 'check', function: { name: 'Bash',
          arguments: JSON.stringify({ command: 'npm run test:artifact' }) } }] },
        { role: 'tool', tool_call_id: 'check', content: output },
      ];
      const evidence = executionEvidence(events.map(JSON.stringify).join('\n'), cli, ['artifact']);
      assert.equal(evidence.pass, false);
      assert.equal(evidence.commands[0].output, '');
    }
  });
}

test('action restart archives incomplete samples and protects completed records', async () => {
  const { prepareActionSample } = await import('../scripts/development-implementation-actions.mjs');
  const directory = mkdtempSync(join(tmpdir(), 'takt-action-restart-test-'));
  const sampleRoot = join(directory, 'codex-sample');
  const workspaces = [];
  try {
    const original = {
      'working-directory.txt': '/original-workspace', 'private-error.txt': 'original diagnostic',
      'project/partial.txt': 'unfinished work', 'provider-events.jsonl': 'original events',
    };
    for (const [name, content] of Object.entries(original)) {
      mkdirSync(dirname(join(sampleRoot, name)), { recursive: true });
      writeFileSync(join(sampleRoot, name), content);
    }
    for (let attempt = 1; attempt <= 2; attempt++) {
      const cwd = prepareActionSample(sampleRoot, { 'TASK.md': 'fixed task' });
      workspaces.push(cwd);
      assert.equal(readFileSync(join(sampleRoot, 'working-directory.txt'), 'utf8'), cwd);
      assert.equal(readFileSync(join(cwd, 'TASK.md'), 'utf8'), 'fixed task');
      assert.equal(existsSync(join(sampleRoot, 'private-error.txt')), false);
      const archives = readdirSync(directory).filter(name => name.startsWith('codex-sample.interrupted-'));
      assert.equal(archives.length, attempt);
      if (attempt === 1) {
        for (const [name, content] of Object.entries(original)) {
          assert.equal(readFileSync(join(directory, archives[0], 'sample', name), 'utf8'), content);
        }
      }
    }
    writeFileSync(join(sampleRoot, 'result.json'), '{"pass":true}');
    assert.throws(() => prepareActionSample(sampleRoot, {}), /completed action sample/);
    assert.equal(readFileSync(join(sampleRoot, 'result.json'), 'utf8'), '{"pass":true}');
    assert.equal(readdirSync(directory).filter(name => name.startsWith('codex-sample.interrupted-')).length, 2);
  } finally {
    for (const workspace of workspaces) rmSync(workspace, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  }
});
