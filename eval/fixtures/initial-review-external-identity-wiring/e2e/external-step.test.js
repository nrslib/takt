import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { executeStep } from '../src/execution-target.js';
import { previewStep } from '../src/preview-target.js';

async function readJson(relativePath) {
  return JSON.parse(await readFile(new URL(relativePath, import.meta.url), 'utf8'));
}

test('routes sample-flow execute to the configured external runner', async () => {
  const workflow = await readJson('../workflows/sample-flow.json');
  const config = await readJson('../config/runtime.json');
  const step = workflow.steps[0];

  assert.deepEqual(executeStep(workflow, step, config), {
    target: 'external-runner',
    terminal: 'external-runner:sample-flow/execute',
  });
  assert.equal(previewStep(workflow, step, config), 'sample-flow/execute -> external-runner');
});
