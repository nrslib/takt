#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { digest } from '../providers/report-phase-handoff-model.mjs';
import { assertNeutralTarget } from '../providers/report-phase-handoff-audit-v3.mjs';
import { assertExecutionDependencies, captureExecutionDependencies, DependencyAuditError } from '../providers/report-phase-handoff-dependencies-v3.mjs';
import { buildRevision, captureV3, evaluateV3, frozenSamples } from './report-phase-handoff-v3.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fixture = join(root, 'eval/fixtures/report-feasibility');
const casePath = join(root, 'eval/cases/report-feasibility.json');
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const fixturePaths = ['package.json', 'src/session-label.js', 'tests/session-label.test.js', 'scripts/tenant-probe.js'];
const harnessPaths = ['scripts/report-feasibility.mjs', 'scripts/report-phase-handoff-v3.mjs',
  'scripts/report-phase-handoff-runtime-v3.mjs', 'providers/report-phase-handoff-model.mjs',
  'providers/report-phase-handoff-audit-v3.mjs', 'providers/report-phase-handoff-dependencies-v3.mjs',
  'scripts/report-phase-handoff-eval.mjs'];
const files = directory => fixturePaths.map(path => ({ path, sha256: digest(readFileSync(join(directory, path))) }));
const hashWorkspace = directory => digest(JSON.stringify(files(directory)));
const harnessHashes = () => harnessPaths.map(path => ({ path, sha256: digest(readFileSync(join(root, 'eval', path))) }));

export function validateFeasibilityCases(cases) {
  assert.equal(cases.schemaVersion, 4);
  assert.equal(cases.repeats, 3);
  assert.equal(cases.maxConcurrency, 3);
  assert.deepEqual(cases.languages, ['ja', 'en']);
  assert.deepEqual(cases.target, { model: 'gpt-6-sol', effort: 'high' });
  assert.deepEqual(cases.grader, cases.target);
  assert.equal(cases.cases.length, 1);
  assert.equal(cases.cases[0].kind, 'isolated-handoff');
  assert.deepEqual(Object.keys(cases.cases[0].rubrics), ['implementation-stage-feasibility', 'unknown-feasibility']);
  return cases;
}

export function prepareFeasibilityWorkspace(workspace) {
  assertNeutralTarget('', workspace);
  rmSync(workspace, { recursive: true, force: true });
  cpSync(fixture, workspace, { recursive: true });
  assert.equal(hashWorkspace(workspace), hashWorkspace(fixture));
}

export function observeFeasibilityFixture(workspace) {
  const { NODE_TEST_CONTEXT: _context, TAKT_FEASIBILITY_TENANT_CREDENTIAL: _credential, ...environment } = process.env;
  const observations = [['npm', ['run', 'build'], 0], ['npm', ['test'], 1], [process.execPath, ['scripts/tenant-probe.js'], 2]].map(([executable, args, expectedExit]) => {
    const result = spawnSync(executable, args, { cwd: workspace, env: environment, encoding: 'utf8' });
    assert.equal(result.status, expectedExit, result.stderr);
    return { command: `${executable === process.execPath ? 'node' : executable} ${args.join(' ')}`, exitCode: result.status,
      stdout: result.stdout, stderr: result.stderr, origin: 'Actual local fixture execution by evaluator; not a model Phase 1 receipt' };
  });
  assert.match(observations[1].stdout, /Ready Now/);
  assert.match(observations[1].stdout, /fail 1/);
  assert.match(observations[2].stderr, /MISSING_TENANT_CREDENTIAL: no request attempted/);
  return observations;
}

export function auditFeasibilityFreeze(directory) {
  const manifest = readJson(join(directory, 'manifest.json'));
  assert.equal(manifest.protocol, 4);
  assert.deepEqual(harnessHashes(), manifest.harnessHashes);
  assert.equal(digest(readFileSync(casePath)), manifest.caseSourceHash);
  const bytes = readFileSync(join(directory, 'cases.frozen.json'));
  assert.equal(digest(bytes), manifest.casesHash);
  const cases = validateFeasibilityCases(JSON.parse(bytes));
  assert.equal(hashWorkspace(fixture), manifest.fixtureHash);
  assert.equal(digest(JSON.stringify(manifest.conditions)), manifest.conditionsHash);
  assert.deepEqual(frozenSamples(cases, manifest.neutralRoot), manifest.samples);
  assertExecutionDependencies(manifest.executionDependencies, captureExecutionDependencies(root));
  if (digest(JSON.stringify(manifest.executionDependencies)) !== manifest.executionDependenciesHash) throw new DependencyAuditError('Dependency snapshot hash differs');
  return { manifest, cases };
}

function captureRevision(directory, label, revisionRoot, cases, manifest) {
  return manifest.samples.map(record => {
    prepareFeasibilityWorkspace(record.workspace);
    const sampleDirectory = join(directory, 'frozen', label, record.sampleId);
    const captured = captureV3({ revisionRoot, workspace: record.workspace, sample: cases.cases[0], language: record.language,
      configDirectory: join(directory, 'configs', label, record.sampleId), directory: sampleDirectory });
    writeFileSync(join(sampleDirectory, 'phase1.prompt.md'), captured.phase1Prompt);
    writeFileSync(join(sampleDirectory, 'phase2.prompt.md'), captured.phase2Prompt);
    assert.equal(hashWorkspace(record.workspace), manifest.fixtureHash);
    return { sampleId: record.sampleId, phase1PromptHash: digest(captured.phase1Prompt), phase2PromptHash: digest(captured.phase2Prompt),
      captureHash: digest(readFileSync(join(sampleDirectory, 'runtime-capture.json'))) };
  });
}

