import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { expandFacetIncludes } from '#faceted-prompting/cli/facet-includes';
import { parse } from 'yaml';

import buildFixLoopConvergencePrompt from '../fix-loop-convergence-prompt.mjs';

test('fix-loop prompt orders scenario and monitor instruction', async () => {
  const prompt = await buildFixLoopConvergencePrompt({
    vars: { role: 'monitor', scenario: 'E07a' },
  });

  const scenario = readFileSync(new URL('../cases/fix-loop-convergence/E07a.md', import.meta.url), 'utf8');
  const facetsRoot = fileURLToPath(new URL('../../builtins/ja/facets/', import.meta.url));
  const instruction = expandFacetIncludes({
    body: readFileSync(new URL('../../builtins/ja/facets/instructions/loop-monitor-reviewers-fix.md', import.meta.url), 'utf8'),
    facetsRoots: [facetsRoot],
    repertoireDirs: [],
    allowedRoots: [facetsRoot],
  }).body;
  const scenarioIndex = prompt.indexOf(scenario);
  const instructionIndex = prompt.indexOf(instruction);

  assert.ok(scenarioIndex >= 0);
  assert.ok(scenarioIndex < instructionIndex);
});

test('fix-loop prompt resolves the selected builtin language without changing the default', async () => {
  const vars = { role: 'fix', scenario: 'external-cleanup-complete' };
  const defaultPrompt = await buildFixLoopConvergencePrompt({ vars });
  const jaPrompt = await buildFixLoopConvergencePrompt({ vars: { ...vars, language: 'ja' } });
  const enPrompt = await buildFixLoopConvergencePrompt({ vars: { ...vars, language: 'en' } });
  const enRoot = fileURLToPath(new URL('../../builtins/en/facets/', import.meta.url));
  const instruction = expandFacetIncludes({
    body: readFileSync(new URL('../../builtins/en/facets/instructions/apply-fix-plan.md', import.meta.url), 'utf8'),
    facetsRoots: [enRoot], repertoireDirs: [], allowedRoots: [enRoot],
  }).body;
  assert.equal(defaultPrompt, jaPrompt);
  assert.ok(enPrompt.includes(instruction));
  await assert.rejects(buildFixLoopConvergencePrompt({ vars: { ...vars, language: 'fr' } }), /Unknown language/);
});

test('external cleanup evaluation passes the generated report to phase 3 and checks its transition', async () => {
  const { evaluateReport } = await import('./external-cleanup-phase3.mjs');
  for (const language of ['ja', 'en']) {
    const report = `REPORT-${language}`;
    let prompt;
    const judge = async input => { prompt = input; return JSON.stringify({ step: 1, reason: 'done' }); };
    const result = await evaluateReport(report, { language, scenario: 'external-cleanup-complete' }, judge);
    assert.equal(result.pass, true);
    assert.match(result.reason, /fix-verifier/);
    assert.ok(prompt.includes(report));
    assert.ok(!prompt.includes('external-cleanup-complete'));
    const wrong = await evaluateReport(report, { language, scenario: 'external-cleanup-incomplete' }, judge);
    assert.equal(wrong.pass, false);
    const revised = await evaluateReport(report, { language, scenario: 'external-cleanup-incomplete' }, async () => JSON.stringify({ step: 2, reason: 'incomplete' }));
    assert.equal(revised.pass, true);
    assert.match(revised.reason, /fix-replan/);
    const invalid = await evaluateReport(report, { language, scenario: 'external-cleanup-complete' }, async () => 'null');
    assert.equal(invalid.pass, false);
  }
});

test('fix-verifier prompt includes the selected language instruction and three recorded reports', async () => {
  for (const language of ['ja', 'en']) {
    const scenario = `external-cleanup-repair-pending${language === 'en' ? '-en' : ''}`;
    const prompt = await buildFixLoopConvergencePrompt({ vars: { role: 'verifier', language, scenario } });
    const facetsRoot = fileURLToPath(new URL(`../../builtins/${language}/facets/`, import.meta.url));
    const instruction = expandFacetIncludes({
      body: readFileSync(new URL(`../../builtins/${language}/facets/instructions/verify-fix.md`, import.meta.url), 'utf8'),
      facetsRoots: [facetsRoot], repertoireDirs: [], allowedRoots: [facetsRoot],
    }).body;
    assert.ok(prompt.includes(instruction));
    assert.ok(prompt.includes(readFileSync(new URL(`../../builtins/${language}/facets/output-contracts/fix-verification.md`, import.meta.url), 'utf8')));
    assert.ok(prompt.includes('review-resolution.md'));
    assert.ok(prompt.indexOf('review-resolution.md') < prompt.indexOf(instruction));
    assert.ok(prompt.includes('fix-plan.md'));
    assert.ok(prompt.includes('fix-report.md'));
    assert.ok(prompt.includes('normalizeLimit'));
  }
});

test('fix-verifier report result and real Phase 3 routing distinguish completion, invalid plan and incomplete repair', async () => {
  const { evaluateReport } = await import('./external-cleanup-phase3.mjs');
  for (const language of ['ja', 'en']) {
    for (const [scenario, result, step, next] of [
      ['external-cleanup-complete', 'verified', 1, 'COMPLETE'],
      ['external-cleanup-incomplete', 'plan_invalid', 2, 'verification-replan'],
      ['external-cleanup-repair-pending', 'incomplete', 3, 'fix-retry'],
    ]) {
      const report = `## ${language === 'ja' ? '結果' : 'Result'}: ${result}\n\nF-1 evidence; external session remains.`;
      const vars = { role: 'verifier', language, scenario: `${scenario}${language === 'en' ? '-en' : ''}` };
      const accepted = await evaluateReport(report, vars, async prompt => {
        assert.ok(prompt.includes(report));
        return JSON.stringify({ step, reason: result });
      });
      assert.equal(accepted.pass, true, `${language}/${result}: ${accepted.reason}`);
      assert.match(accepted.reason, new RegExp(`next: ${next}`));
      const wrongReport = await evaluateReport(report.replace(result, 'verified'),
        { ...vars, scenario: `external-cleanup-repair-pending${language === 'en' ? '-en' : ''}` },
        async () => JSON.stringify({ step: 3, reason: 'incomplete' }));
      if (result !== 'verified') assert.equal(wrongReport.pass, false);
      const template = await evaluateReport(`## ${language === 'ja' ? '結果' : 'Result'}: verified / incomplete / plan_invalid`, vars,
        async () => JSON.stringify({ step, reason: result }));
      assert.equal(template.pass, false);
    }
  }
});

test('fix-verifier cases require a semantic report check as well as real Phase 3 routing', () => {
  const suite = parse(readFileSync(new URL('../scenarios/fix-loop-convergence/fix-loop-convergence.yaml', import.meta.url), 'utf8'));
  const cases = suite.tests.filter(({ vars }) => vars.role === 'verifier');
  assert.equal(cases.length, 6);
  for (const entry of cases) {
    assert.deepEqual(entry.assert.map(({ type }) => type), ['llm-rubric', 'javascript']);
    const rubric = entry.assert[0].value;
    assert.match(rubric, /normalizeLimit/);
    assert.match(rubric, /session/);
    assert.match(rubric, /(?:削除|delet)/i);
    assert.equal(entry.assert[1].value, 'file://../../asserts/external-cleanup-phase3.mjs');
  }
  assert.equal(suite.defaultTest.options.provider.config.model, 'gpt-6.1-sol');
});
