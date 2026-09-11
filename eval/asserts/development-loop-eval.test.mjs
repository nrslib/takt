import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { loadCompletionRoutingStep } from '../completion-routing-prompt.mjs';
import { parseKimiAssistantOutput } from '../scripts/development-loop-eval.mjs';
import { scoreTransition } from './completion-routing.mjs';

const baseline_revision = 'fef072115677cc1b99e6416b05944ebdf8af0c53';

async function configuredAssertion(configName, output, vars) {
  const configUrl = new URL(`../agents/implement/${configName}.yaml`, import.meta.url);
  const config = parse(readFileSync(configUrl, 'utf8'));
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
      { workflow: 'development-implement-dynamic', tag: 'IMPLEMENT', number: 3, next: 'implement' },
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
    assert.equal(scoreTransition('[IMPLEMENT:3]', after, { next: 'implement' }).pass, true);
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
