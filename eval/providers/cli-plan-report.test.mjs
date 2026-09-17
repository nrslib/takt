import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parse } from 'yaml';
import CliPlanReportProvider from './cli-plan-report.mjs';

const suite = parse(readFileSync(new URL('../agents/fix-plan/fix-plan-blocker-absorption.yaml', import.meta.url), 'utf8'));

for (const outputPhase of ['phase1', 'phase2']) {
  test(`${outputPhase} scores only the requested phase and preserves the actual analysis`, async () => {
    const prompts = [];
    let sessions = 0;
    let cleaned = false;
    const analysis = 'actual analysis {{previous_response}}';
    const provider = new CliPlanReportProvider({ config: suite.providers[0].config }, {
      prepareWorkingDirectory: () => ({
        sourceDirectory: '/source/project',
        cwd: '/isolated/project',
        cleanup: () => { cleaned = true; },
      }),
      createCliReviewSession: () => {
        sessions += 1;
        return {
          run: async (prompt) => {
            prompts.push(prompt);
            return prompts.length === 1 ? analysis : 'final report';
          },
        };
      },
      readPrompt: () => '/source/project {{task}} {{previous_response}}',
    });
    const result = await provider.callApi('/source/project phase1 prompt', {
      vars: { task: 'task', previous_response: 'seeded old plan', output_phase: outputPhase },
    });
    assert.equal(sessions, 1);
    assert.equal(cleaned, true);
    assert.deepEqual(prompts, outputPhase === 'phase1'
      ? ['/isolated/project phase1 prompt']
      : ['/isolated/project phase1 prompt', `/isolated/project task ${analysis}`]);
    assert.deepEqual(result, outputPhase === 'phase1'
      ? { output: analysis }
      : { output: 'final report', metadata: { phase1_response: analysis } });
  });
}

for (const failingTurn of [1, 2]) {
  test(`reports phase${failingTurn} failure without scoring a partial response`, async () => {
    let calls = 0;
    let cleaned = false;
    const provider = new CliPlanReportProvider({ config: suite.providers[0].config }, {
      prepareWorkingDirectory: () => ({
        sourceDirectory: '/project',
        cwd: '/project',
        cleanup: () => { cleaned = true; },
      }),
      createCliReviewSession: () => ({
        run: async () => {
          calls += 1;
          if (calls === failingTurn) throw new Error('provider unavailable');
          return 'analysis';
        },
      }),
      readPrompt: () => '{{previous_response}}',
    });
    const result = await provider.callApi('phase1', { vars: { task: 'task', output_phase: 'phase2' } });
    assert.match(result.error, new RegExp(`phase${failingTurn} failed: provider unavailable`));
    assert.equal(result.output, undefined);
    assert.equal(calls, failingTurn);
    assert.equal(cleaned, true);
  });
}

test('suite prepares both phases and wires one report case for every provider', async () => {
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
  execFileSync(process.execPath, ['eval/scripts/prepare.mjs', 'fix-plan-blocker-absorption'], { cwd: repoRoot });
  assert.deepEqual(suite.tests.map(({ vars }) => vars.output_phase), ['phase1', 'phase2']);
  for (const entry of suite.providers) {
    const providerModule = new URL(entry.id.replace('file://../../', './'), new URL('../', import.meta.url));
    assert.equal((await import(providerModule.href)).default, CliPlanReportProvider);
    assert.equal(entry.config.isolate_working_dir, true);
    const reportPrompt = readFileSync(new URL(`../${entry.config.report_prompt}`, import.meta.url), 'utf8');
    assert.match(reportPrompt, /{{task}}/);
    assert.match(reportPrompt, /{{previous_response}}/);
    assert.match(reportPrompt, /Report File: .*\/fix-plan\.md/);
    const contract = readFileSync(new URL('../../builtins/ja/facets/partials/output-contracts/base-fix-plan.md', import.meta.url), 'utf8').trim();
    assert.ok(reportPrompt.includes(contract));
  }
});
