import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { auditSessionEvents, scoreExecutionBoundary } from '../providers/report-phase-handoff-model.mjs';
import { captureRuntime, classifyResult, fixtureFiles, validateCases } from '../scripts/report-phase-handoff-eval.mjs';

const cases = JSON.parse(readFileSync(new URL('../cases/report-phase-handoff.json', import.meta.url), 'utf8'));
const freshNoTools = { startedFresh: true, toolCount: 0 };
const chainReceipts = {
  startedFresh: true,
  commands: [
    { command: 'cat src/session-label.js tests/session-label.test.js', exitCode: 0, output: 'return label.trim();' },
    { command: 'npm run build', exitCode: 0, output: 'checked' },
    { command: 'npm test', exitCode: 0, output: 'observed Ready Now and Ready  Now; 2 tests passed' },
  ],
};

test('case protocol fixes bilingual repeats and actual verification control', () => {
  assert.equal(validateCases(cases), cases);
  assert.throws(() => validateCases({ ...cases, repeats: 1 }));
  assert.throws(() => validateCases({ ...cases, cases: [cases.cases[0], cases.cases[0], cases.cases[2]] }));
  assert.equal(cases.cases.filter(sample => sample.kind === 'live-phase1-chain').length, 1);
});

test('completed fixture independently produces passing commands and both observations', () => {
  const fixture = resolve('eval/fixtures/report-phase-handoff');
  const { NODE_TEST_CONTEXT: _testContext, ...environment } = process.env;
  execFileSync('npm', ['run', 'build'], { cwd: fixture, env: environment, encoding: 'utf8' });
  const output = execFileSync('npm', ['test'], { cwd: fixture, env: environment, encoding: 'utf8' });
  assert.match(output, /Ready Now/);
  assert.match(output, /Ready  Now/);
  assert.match(output, /pass 2/);
  assert.match(output, /fail 0/);
  assert.equal(fixtureFiles().length, 3);
});

test('provider errors, grader errors and empty output cannot be semantic RED', () => {
  assert.equal(classifyResult({ response: { error: 'provider unavailable' } }).status, 'infrastructure_failure');
  assert.equal(classifyResult({ response: { output: '' }, success: false }).status, 'infrastructure_failure');
  assert.equal(classifyResult({ response: { output: 'report' }, gradingResult: { componentResults: [{ metadata: { graderError: true } }] } }).status, 'infrastructure_failure');
  assert.equal(classifyResult({ response: { output: 'valid but semantically wrong report' }, success: false, gradingResult: { reason: 'revived withdrawn obligation' } }).status, 'model_failure');
  assert.equal(classifyResult({ response: { output: 'correct report' }, success: true }).status, 'pass');
});

test('actual turn context must match model, effort, sandbox and approval', () => {
  const context = { model: 'gpt-6-sol', effort: 'high', sandbox_policy: { type: 'read-only' }, approval_policy: 'never' };
  assert.equal(auditSessionEvents([{ type: 'turn_context', payload: context }], { model: 'gpt-6-sol', effort: 'high' }).observedTurnContexts, 1);
  assert.throws(() => auditSessionEvents([], { model: 'gpt-6-sol', effort: 'high' }));
  assert.throws(() => auditSessionEvents([{ type: 'turn_context', payload: { ...context, effort: 'low' } }], { model: 'gpt-6-sol', effort: 'high' }));
  assert.throws(() => auditSessionEvents([{ type: 'turn_context', payload: { ...context, sandbox_policy: { type: 'workspace-write' } } }], { model: 'gpt-6-sol', effort: 'high' }));
});

test('fresh Phase 2 using any tool fails even if its report is correct', () => {
  const sample = cases.cases[0];
  assert.equal(scoreExecutionBoundary(sample, freshNoTools).pass, true);
  assert.equal(scoreExecutionBoundary(sample, { ...freshNoTools, toolCount: 1 }).pass, false);
  assert.equal(scoreExecutionBoundary(sample, { ...freshNoTools, startedFresh: false }).pass, false);
});

test('live chain needs successful actual commands, inspection and observations', () => {
  const sample = cases.cases[2];
  assert.equal(scoreExecutionBoundary(sample, freshNoTools, chainReceipts).pass, true);
  assert.equal(scoreExecutionBoundary(sample, freshNoTools).pass, false);
  assert.equal(scoreExecutionBoundary(sample, freshNoTools, { ...chainReceipts, commands: chainReceipts.commands.filter(receipt => receipt.command !== 'npm test') }).pass, false);
  assert.equal(scoreExecutionBoundary(sample, freshNoTools, { ...chainReceipts, commands: chainReceipts.commands.map(receipt => ({ ...receipt, exitCode: 1 })) }).pass, false);
});

test('production implementation dispatch keeps live and rule report inputs in fresh Phase 2', () => {
  const directory = mkdtempSync(join(tmpdir(), 'report-handoff-contract-'));
  try {
    for (const sample of cases.cases.slice(0, 2)) {
      const workspace = join(directory, sample.id, 'project');
      cpSync('eval/fixtures/report-phase-handoff', workspace, { recursive: true });
      const captured = captureRuntime({
        revisionRoot: process.cwd(), workspace, sample, language: 'en',
        configDirectory: join(directory, sample.id, 'config'), directory: join(directory, sample.id, 'capture'),
      });
      assert.deepEqual(captured.phase2Options, { allowedTools: [], sessionIdPresent: false });
      if (sample.liveInput) {
        assert.ok(captured.phase1Prompt.includes(sample.liveInput));
        assert.ok(captured.phase2Prompt.includes(sample.liveInput));
        assert.equal(captured.liveInstructions[0].state, 'deliveredNextStep');
      } else {
        assert.ok(captured.phase1Prompt.includes(sample.reportContent));
        assert.ok(captured.phase2Prompt.includes('delivery-obligations.md'));
        assert.ok(captured.phase2Prompt.includes('Preserve the existing version field'));
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
