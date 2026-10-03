import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { evaluate } from 'promptfoo';
import { digest } from '../providers/report-phase-handoff-model.mjs';
import { assertNeutralTarget, assertToolFreeGrader, ExecutionAuditError, gradingReference, inspectPhase1Receipts, parseReceiptCommand, scoreExecutionBoundaryV3 } from '../providers/report-phase-handoff-audit-v3.mjs';
import { buildGraderPrompt, captureV3, frozenSamples, resetWorkspace, validateV3Cases } from '../scripts/report-phase-handoff-v3.mjs';

const cases = JSON.parse(readFileSync(new URL('../cases/report-phase-handoff-v3.json', import.meta.url)));
const fresh = { startedFresh: true, toolCount: 0 };
const neutral = '/private/tmp/report-handoff-contract';
const fixture = 'eval/fixtures/report-phase-handoff';
const source = readFileSync(join(fixture, 'src/session-label.js'), 'utf8');
const tests = readFileSync(join(fixture, 'tests/session-label.test.js'), 'utf8');
const { NODE_TEST_CONTEXT: _context, ...environment } = process.env;
const buildOutput = execFileSync('npm', ['run', 'build'], { cwd: fixture, env: environment, encoding: 'utf8' });
const testOutput = execFileSync('npm', ['test'], { cwd: fixture, env: environment, encoding: 'utf8' });
const receipt = (command, output, exitCode = 0) => ({ command, output, exitCode, status: 'completed' });
const commands = [receipt("/bin/zsh -lc 'cat src/session-label.js tests/session-label.test.js'", source + tests),
  receipt("/bin/zsh -lc 'npm run build'", buildOutput), receipt("/bin/zsh -lc 'npm test'", testOutput)];

