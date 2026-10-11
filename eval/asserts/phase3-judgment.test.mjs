import assert from 'node:assert/strict';
import test from 'node:test';
import assertJudgment, { scorePhase3Judgment } from './phase3-judgment.mjs';
import { loadPhase3JudgmentRules } from '../phase3-judgment-prompt.mjs';

const candidates = [{ label: 'approved' }, { label: 'needs_fix' }];

test('maps a 1-based step to the condition label rather than to a transition', () => {
  assert.deepEqual(scorePhase3Judgment('{"step":2,"reason":"An unresolved finding remains."}', candidates, 'needs_fix'), {
    pass: true, score: 1, reason: 'expected_rule (json)', label: 'needs_fix', format: 'json',
  });
});

test('reads the last JSON object from CLI prose and Markdown fences', () => {
  const output = 'Earlier: {"step":1,"reason":"approved"}\nFinal:\n```json\n{"step":2,"reason":"Finding {CODE-01} remains."}\n```\nEnd.';
  assert.equal(scorePhase3Judgment(output, candidates, 'needs_fix').pass, true);
});

test('handles escaped quotes, braces, and nested objects without selecting an inner object', () => {
  const output = JSON.stringify({ metadata: { step: 1, reason: 'preliminary' }, step: 2, reason: 'Finding "CODE-01" {unresolved} \\ evidence.' });
  assert.equal(scorePhase3Judgment(output, candidates, 'needs_fix').pass, true);
});

test('does not reuse an earlier decision when the final JSON has an invalid step', () => {
  assert.equal(scorePhase3Judgment('{"step":1,"reason":"earlier"}\n{"step":99,"reason":"final"}', candidates, 'approved').reason, 'invalid_step (json)');
});

test('distinguishes invalid JSON from a decision for the wrong rule', () => {
  for (const output of ['No decision.', '```json\n{"step":2,}\n```', '{"step":2}', '{"step":2,"reason":null}', null]) {
    assert.deepEqual(scorePhase3Judgment(output, candidates, 'needs_fix'), {
      pass: false, score: 0, reason: 'invalid_json (json)', label: null, format: 'json',
    });
  }
  assert.deepEqual(scorePhase3Judgment('{"step":1,"reason":"Approved."}', candidates, 'needs_fix'), {
    pass: false, score: 0, reason: 'wrong_rule (json)', label: 'approved', format: 'json',
  });
});

test('rejects missing, fractional, nonnumeric, and out-of-range steps', () => {
  for (const step of [undefined, 0, -1, 3, 1.5, '2', null]) {
    assert.deepEqual(scorePhase3Judgment(JSON.stringify({ step, reason: 'Evidence.' }), candidates, 'needs_fix'), {
      pass: false, score: 0, reason: 'invalid_step (json)', label: null, format: 'json',
    });
  }
});

test('resolves loop-monitor candidates in each language using the same order as the prompt', () => {
  for (const language of ['ja', 'en']) {
    const vars = { language, workflow: 'development-remediation-dynamic', loop_monitor_index: 2 };
    const { candidates: monitorCandidates } = loadPhase3JudgmentRules(vars);
    const expectedLabel = language === 'ja' ? '要件を満たす実現可能な打開手段がない' : 'No feasible path can satisfy the requirements';
    const result = assertJudgment('{"step":4,"reason":"The same failure occurred four times."}', {
      vars: { ...vars, expected_label: expectedLabel },
    });
    assert.equal(result.pass, true);
    assert.equal(result.label, monitorCandidates[3].label);
  }
});

test('fails fast when the expectation is not a selectable rule label', () => {
  assert.throws(() => assertJudgment('{"step":1,"reason":"Approved."}', {
    vars: { language: 'ja', workflow: 'review-backend', step_name: 'coding-review', expected_label: 'typo' },
  }), /expected_label must name a selectable rule/);
});

