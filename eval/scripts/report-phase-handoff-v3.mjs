#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { evaluate } from 'promptfoo';
import { digest, runReadOnlyModel } from '../providers/report-phase-handoff-model.mjs';
import { assertNeutralTarget, assertToolFreeGrader, auditV3Items, gradingReference, scoreExecutionBoundaryV3 } from '../providers/report-phase-handoff-audit-v3.mjs';
import { assertExecutionDependencies, captureExecutionDependencies, DependencyAuditError } from '../providers/report-phase-handoff-dependencies-v3.mjs';
import { classifyResult, fixtureFiles } from './report-phase-handoff-eval.mjs';

process.env.PROMPTFOO_DISABLE_TELEMETRY = 'true';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fixturePath = join(repoRoot, 'eval/fixtures/report-phase-handoff');
const casesPath = join(repoRoot, 'eval/cases/report-phase-handoff-v3.json');
const runtimeScript = join(repoRoot, 'eval/scripts/report-phase-handoff-runtime-v3.mjs');
const harnessPaths = ['scripts/report-phase-handoff-v3.mjs', 'scripts/report-phase-handoff-runtime-v3.mjs',
  'providers/report-phase-handoff-audit-v3.mjs', 'providers/report-phase-handoff-dependencies-v3.mjs',
  'providers/report-phase-handoff-model.mjs', 'scripts/report-phase-handoff-eval.mjs'];
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const fixtureHash = workspace => digest(JSON.stringify(fixtureFiles(workspace)));
const sourceHashes = () => harnessPaths.map(path => ({ path, sha256: digest(readFileSync(join(repoRoot, 'eval', path))) }));

export async function runV3Model(options, runModel = runReadOnlyModel) {
  const result = await runModel(options);
  const turn = readJson(options.artifactPrefix + '.private-turn.json');
  Object.assign(result.trace, auditV3Items(turn.items));
  writeJson(options.artifactPrefix + '.trace.json', result.trace);
  return result;
}

export function validateV3Cases(cases) {
  assert.equal(cases.schemaVersion, 3);
  assert.equal(cases.repeats, 3);
  assert.equal(cases.maxConcurrency, 3);
  assert.deepEqual(cases.languages, ['ja', 'en']);
  assert.deepEqual(cases.target, { model: 'gpt-6-sol', effort: 'high' });
  assert.deepEqual(cases.grader, cases.target);
  assert.deepEqual(cases.cases.map(row => row.id), ['revised-export', 'rule-source-status', 'observed-label-control']);
  assert.ok(cases.gradingBoundary.includes('Do not use any tools'));
  assert.ok(cases.cases.every(row => Object.values(row.rubrics).every(value => value.trim())));
  assert.ok(cases.cases[1].rubrics['unknown-implementation']);
  return cases;
}

export function resetWorkspace(workspace) {
  assertNeutralTarget('', workspace);
  rmSync(workspace, { recursive: true, force: true });
  cpSync(fixturePath, workspace, { recursive: true });
  assert.equal(fixtureHash(workspace), fixtureHash(fixturePath));
}

