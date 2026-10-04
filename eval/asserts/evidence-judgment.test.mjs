import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandFacetIncludes } from 'faceted-prompting/cli/facet-includes';
import assertEvidenceJudgment from './evidence-judgment.mjs';
import buildEvidenceJudgmentPrompt from '../evidence-judgment-prompt.mjs';
import { assertBuiltinFacetIncluded } from './builtin-facet-assembly.mjs';

test('expands every shipped policy in both languages without missing or cyclic includes', () => {
  for (const language of ['ja', 'en']) {
    const root = join(dirname(fileURLToPath(import.meta.url)), '../../builtins', language, 'facets');
    const policies = readdirSync(join(root, 'policies')).filter(name => name.endsWith('.md'));
    assert.ok(policies.length > 0);
    for (const name of policies) {
      const expanded = expandFacetIncludes({
        body: readFileSync(join(root, 'policies', name), 'utf8'),
        facetsRoots: [root],
        repertoireDirs: [],
        allowedRoots: [root],
      }).body;
      assert.equal(expanded.includes('{{include:'), false, `${language}/${name}`);
    }
  }
});

test('accepts one decision and rejects alternatives, duplicates, and multiline labels', () => {
  for (const decision of ['retain', 'repair', 'verify', 'investigate']) {
    const context = { vars: { expected_decision: decision } };
    assert.equal(assertEvidenceJudgment(`Reason\nDECISION: ${decision}`, context).pass, true);
    for (const output of [`DECISION: ${decision}\nDECISION: ${decision}`, `DECISION:\n${decision}`, 'DECISION: retain / repair / verify / investigate']) {
      assert.equal(assertEvidenceJudgment(output, context).pass, false);
    }
  }
  assert.equal(assertEvidenceJudgment('DECISION: repair', { vars: { expected_decision: 'retain' } }).pass, false);
});

test('assembles each role with resolved includes without leaking the expected answer', () => {
  for (const role of ['planner', 'implementer', 'adjudicator', 'companion']) {
    const prompt = buildEvidenceJudgmentPrompt({ vars: { role, task: 'task-sentinel', expected_decision: 'answer-sentinel' } });
    assert.ok(prompt.includes('task-sentinel'));
    assert.equal(prompt.includes('answer-sentinel'), false);
    assert.equal(prompt.includes('{{include:'), false);
  }
});

test('rejects absent output and absent expected decisions with a failed grading result', () => {
  for (const [output, vars] of [
    ['', { expected_decision: 'retain' }],
    ['DECISION: retain', {}],
  ]) {
    const result = assertEvidenceJudgment(output, { vars });
    assert.equal(result.pass, false);
    assert.equal(result.score, 0);
    assert.equal(typeof result.reason, 'string');
    assert.ok(result.reason.length > 0);
  }
});

test('rejects unknown roles instead of selecting an unrelated policy', () => {
  for (const role of ['unknown', 'toString', undefined]) {
    assert.throws(() => buildEvidenceJudgmentPrompt({ vars: { role, task: 'Task' } }), /Unknown judgment role/);
  }
});

test('selects each builtin language through facet expansion and preserves the default', () => {
  const vars = { role: 'planner', task: 'Task' };
  for (const language of ['ja', 'en']) {
    const prompt = buildEvidenceJudgmentPrompt({ vars: { ...vars, language } });
    assertBuiltinFacetIncluded(prompt, language, 'policies/contract-change.md');
    assert.equal(prompt.includes('{{include:'), false);
  }
  assert.equal(buildEvidenceJudgmentPrompt({ vars }), buildEvidenceJudgmentPrompt({ vars: { ...vars, language: 'ja' } }));
});

test('rejects unsupported facet languages', () => {
  const vars = { role: 'planner', task: 'Task' };
  assert.throws(() => buildEvidenceJudgmentPrompt({ vars: { ...vars, language: '../ja' } }), /Unknown facet language/);
});
