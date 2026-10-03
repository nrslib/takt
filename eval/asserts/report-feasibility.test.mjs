import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildGraderPrompt, captureV3, frozenSamples } from '../scripts/report-phase-handoff-v3.mjs';
import { confirmFeasibilityBaseline, observeFeasibilityFixture, prepareFeasibilityWorkspace, validateFeasibilityCases } from '../scripts/report-feasibility.mjs';
import { digest } from '../providers/report-phase-handoff-model.mjs';
import { gradingReference } from '../providers/report-phase-handoff-audit-v3.mjs';

const cases = JSON.parse(readFileSync(new URL('../cases/report-feasibility.json', import.meta.url)));

test('follow-up freezes six independent bilingual samples with distinct paired neutral cwd', () => {
  validateFeasibilityCases(cases);
  const samples = frozenSamples(cases, '/private/tmp/feasibility-contract');
  assert.equal(samples.length, 6);
  assert.equal(new Set(samples.map(row => row.workspace)).size, 6);
  assert.deepEqual(samples, frozenSamples(cases, '/private/tmp/feasibility-contract'));
  assert.throws(() => validateFeasibilityCases({ ...cases, repeats: 1 }));
});

test('baseline confirmation distinguishes genuine failure from all-pass before explicit candidate authorization', () => {
  const directory = mkdtempSync('/private/tmp/feasibility-confirmation-');
  mkdirSync(join(directory, 'red'));
  try {
    for (const modelFailures of [0, 1]) {
      const bytes = JSON.stringify({ passed: 6 - modelFailures, modelFailures, infrastructureFailures: 0, rows: Array(6).fill({}) });
      writeFileSync(join(directory, 'red/summary.json'), bytes);
      const confirmation = { summaryHash: digest(bytes), baselineOutcome: modelFailures ? 'semantic-failure-observed' : 'all-targets-passed', candidateCaptureAuthorizedByRoot: true };
      writeFileSync(join(directory, 'baseline-confirmed.json'), JSON.stringify(confirmation));
      confirmFeasibilityBaseline(directory);
      writeFileSync(join(directory, 'baseline-confirmed.json'), JSON.stringify({ ...confirmation, candidateCaptureAuthorizedByRoot: false }));
      assert.throws(() => confirmFeasibilityBaseline(directory));
      writeFileSync(join(directory, 'baseline-confirmed.json'), JSON.stringify({ ...confirmation, baselineOutcome: modelFailures ? 'all-targets-passed' : 'semantic-failure-observed' }));
      assert.throws(() => confirmFeasibilityBaseline(directory));
      writeFileSync(join(directory, 'baseline-confirmed.json'), JSON.stringify({ ...confirmation, summaryHash: 'wrong' }));
      assert.throws(() => confirmFeasibilityBaseline(directory));
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('real evaluator observations establish local build success, actual test failure and pre-request credential stop', () => {
  const directory = mkdtempSync('/private/tmp/feasibility-receipts-');
  const workspace = join(directory, 'project');
  try {
    prepareFeasibilityWorkspace(workspace);
    const receipts = observeFeasibilityFixture(workspace);
    assert.deepEqual(receipts.map(row => [row.command, row.exitCode]), [['npm run build', 0], ['npm test', 1], ['node scripts/tenant-probe.js', 2]]);
    assert.match(receipts[1].stdout, /actual.*Ready Now|Ready Now/s);
    assert.match(receipts[2].stderr, /no request attempted/);
    assert.match(readFileSync(join(workspace, 'src/session-label.js'), 'utf8'), /return label;/);
    assert.match(readFileSync('eval/fixtures/report-phase-handoff/src/session-label.js', 'utf8'), /return label.trim\(\);/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('grader-only reference has the concrete authorization, excluded prerequisites and timestamp uncertainty', () => {
  const sample = cases.cases[0];
  const reference = gradingReference(sample, { liveInstructions: [] });
  const output = 'Local repair is impossible because Phase 2 cannot edit; timestamp is possible.';
  const observation = { caseId: sample.id, reference, phase2: { responseHash: digest(output) } };
  for (const rubric of Object.values(sample.rubrics)) {
    const prompt = buildGraderPrompt('Grade the actual report\n' + rubric, { vars: { output, rubric } }, observation, cases);
    assert.match(prompt, /Current implementation\/reimplementation work permits source and test edits/);
    assert.match(prompt, /current plan excludes obtaining credentials/);
    assert.match(prompt, /No target implementation, command, environment/);
    assert.ok(prompt.includes(rubric));
  }
});

test('actual AgentRunner captures fresh tool-free P2 with all three data obligations, without target rubric', () => {
  const directory = mkdtempSync('/private/tmp/feasibility-capture-');
  const workspace = join(directory, 'project');
  try {
    prepareFeasibilityWorkspace(workspace);
    const captured = captureV3({ revisionRoot: process.cwd(), workspace, sample: cases.cases[0], language: 'en',
      configDirectory: join(directory, 'config'), directory: join(directory, 'captured') });
    assert.deepEqual(captured.phase2Options, { allowedTools: [], sessionIdPresent: false });
    assert.equal(captured.phase2Prompt, captured.phaseParts[1].systemPrompt + '\n\n' + captured.phaseParts[1].userInstruction);
    for (const id of ['LOCAL-01', 'ENDPOINT-02', 'TIMESTAMP-03']) assert.ok(captured.phase2Prompt.includes(id));
    for (const rubric of Object.values(cases.cases[0].rubrics)) assert.ok(!captured.phase2Prompt.includes(rubric));
    assert.ok(!captured.phase2Prompt.includes(cases.gradingBoundary));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
