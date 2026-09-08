import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandFacetIncludes } from 'faceted-prompting/cli/facet-includes';
import assertEvidenceJudgment from './evidence-judgment.mjs';
import buildEvidenceJudgmentPrompt from '../evidence-judgment-prompt.mjs';

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

test('rejects unknown roles instead of selecting an unrelated policy', () => {
  for (const role of ['unknown', 'toString', undefined]) {
    assert.throws(() => buildEvidenceJudgmentPrompt({ vars: { role, task: 'Task' } }), /Unknown judgment role/);
  }
});

test('selects English facets explicitly and rejects unsupported languages', () => {
  const vars = { role: 'planner', task: 'Task' };
  const prompt = buildEvidenceJudgmentPrompt({ vars: { ...vars, language: 'en' } });
  assert.ok(prompt.includes('Evidence-Based Judgment'));
  assert.equal(prompt.includes('{{include:'), false);
  assert.throws(() => buildEvidenceJudgmentPrompt({ vars: { ...vars, language: '../ja' } }), /Unknown facet language/);
});
