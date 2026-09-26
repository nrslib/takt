import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { expandFacetIncludes } from 'faceted-prompting/cli/facet-includes';

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