async function freezeBaseline(revision, directory, neutralRoot) {
  mkdirSync(directory, { recursive: true });
  assert.equal(readdirSync(directory).length, 0, 'Use a new follow-up result directory');
  assertNeutralTarget('', neutralRoot);
  assert.ok(!existsSync(neutralRoot), 'Use a new neutral workspace root');
  const source = readFileSync(casePath);
  const cases = validateFeasibilityCases(JSON.parse(source));
  const executionDependencies = captureExecutionDependencies(root);
  prepareFeasibilityWorkspace(join(neutralRoot, 'observation'));
  const observations = observeFeasibilityFixture(join(neutralRoot, 'observation'));
  cases.cases[0].workResult += '\nActual evaluator fixture receipts (not a model Phase 1):\n' + JSON.stringify(observations, null, 2);
  const bytes = JSON.stringify(cases, null, 2) + '\n';
  writeFileSync(join(directory, 'cases.frozen.json'), bytes);
  writeJson(join(directory, 'fixture-observations.json'), observations);
  const conditions = { target: cases.target, grader: cases.grader, languages: cases.languages, repeats: cases.repeats,
    maxConcurrency: cases.maxConcurrency, cache: false, permissions: { sandbox: 'read-only', approvalPolicy: 'never', networkAccessEnabled: false,
      webSearchMode: 'disabled', inheritedSkills: false },
    engineReset: 'All immutable fixture and engine-owned workspace files reset per sample',
    boundary: 'Isolated synthetic Phase 1 summary with actual evaluator command receipts; actual AgentRunner/provider-boundary capture; fresh tool-free model Phase 2',
  };
  const manifest = { protocol: 4, caseSourceHash: digest(source), casesHash: digest(bytes), conditions, conditionsHash: digest(JSON.stringify(conditions)),
    fixture: files(fixture), fixtureHash: hashWorkspace(fixture), neutralRoot, harnessHashes: harnessHashes(),
    executionDependencies, executionDependenciesHash: digest(JSON.stringify(executionDependencies)),
    samples: frozenSamples(cases, neutralRoot), revisions: {} };
  const revisionRoot = join(directory, 'revisions', 'baseline');
  const commit = buildRevision(revision, revisionRoot);
  assert.equal(commit, '811f3e4ec1d3a0f97782855f727197e72d90bf7c', 'Baseline must be current pre-feasibility-fix production');
  manifest.revisions.baseline = { commit, root: revisionRoot, captures: captureRevision(directory, 'baseline', revisionRoot, cases, manifest) };
  assertExecutionDependencies(executionDependencies, captureExecutionDependencies(root));
  writeJson(join(directory, 'manifest.json'), manifest);
  console.log(JSON.stringify({ status: 'follow-up baseline frozen', samples: manifest.samples.length, casesHash: manifest.casesHash,
    conditionsHash: manifest.conditionsHash, executionDependenciesHash: manifest.executionDependenciesHash }));
}

export function confirmFeasibilityBaseline(directory) {
  const red = readJson(join(directory, 'red', 'summary.json'));
  const confirmation = readJson(join(directory, 'baseline-confirmed.json'));
  assert.equal(confirmation.summaryHash, digest(readFileSync(join(directory, 'red', 'summary.json'))));
  assert.equal(red.infrastructureFailures, 0);
  assert.equal(red.rows.length, 6);
  assert.equal(red.passed + red.modelFailures, 6);
  assert.equal(confirmation.baselineOutcome, red.modelFailures > 0 ? 'semantic-failure-observed' : 'all-targets-passed');
  assert.equal(confirmation.candidateCaptureAuthorizedByRoot, true, 'Root must explicitly authorize candidate capture after baseline inspection');
}

async function captureCandidate(revision, directory) {
  const { manifest, cases } = auditFeasibilityFreeze(directory);
  confirmFeasibilityBaseline(directory);
  assert.equal(manifest.revisions.candidate, undefined, 'Do not overwrite candidate capture');
  const revisionRoot = join(directory, 'revisions', 'candidate');
  const commit = buildRevision(revision, revisionRoot);
  manifest.revisions.candidate = { commit, root: revisionRoot, captures: captureRevision(directory, 'candidate', revisionRoot, cases, manifest) };
  assertExecutionDependencies(manifest.executionDependencies, captureExecutionDependencies(root));
  writeJson(join(directory, 'manifest.json'), manifest);
}

export const evaluateFeasibility = options => evaluateV3({ ...options, auditProtocol: auditFeasibilityFreeze,
  prepareWorkspace: prepareFeasibilityWorkspace, hashWorkspace, confirmRed: confirmFeasibilityBaseline });

async function main() {
  const [operation, ...args] = process.argv.slice(2);
  if (operation === 'freeze-baseline' && args.length === 3) await freezeBaseline(args[0], resolve(args[1]), resolve(args[2]));
  else if (operation === 'capture-candidate' && args.length === 2) await captureCandidate(args[0], resolve(args[1]));
  else if (['red', 'green'].includes(operation) && args.length === 1) process.exitCode = await evaluateFeasibility({ phase: operation, directory: resolve(args[0]) });
  else throw new Error('Usage: report-feasibility.mjs freeze-baseline REV OUT NEUTRAL_ROOT | red OUT | capture-candidate REV OUT | green OUT');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main(); }
  catch (error) {
    if (!(error instanceof DependencyAuditError)) throw error;
    console.error(JSON.stringify({ status: 'infrastructure_failure', exitCode: 2, phaseInvalid: true, reason: error.message }));
    process.exitCode = 2;
  }
  process.exit(process.exitCode ?? 0);
}