test('rejects the final malformed or unclosed JSON instead of reusing an earlier valid decision', () => {
  const earlier = '{"step":1,"reason":"Earlier decision."}\n';
  for (const final of [
    '{"step":2,"reason":"Final",}',
    '{"step":2,"reason":"Final"',
    '{"step":2,"reason":"Final',
    '{broken: {"step":1,"reason":"Inner decision."}}',
    '{broken: {"step":1,"reason":"Inner decision."}',
  ]) {
    for (const output of [final, earlier + final]) {
      const result = scorePhase3Judgment(output, candidates, 'approved');
      assert.equal(result.pass, false);
      assert.equal(result.reason, 'invalid_json (json)');
      assert.equal(result.label, null);
    }
  }
});

const reviewVars = {
  language: 'ja', workflow: 'review-backend', step_name: 'coding-review', expected_label: 'approved',
};
const codexProvider = { id: () => 'openai:codex-sdk', config: { model: 'gpt-6-luna' } };
const claudeProvider = { id: () => 'cli-review:claude:claude-opus-5', config: { cli: 'claude' } };
const approved = '{"step":1,"reason":"Approved in the input."}';

function codexScore(output, raw) {
  return assertJudgment(output, { vars: reviewVars, provider: codexProvider, providerResponse: { raw } });
}

test('reads Claude JSON step, then rule only when step is absent, then production step tags', () => {
  const context = { vars: reviewVars, provider: claudeProvider };
  for (const [output, pass, reason] of [
    ['判定: ルール 1\n[CODING-REVIEW:1]', true, 'expected_rule (tag)'],
    ['[CODING-REVIEW:2] then [coding-review:1]', true, 'expected_rule (tag)'],
    ['[CODING-REVIEW:2]', false, 'wrong_rule (tag)'],
    ['[OTHER:1]', false, 'invalid_tag (tag)'],
    ['[CODING-REVIEW:99]', false, 'invalid_step (tag)'],
    ['{"step":2,}\n[CODING-REVIEW:1]', true, 'expected_rule (tag)'],
    ['{"step":2,"reason":"Incomplete"\n[CODING-REVIEW:1]', true, 'expected_rule (tag)'],
    ['{"step":2,"reason":"Needs fix."}\n[CODING-REVIEW:1]', false, 'wrong_rule (json.step)'],
    ['[CODING-REVIEW:2]\n{"step":1,"reason":"Approved."}', true, 'expected_rule (json.step)'],
    ['{"rule":1,"reason":"Approved."}', true, 'expected_rule (json.rule)'],
    ['{"rule":2,"reason":"Needs fix."}\n[CODING-REVIEW:1]', false, 'wrong_rule (json.rule)'],
    ['{"step":2,"rule":1,"reason":"Needs fix."}', false, 'wrong_rule (json.step)'],
    ['{"step":null,"rule":1,"reason":"Evidence."}', false, 'invalid_step (json.step)'],
    ['{"step":99,"rule":2}\n[CODING-REVIEW:1]', true, 'expected_rule (tag)'],
    ['{"rule":"1"}\n[CODING-REVIEW:1]', true, 'expected_rule (tag)'],
    ['{"metadata":true}\n[CODING-REVIEW:1]', true, 'expected_rule (tag)'],
    ['{"step":1}', true, 'expected_rule (json.step)'],
    ['{"rule":1}', true, 'expected_rule (json.rule)'],
    ['{"rule":99}', false, 'invalid_step (json.rule)'],
    ['{"step":1,}', false, 'invalid_json (json)'],
    ['{"step":1,"reason":"Earlier"}\n{"step":2,}', false, 'invalid_json (json)'],
  ]) {
    const result = assertJudgment(output, context);
    assert.equal(result.pass, pass);
    assert.equal(result.reason, reason);
    assert.deepEqual(Object.keys(result.namedScores), ['phase3-follow-input/rule']);
  }
  const result = assertJudgment('判定: ルール 1\n[FIX-VERIFIER:1]', {
    vars: { language: 'ja', workflow: 'development-remediation-dynamic', step_name: 'fix-verifier', expected_label: 'verified' },
    provider: claudeProvider,
  });
  assert.equal(result.pass, true);
  assert.equal(result.format, 'tag');
});

