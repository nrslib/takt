import assert from 'node:assert/strict';
import test from 'node:test';

import buildFixLoopConvergencePrompt from '../fix-loop-convergence-prompt.mjs';

test('fix-loop prompt orders scenario and monitor instruction', async () => {
  const prompt = await buildFixLoopConvergencePrompt({
    vars: { role: 'monitor', scenario: 'E07a' },
  });

  const scenarioIndex = prompt.indexOf('### fix-plan.md（抜粋）');
  const instructionIndex = prompt.indexOf('--- INSTRUCTION（全文） ---');

  assert.ok(scenarioIndex >= 0);
  assert.ok(scenarioIndex < instructionIndex);
  assert.equal(prompt.includes('--- OUTPUT CONTRACT（全文） ---'), false);
});