export function captureV3({ revisionRoot, workspace, configDirectory, sample, language, directory, workResult }) {
  mkdirSync(directory, { recursive: true });
  const resultPath = join(directory, 'runtime-capture.json');
  const requestPath = join(directory, 'runtime-request.json');
  const { rubrics: _rubrics, ...inputs } = sample;
  writeJson(requestPath, { revisionRoot, workspace, configDirectory, sample: inputs, language, resultPath,
    ...(workResult === undefined ? {} : { workResult }) });
  const log = execFileSync(process.execPath, [runtimeScript, requestPath], {
    cwd: repoRoot, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  writeFileSync(join(directory, 'capture.stdout.log'), log);
  const captured = readJson(resultPath);
  // Capturing both phases must not expose the stub's future report to actual Phase 1.
  rmSync(join(workspace, '.takt/runs/eval/reports/implementation-report.md'), { force: true });
  assert.deepEqual(captured.phase2Options, { allowedTools: [], sessionIdPresent: false });
  for (const prompt of [captured.phase1Prompt, captured.phase2Prompt]) assertNeutralTarget(prompt, workspace);
  if (sample.liveInput !== undefined) {
    assert.ok(captured.phase1Prompt.includes(sample.liveInput));
    assert.equal(captured.liveInstructions.length, 1);
    assert.equal(captured.liveInstructions[0].content, sample.liveInput);
    assert.equal(captured.liveInstructions[0].state, 'deliveredNextStep');
  }
  if (sample.upstream !== undefined) assert.ok(captured.phase1Prompt.includes(sample.upstream));
  if (sample.reportContent !== undefined) assert.ok(captured.phase1Prompt.includes(sample.reportContent));
  return captured;
}

export function buildRevision(revision, directory) {
  const commit = execFileSync('git', ['rev-parse', `${revision}^{commit}`], { cwd: repoRoot, encoding: 'utf8' }).trim();
  mkdirSync(directory, { recursive: true });
  const archive = execFileSync('git', ['archive', commit], { cwd: repoRoot, maxBuffer: 256 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', directory], { input: archive });
  symlinkSync(join(repoRoot, 'node_modules'), join(directory, 'node_modules'), 'dir');
  const output = execFileSync('npm', ['run', 'build'], { cwd: directory, encoding: 'utf8', timeout: 180_000, maxBuffer: 20 * 1024 * 1024 });
  writeFileSync(join(directory, 'eval-build.log'), output);
  return commit;
}

export function frozenSamples(cases, neutralRoot) {
  return cases.languages.flatMap(language => cases.cases.flatMap(sample => Array.from({ length: cases.repeats }, (_, index) => {
    const sampleId = `${language}-${sample.id}-r${index + 1}`;
    return { sampleId, language, caseId: sample.id, kind: sample.kind, workspace: join(neutralRoot, sampleId),
      inputHash: digest(JSON.stringify(Object.fromEntries(Object.entries(sample).filter(([key]) => key !== 'rubrics')))),
      rubricHashes: Object.entries(sample.rubrics).map(([metric, rubric]) => ({ metric, sha256: digest(rubric) })) };
  })));
}

function auditFrozen(directory) {
  const manifest = readJson(join(directory, 'manifest.json'));
  assert.deepEqual(sourceHashes(), manifest.harnessHashes, 'Frozen harness changed');
  const bytes = readFileSync(join(directory, 'cases.frozen.json'));
  assert.equal(digest(bytes), manifest.casesHash);
  const cases = validateV3Cases(JSON.parse(bytes));
  assert.equal(fixtureHash(fixturePath), manifest.fixtureHash);
  assert.deepEqual(frozenSamples(cases, manifest.neutralRoot), manifest.samples);
  assertExecutionDependencies(manifest.executionDependencies, captureExecutionDependencies(repoRoot));
  if (digest(JSON.stringify(manifest.executionDependencies)) !== manifest.executionDependenciesHash) {
    throw new DependencyAuditError('Frozen execution dependency snapshot hash differs');
  }
  return { manifest, cases };
}

function captureRevision(directory, label, revisionRoot, cases, samples) {
  const captures = [];
  for (const record of samples) {
    resetWorkspace(record.workspace);
    const sample = cases.cases.find(row => row.id === record.caseId);
    const sampleDirectory = join(directory, 'frozen', label, record.sampleId);
    const captured = captureV3({ revisionRoot, workspace: record.workspace, sample, language: record.language,
      configDirectory: join(directory, 'configs', label, record.sampleId), directory: sampleDirectory });
    writeFileSync(join(sampleDirectory, 'phase1.prompt.md'), captured.phase1Prompt);
    writeFileSync(join(sampleDirectory, 'phase2.prompt.md'), captured.phase2Prompt);
    assert.equal(fixtureHash(record.workspace), fixtureHash(fixturePath));
    captures.push({ sampleId: record.sampleId, phase1PromptHash: digest(captured.phase1Prompt),
      phase2PromptHash: digest(captured.phase2Prompt), captureHash: digest(readFileSync(join(sampleDirectory, 'runtime-capture.json'))) });
  }
  return captures;
}

async function freezeBaseline(revision, directory, neutralRoot) {
  mkdirSync(directory, { recursive: true });
  assert.equal(readdirSync(directory).length, 0, 'Use a new v3 output directory');
  assertNeutralTarget('', neutralRoot);
  assert.ok(!existsSync(neutralRoot), 'Use a new neutral workspace root');
  const caseBytes = readFileSync(casesPath);
  const cases = validateV3Cases(JSON.parse(caseBytes));
  const executionDependencies = captureExecutionDependencies(repoRoot);
  writeFileSync(join(directory, 'cases.frozen.json'), caseBytes);
  const conditions = { target: cases.target, grader: cases.grader, repeats: cases.repeats, languages: cases.languages,
    maxConcurrency: cases.maxConcurrency, cache: false,
    permissions: { sandbox: 'read-only', approvalPolicy: 'never', networkAccessEnabled: false, webSearchMode: 'disabled', inheritedSkills: false },
    targetCwd: 'Same neutral absolute path per paired sample; isolated case/language/repeat; external to repository',
    providerBoundary: 'Actual AgentRunner wrapper + actual onPromptResolved, only CodexProvider setup/call replaced',
    p2Tools: 'Prompt prohibition plus executed item audit; SDK readonly is not hard tool disablement',
    graderTools: 'Prompt prohibition; any executed tool item is infrastructure failure',
    engineReset: 'Reset all fixture and engine-owned workspace files before each sample; clear .takt on each capture',
    captureStubReport: 'Remove the capture-only placeholder report before actual model execution',
    engineClock: '2026-10-03T00:00:00.000Z for deterministic capture paths; model execution clock unchanged',
  };
  const manifest = { protocol: 3, status: 'criteria frozen; baseline captured before model calls',
    casesHash: digest(caseBytes), fixture: fixtureFiles(), fixtureHash: fixtureHash(fixturePath),
    conditions, conditionsHash: digest(JSON.stringify(conditions)), neutralRoot, node: process.version,
    historicalCheckpoint: '28eadf50f492ee3507825d40f36b335876c025f6', harnessHashes: sourceHashes(),
    executionDependencies, executionDependenciesHash: digest(JSON.stringify(executionDependencies)),
    samples: frozenSamples(cases, neutralRoot), revisions: {} };
  const root = join(directory, 'revisions', 'baseline');
  const commit = buildRevision(revision, root);
  assert.equal(commit, '24b6990a4767602e8ec52fce7e1f6e56d0e4982a', 'Baseline must be the actual pre-fix revision');
  manifest.revisions.baseline = { commit, root, captures: captureRevision(directory, 'baseline', root, cases, manifest.samples) };
  const verification = {};
  for (const operation of ['build', 'test']) verification[operation] = execFileSync('npm', ['run', operation], { cwd: fixturePath, encoding: 'utf8' });
  writeJson(join(directory, 'fixture-verification.json'), verification);
  assertExecutionDependencies(executionDependencies, captureExecutionDependencies(repoRoot));
  writeJson(join(directory, 'manifest.json'), manifest);
  console.log(JSON.stringify({ status: manifest.status, casesHash: manifest.casesHash, conditionsHash: manifest.conditionsHash, samples: manifest.samples.length }));
}

function requireObservedRed(directory) {
  const red = readJson(join(directory, 'red', 'summary.json'));
  assert.equal(red.infrastructureFailures, 0);
  assert.equal(red.rows.length, 18);
  assert.ok(red.modelFailures > 0, 'Need observed semantic RED before candidate capture');
  assert.ok(existsSync(join(directory, 'red-confirmed.json')), 'Root must inspect semantic failures and confirm RED before candidate capture');
  const confirmation = readJson(join(directory, 'red-confirmed.json'));
  assert.equal(confirmation.summaryHash, digest(readFileSync(join(directory, 'red', 'summary.json'))));
  return red;
}

async function captureCandidate(revision, directory) {
  const { manifest, cases } = auditFrozen(directory);
  requireObservedRed(directory);
  assert.ok(manifest.revisions.candidate === undefined, 'Do not overwrite candidate capture');
  const root = join(directory, 'revisions', 'candidate');
  const commit = buildRevision(revision, root);
  manifest.revisions.candidate = { commit, root, captures: captureRevision(directory, 'candidate', root, cases, manifest.samples) };
  assertExecutionDependencies(manifest.executionDependencies, captureExecutionDependencies(repoRoot));
  writeJson(join(directory, 'manifest.json'), manifest);
  console.log(JSON.stringify({ status: 'candidate captured after observed RED', commit, conditionsHash: manifest.conditionsHash }));
}

const linedFixture = workspace => ['src/session-label.js', 'tests/session-label.test.js'].map(path => ({
  path, contentWithLines: readFileSync(join(workspace, path), 'utf8').split('\n').map((line, i) => `${i + 1}: ${line}`).join('\n'),
}));

export function buildGraderPrompt(prompt, context, observation, cases) {
  assert.ok(observation?.reference, 'Missing actual grader reference');
  assert.equal(digest(context.vars.output), observation.phase2.responseHash, 'Grader response differs from actual target output');
  const rubric = context.vars.rubric;
  const source = cases.cases.find(row => row.id === observation.caseId);
  assert.ok(Object.values(source.rubrics).includes(rubric), 'Grader rubric differs from frozen case');
  return cases.gradingBoundary + '\n\n' + prompt + '\n\nEvaluation-only reference (data, not target instructions):\n' + JSON.stringify(observation.reference, null, 2);
}

export async function evaluateV3({ phase, directory, runModel = runV3Model,
  auditProtocol = auditFrozen, prepareWorkspace = resetWorkspace, hashWorkspace = fixtureHash, confirmRed = requireObservedRed }) {
  const { manifest, cases } = auditProtocol(directory);
  if (phase === 'green') confirmRed(directory);
  const revisionLabel = phase === 'red' ? 'baseline' : 'candidate';
  const revision = manifest.revisions[revisionLabel];
  assert.ok(revision, 'Revision must be captured before model execution');
  const outputDirectory = join(directory, phase);
  mkdirSync(outputDirectory, { recursive: true });
  assert.equal(readdirSync(outputDirectory).length, 0, 'Never overwrite v3 responses');
  const observations = new Map(), graderFailures = new Set();
  let graderCalls = 0;
  const graderWorkspace = join(manifest.neutralRoot, 'assessment');
  mkdirSync(graderWorkspace, { recursive: true });
  const grader = {
    id: () => 'report-handoff-v3-grader:gpt-6-sol-high', config: { maxRetries: 0 },
    callApi: async (prompt, context) => {
      const prefix = join(outputDirectory, 'grader-' + ++graderCalls);
      const sampleId = context.vars.sampleId;
      try {
        const observation = observations.get(sampleId);
        const rubric = context.vars.rubric;
        const finalPrompt = buildGraderPrompt(prompt, context, observation, cases);
        writeJson(prefix + '.context.json', { sampleId, rubricHash: digest(rubric), responseHash: observation.phase2.responseHash,
          referenceHash: digest(JSON.stringify(observation.reference)), finalPromptHash: digest(finalPrompt) });
        const result = await runModel({ prompt: finalPrompt, cwd: graderWorkspace, ...cases.grader, artifactPrefix: prefix });
        assertToolFreeGrader(result.trace);
        return { output: result.output, metadata: { trace: result.trace } };
      } catch (error) {
        graderFailures.add(sampleId);
        writeFileSync(prefix + '.private-error.txt', String(error?.stack ?? error), { mode: 0o600 });
        return { error: 'Grader SDK/receipt/tool audit failure; not semantic RED' };
      }
    },
  };
  const provider = {
    id: () => 'report-handoff-v3-target:gpt-6-sol-high', config: { maxRetries: 0 },
    callApi: async (_prompt, context) => {
      const record = manifest.samples.find(row => row.sampleId === context.vars.sampleId);
      const sample = cases.cases.find(row => row.id === record.caseId);
      const artifactDirectory = join(outputDirectory, record.sampleId);
      mkdirSync(artifactDirectory, { recursive: true });
      try {
        const frozenRecord = revision.captures.find(row => row.sampleId === record.sampleId);
        const frozenDirectory = join(directory, 'frozen', revisionLabel, record.sampleId);
        const captureBytes = readFileSync(join(frozenDirectory, 'runtime-capture.json'));
        assert.equal(digest(captureBytes), frozenRecord.captureHash);
        const frozen = JSON.parse(captureBytes);
        for (const [name, hash] of [['phase1', frozenRecord.phase1PromptHash], ['phase2', frozenRecord.phase2PromptHash]]) {
          assert.equal(digest(readFileSync(join(frozenDirectory, name + '.prompt.md'))), hash);
        }
        prepareWorkspace(record.workspace);
        let captured = captureV3({ revisionRoot: revision.root, workspace: record.workspace, sample, language: record.language,
          configDirectory: join(directory, 'configs', revisionLabel, record.sampleId), directory: join(artifactDirectory, 'prepared') });
        assert.equal(digest(captured.phase1Prompt), frozenRecord.phase1PromptHash, 'Executed Phase 1 differs from frozen capture');
        assert.equal(digest(captured.phase2Prompt), frozenRecord.phase2PromptHash, 'Prepared Phase 2 differs from frozen capture');
        let phase1;
        if (record.kind === 'live-phase1-chain') {
          phase1 = await runModel({ prompt: captured.phase1Prompt, cwd: record.workspace, ...cases.target, artifactPrefix: join(artifactDirectory, 'phase1') });
          assert.equal(hashWorkspace(record.workspace), manifest.fixtureHash, 'Phase 1 changed immutable fixture');
          captured = captureV3({ revisionRoot: revision.root, workspace: record.workspace, sample, language: record.language,
            configDirectory: join(directory, 'configs', revisionLabel, record.sampleId), directory: join(artifactDirectory, 'actual-handoff'), workResult: phase1.output });
        }
        assertNeutralTarget(captured.phase2Prompt, record.workspace);
        const phase2 = await runModel({ prompt: captured.phase2Prompt, cwd: record.workspace, ...cases.target, artifactPrefix: join(artifactDirectory, 'phase2') });
        assert.equal(hashWorkspace(record.workspace), manifest.fixtureHash, 'Phase 2 changed immutable fixture');
        const boundary = scoreExecutionBoundaryV3(sample, phase2.trace, phase1?.trace, record.workspace);
        const reference = gradingReference(sample, captured, phase1 ? { ...phase1, verifiedReceipts: boundary.verifiedReceipts } : undefined,
          phase1 ? linedFixture(record.workspace) : undefined);
        const observation = { caseId: record.caseId, boundary, phase1: phase1?.trace, phase2: phase2.trace, reference,
          workspace: record.workspace, immutableFixtureHashAfter: hashWorkspace(record.workspace), engineReset: manifest.conditions.engineReset,
          actualCaptureHash: digest(JSON.stringify(captured)), frozenPhase1Hash: frozenRecord.phase1PromptHash,
          actualPhase1PromptHash: digest(captured.phase1Prompt), referenceHash: digest(JSON.stringify(reference)) };
        observations.set(record.sampleId, observation);
        writeJson(join(artifactDirectory, 'grader-reference.json'), reference);
        console.log(`${phase} ${record.sampleId}: target complete; tools=${phase2.trace.toolCount}; execution=${boundary.pass}`);
        return { output: phase2.output, metadata: observation };
      } catch (error) {
        writeFileSync(join(artifactDirectory, 'private-error.txt'), String(error?.stack ?? error), { mode: 0o600 });
        return { error: 'Target SDK/runtime/receipt audit failure; not semantic RED' };
      }
    },
  };
  const tests = manifest.samples.map(record => {
    const sample = cases.cases.find(row => row.id === record.caseId);
    return { description: record.sampleId, vars: { sampleId: record.sampleId }, assert: [
      { type: 'javascript', metric: 'report-handoff/execution-boundary', value: (_output, context) => observations.get(context.vars.sampleId)?.boundary ?? { pass: false, score: 0, reason: 'Missing actual receipts' } },
      ...Object.entries(sample.rubrics).map(([metric, value]) => ({ type: 'llm-rubric', metric: 'report-handoff/' + metric, value })),
    ] };
  });
  const evaluation = await evaluate({ prompts: [({ vars }) => vars.sampleId], providers: [provider], tests,
    defaultTest: { options: { provider: grader } }, writeLatestResults: false,
  }, { cache: false, maxConcurrency: manifest.conditions.maxConcurrency, showProgressBar: false, writeLatestResults: false });
  assertExecutionDependencies(manifest.executionDependencies, captureExecutionDependencies(repoRoot));
  writeJson(join(outputDirectory, 'promptfoo.json'), evaluation);
  const rows = evaluation.results.map(result => {
    const sampleId = manifest.samples[result.testIdx].sampleId;
    const classified = classifyResult(result);
    if (graderFailures.has(sampleId)) { classified.status = 'infrastructure_failure'; classified.pass = false; }
    return { sampleId, ...classified, observation: observations.get(sampleId) };
  });
  const summary = { protocol: manifest.protocol, phase, commit: revision.commit, casesHash: manifest.casesHash, conditionsHash: manifest.conditionsHash,
    fixtureHash: manifest.fixtureHash, passed: rows.filter(row => row.status === 'pass').length,
    modelFailures: rows.filter(row => row.status === 'model_failure').length,
    infrastructureFailures: rows.filter(row => row.status === 'infrastructure_failure').length, graderCalls, rows };
  writeJson(join(outputDirectory, 'summary.json'), summary);
  const exitCode = summary.infrastructureFailures > 0 ? 2 : summary.modelFailures > 0 ? 1 : 0;
  writeJson(join(outputDirectory, 'command.json'), { command: process.argv, exitCode });
  console.log(JSON.stringify({ phase, passed: summary.passed, modelFailures: summary.modelFailures, infrastructureFailures: summary.infrastructureFailures, graderCalls, exitCode }));
  return exitCode;
}

async function main() {
  const [operation, ...args] = process.argv.slice(2);
  if (operation === 'freeze-baseline' && args.length === 3) await freezeBaseline(args[0], resolve(args[1]), resolve(args[2]));
  else if (operation === 'capture-candidate' && args.length === 2) await captureCandidate(args[0], resolve(args[1]));
  else if (['red', 'green'].includes(operation) && args.length === 1) process.exitCode = await evaluateV3({ phase: operation, directory: resolve(args[0]) });
  else throw new Error('Usage: report-phase-handoff-v3.mjs freeze-baseline BASELINE OUT NEUTRAL_ROOT | red OUT | capture-candidate COMMIT OUT | green OUT');
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