test('does not accept a tag as Codex structured output', () => {
  const result = codexScore('[CODING-REVIEW:1]', JSON.stringify({ items: [] }));
  assert.equal(result.pass, false);
  assert.match(result.reason, /invalid_json/);
  assert.equal(result.namedScores['phase3-follow-input/no-external-read'], 1);
});

test('keeps Codex restricted to step and never substitutes rule or tags for invalid JSON or steps', () => {
  for (const [output, reason] of [
    ['{"rule":1,"reason":"Evidence."}', 'invalid_step'],
    ['{"rule":1,"reason":"Evidence."}\n[CODING-REVIEW:1]', 'invalid_step'],
    ['{"step":99,"reason":"Evidence."}\n[CODING-REVIEW:1]', 'invalid_step'],
    ['{"step":1,}\n[CODING-REVIEW:1]', 'invalid_json'],
    ['{"step":1}\n[CODING-REVIEW:1]', 'invalid_json'],
  ]) {
    const result = codexScore(output, { items: [] });
    assert.equal(result.pass, false);
    assert.ok(result.reason.includes(`rule: ${reason} (json)`));
    assert.equal(result.namedScores['phase3-follow-input/rule'], 0);
    assert.equal(result.namedScores['phase3-follow-input/no-external-read'], 1);
  }
});

test('records rule correctness separately from tool use, even when the rule is correct or JSON is invalid', () => {
  for (const type of ['command_execution', 'file_change', 'mcp_tool_call', 'web_search']) {
    for (const output of [approved, '{"step":2,"reason":"Needs fix."}', '{"step":1,}']) {
      const result = codexScore(output, JSON.stringify({ items: [{ type, status: 'completed' }] }));
      assert.equal(result.pass, false);
      assert.equal(result.score, 0);
      assert.equal(result.namedScores['phase3-follow-input/rule'], output === approved ? 1 : 0);
      assert.equal(result.namedScores['phase3-follow-input/no-external-read'], 0);
      assert.match(result.reason, /rule:/);
      assert.ok(result.reason.includes(`input_boundary: tool_use (${type})`));
    }
  }
});

test('passes Codex only when both the rule and the input boundary pass, accepting raw JSON strings and objects', () => {
  const raw = { items: [{ type: 'reasoning', text: 'Input evidence.' }, { type: 'agent_message', text: approved }] };
  for (const response of [raw, JSON.stringify(raw)]) {
    const result = codexScore(approved, response);
    assert.equal(result.pass, true);
    assert.equal(result.score, 1);
    assert.deepEqual(result.namedScores, { 'phase3-follow-input/rule': 1, 'phase3-follow-input/no-external-read': 1 });
    assert.equal(result.reason, 'rule: expected_rule (json); input_boundary: no_external_read');
    const wrong = codexScore('{"step":2,"reason":"Needs fix."}', response);
    assert.equal(wrong.pass, false);
    assert.equal(wrong.namedScores['phase3-follow-input/no-external-read'], 1);
  }
});

test('fails the Codex input-boundary metric when the raw item record cannot be observed', () => {
  for (const raw of [undefined, null, '', '{', '{}', { items: null }, { items: [null] }]) {
    const result = codexScore(approved, raw);
    assert.equal(result.pass, false);
    assert.equal(result.namedScores['phase3-follow-input/rule'], 1);
    assert.equal(result.namedScores['phase3-follow-input/no-external-read'], 0);
    assert.match(result.reason, /invalid_raw_items/);
  }
});

test('omits the input-boundary metric for Claude even when raw data is present', () => {
  const result = assertJudgment(approved, {
    vars: reviewVars, provider: claudeProvider,
    providerResponse: { raw: JSON.stringify({ items: [{ type: 'command_execution' }] }) },
  });
  assert.equal(result.pass, true);
  assert.equal(result.format, 'json.step');
  assert.deepEqual(result.namedScores, { 'phase3-follow-input/rule': 1 });
});
