import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { expandFacetIncludes } from '#faceted-prompting/cli/facet-includes';

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