function withWorkspace(run) {
  const directory = mkdtempSync('/private/tmp/handoff-contract-');
  const workspace = join(directory, 'project');
  resetWorkspace(workspace);
  try { return run(workspace, directory); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

test('v3 fixes same neutral cwd per paired sample with distinct repeat workspaces', () => {
  assert.equal(validateV3Cases(cases), cases);
  const samples = frozenSamples(cases, neutral);
  assert.equal(samples.length, 18);
  assert.equal(new Set(samples.map(row => row.workspace)).size, 18);
  assert.deepEqual(frozenSamples(cases, neutral), samples);
  assert.throws(() => validateV3Cases({ ...cases, maxConcurrency: 1 }));
  assert.throws(() => assertNeutralTarget('/private/tmp/x/before/fixture', neutral));
  assert.throws(() => assertNeutralTarget('/private/tmp/x/candidate/fixture', neutral));
  assert.throws(() => assertNeutralTarget('24b6990a4767602e8ec52fce7e1f6e56d0e4982a', neutral));
  assert.throws(() => assertNeutralTarget('', '/Users/nrs/work/git/takt/fixture'));
});

test('actual shell receipts recognize ordinary SDK zsh, cat, sed and build/test chaining', () => withWorkspace(workspace => {
  assert.deepEqual(parseReceiptCommand('/bin/zsh -lc "npm run build && npm test"'), [
    { words: ['npm', 'run', 'build'], following: '&&' }, { words: ['npm', 'test'], following: null }]);
  assert.equal(scoreExecutionBoundaryV3(cases.cases[2], fresh, { startedFresh: true, commands }, workspace).pass, true);
  const chained = [receipt("/bin/zsh -lc 'sed -n 1,50p src/session-label.js; sed -n 1,50p tests/session-label.test.js'", source + tests),
    receipt('/bin/zsh -lc "npm run build && npm test"', buildOutput + testOutput)];
  assert.equal(scoreExecutionBoundaryV3(cases.cases[2], fresh, { startedFresh: true, commands: chained }, workspace).pass, true);
}));

test('echo command spelling and rg filenames cannot establish execution or file-body inspection', () => withWorkspace(workspace => {
  const echoes = [receipt('echo "npm run build"', buildOutput), receipt('echo "npm test"', testOutput),
    receipt('rg --files src tests', 'src/session-label.js\ntests/session-label.test.js')];
  assert.equal(scoreExecutionBoundaryV3(cases.cases[2], fresh, { startedFresh: true, commands: echoes }, workspace).pass, false);
  const pathsOnly = commands.map(row => row.command.includes('cat') ? receipt(row.command, 'src/session-label.js tests/session-label.test.js') : row);
  assert.equal(scoreExecutionBoundaryV3(cases.cases[2], fresh, { startedFresh: true, commands: pathsOnly }, workspace).pass, false);
}));

test('observations must come from successful actual fixture npm test receipt', () => withWorkspace(workspace => {
  const elsewhere = commands.map(row => row.command.includes('npm test') ? receipt(row.command, '> test\n> node --test tests/session-label.test.js\npass 2\nfail 0') : row);
  elsewhere.push(receipt('echo observations', testOutput));
  assert.equal(scoreExecutionBoundaryV3(cases.cases[2], fresh, { startedFresh: true, commands: elsewhere }, workspace).pass, false);
  const failed = commands.map(row => row.command.includes('npm test') ? { ...row, exitCode: 1 } : row);
  assert.equal(scoreExecutionBoundaryV3(cases.cases[2], fresh, { startedFresh: true, commands: failed }, workspace).pass, false);
  const wrongObservation = commands.map(row => row.command.includes('npm test') ? { ...row, output: row.output.replace('"actual":"Ready Now"', '"actual":"WRONG"') } : row);
  assert.equal(scoreExecutionBoundaryV3(cases.cases[2], fresh, { startedFresh: true, commands: wrongObservation }, workspace).pass, false);
}));

test('unsupported actual npm compositions are audit errors, not model failure results', () => withWorkspace(workspace => {
  for (const command of ['env npm test', `npm --prefix ${workspace} test`, 'npm test; echo passed', 'npm test | cat']) {
    assert.throws(() => inspectPhase1Receipts({ commands: [receipt(command, testOutput)] }, workspace), ExecutionAuditError);
  }
}));

test('grader tool use cannot pass and target Phase 2 tool use fails boundary', () => {
  assertToolFreeGrader(fresh);
  assert.throws(() => assertToolFreeGrader({ ...fresh, toolCount: 1 }), ExecutionAuditError);
  assert.throws(() => assertToolFreeGrader({ ...fresh, startedFresh: false }), ExecutionAuditError);
  assert.equal(scoreExecutionBoundaryV3(cases.cases[0], { ...fresh, toolCount: 1 }).pass, false);
});

test('B grader receives actual obligation text with precise real row/line sources', () => {
  const sample = cases.cases[1];
  const reference = gradingReference(sample, { liveInstructions: [] });
  assert.equal(reference.actualPlanningReport.content, sample.reportContent);
  assert.match(reference.actualPlanningReport.contentWithLines, /3: 1\. Preserve the existing version/);
  assert.match(reference.actualPlanningReport.contentWithLines, /4: 2\. Confirm a delivery record/);
  assert.match(reference.actualPlanningReport.contentWithLines, /5: 3\. Confirm that the existing timestamp/);
  assert.equal(reference.actualPhase1FinalResponse, sample.workResult);
  assert.match(sample.rubrics['unknown-implementation'], /unknown or unconfirmed/);
});

test('C grader reference keeps actual final response separate from receipts and fixture', () => {
  const sample = cases.cases[2];
  const reference = gradingReference(sample, { liveInstructions: [] }, { output: 'No implementation line retained', verifiedReceipts: commands }, [{ path: 'src/session-label.js', contentWithLines: '1: function' }]);
  assert.equal(reference.actualPhase1FinalResponse, 'No implementation line retained');
  assert.equal(reference.executedCommandReceipts, commands);
  assert.match(reference.boundary, /Do not fill missing Phase 1 or Phase 2 evidence/);
  assert.match(sample.rubrics['observed-evidence'], /Phase 2 inventing evidence to repair a Phase 1 omission fails/);
});

test('promptfoo real grading boundary receives exact output, frozen rubric and actual B source context', async () => {
  const sample = cases.cases[1];
  const output = '# Report with deliberately wrong obligation';
  const reference = gradingReference(sample, { liveInstructions: [] });
  const observation = { caseId: sample.id, phase2: { responseHash: digest(output) }, reference };
  let called = 0;
  const grader = { id: () => 'v3-deterministic-grader', callApi: async (prompt, context) => {
    const composed = buildGraderPrompt(prompt, context, observation, cases);
    assert.ok(composed.includes(sample.reportContent.replaceAll('\n', '\\n')));
    assert.ok(composed.includes(sample.rubrics['idless-source']));
    assert.equal(context.vars.output, output);
    called++;
    return { output: '{"pass": false, "score": 0, "reason": "Wrong obligation meaning"}' };
  } };
  const result = await evaluate({ prompts: ['{{sampleId}}'], providers: [{ id: () => 'v3-deterministic-target', callApi: async () => ({ output }) }],
    tests: [{ vars: { sampleId: 'en-rule-source-status-r1' }, assert: [{ type: 'llm-rubric', value: sample.rubrics['idless-source'] }] }],
    defaultTest: { options: { provider: grader } }, writeLatestResults: false,
  }, { cache: false, maxConcurrency: 3, showProgressBar: false, writeLatestResults: false });
  assert.equal(called, 1);
  assert.equal(result.results[0].success, false);
  assert.throws(() => buildGraderPrompt('', { vars: { output: '# Other response', rubric: sample.rubrics['idless-source'] } }, observation, cases));
});

test('actual AgentRunner wrapper and live dispatch are captured without grader reference in target', () => withWorkspace((workspace, directory) => {
  for (const sample of cases.cases.slice(0, 2)) {
    resetWorkspace(workspace);
    const captured = captureV3({ revisionRoot: process.cwd(), workspace, sample, language: 'en',
      configDirectory: join(directory, 'config'), directory: join(directory, sample.id) });
    assert.equal(existsSync(join(workspace, '.takt/runs/eval/reports/implementation-report.md')), false);
    if (sample.liveInput) {
      resetWorkspace(workspace);
      const repeated = captureV3({ revisionRoot: process.cwd(), workspace, sample, language: 'en',
        configDirectory: join(directory, 'config'), directory: join(directory, 'repeat') });
      assert.equal(repeated.phase1Prompt, captured.phase1Prompt);
      assert.equal(repeated.phase2Prompt, captured.phase2Prompt);
    }
    assert.deepEqual(captured.phase2Options, { allowedTools: [], sessionIdPresent: false });
    for (const [index, prompt] of [captured.phase1Prompt, captured.phase2Prompt].entries()) {
      const parts = captured.phaseParts[index];
      assert.equal(prompt, parts.systemPrompt + '\n\n' + parts.userInstruction);
      assert.match(parts.systemPrompt, /report-phase-handoff/);
      assert.match(parts.systemPrompt, /implement/);
      assert.ok(!prompt.includes(cases.gradingBoundary));
    }
    if (sample.liveInput) {
      assert.equal(captured.liveInstructions[0].content, sample.liveInput);
      assert.equal(captured.liveInstructions[0].state, 'deliveredNextStep');
      assert.ok(captured.phase2Prompt.includes(sample.liveInput));
    } else {
      assert.ok(captured.phase2Prompt.includes(sample.reportName));
      for (const line of sample.reportContent.split('\n').filter(line => /^\d\./.test(line))) assert.ok(captured.phase2Prompt.includes(line));
    }
  }
}));
