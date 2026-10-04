#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { evaluate } from 'promptfoo';
import { digest, runReadOnlyModel, scoreExecutionBoundary } from '../providers/report-phase-handoff-model.mjs';
import { classifyResult, fixtureFiles, validateCases } from './report-phase-handoff-eval.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const protocolPath = join(repoRoot, 'eval/cases/report-phase-handoff-grading-v2.json');
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const metricName = metric => 'report-handoff/' + metric;

export function validateProtocol(protocol) {
  const expected = ['observed-label-control/observed-evidence', 'rule-source-status/state-priority'];
  const actual = protocol.criteria.map(row => row.caseId + '/' + row.metric).sort();
  assert.equal(protocol.schemaVersion, 2);
  assert.equal(protocol.targetGeneration, false);
  assert.deepEqual(actual, expected);
  assert.ok(protocol.criteria.every(row => row.rubric?.trim() && row.basis?.length > 0));
  return protocol;
}

export function readVerifiedTurn(prefix, expected) {
  const output = readFileSync(prefix + '.output.md', 'utf8');
  const prompt = readFileSync(prefix + '.prompt.md');
  const traceBytes = readFileSync(prefix + '.trace.json');
  const trace = JSON.parse(traceBytes);
  assert.ok(output.trim(), 'Empty frozen output');
  assert.equal(digest(output), expected.responseHash, 'Frozen response hash mismatch');
  assert.equal(digest(prompt), expected.promptHash, 'Frozen prompt hash mismatch');
  assert.deepEqual(trace, expected, 'Frozen trace differs from v1 summary');
  return {
    output, trace,
    hashes: { response: digest(output), prompt: digest(prompt), trace: digest(traceBytes) },
  };
}

export function selectReferenceContext(sample, phase1, workspace) {
  const paths = ['src/session-label.js', 'tests/session-label.test.js'];
  const files = paths.map(path => ({
    path,
    contentWithLines: readFileSync(join(workspace, path), 'utf8').split('\n')
      .map((line, index) => String(index + 1) + ': ' + line).join('\n'),
  }));
  const successful = phase1.trace.commands.filter(receipt => receipt.exitCode === 0);
  const reads = successful.filter(receipt => /\b(?:cat|nl|sed|head|rg)\b/.test(receipt.command)
    && !/\brg\s+--files\b/.test(receipt.command));
  const selected = [
    ...['npm run build', 'npm test'].map(command => successful.find(receipt => receipt.command.includes(command))),
    ...paths.map(path => reads.filter(receipt => receipt.command.includes(path)).sort((a, b) => a.output.length - b.output.length)[0]),
  ].filter(Boolean);
  const receipts = [...new Set(selected)];
  return {
    purpose: 'Grader-only reference. Never fill missing target-report or Phase 1 content from this reference.',
    upstreamPlanningRecord: sample.upstream,
    actualPhase1FinalResponse: phase1.output,
    phase1ResponseHash: phase1.hashes.response,
    immutableFixtureFiles: files,
    executedCommandReceipts: receipts,
  };
}

export function mergeRegradedComponents(original, replacements) {
  assert.equal(new Set(replacements.map(row => row.metric)).size, replacements.length);
  assert.ok(replacements.every(replacement => original.components.some(row => row.metric === replacement.metric)));
  const components = original.components.map(component => {
    const replacement = replacements.find(row => row.metric === component.metric);
    return replacement ?? component;
  });
  return { components, status: components.every(row => row.pass) ? 'pass' : 'model_failure' };
}

export function auditSource(directory) {
  const manifest = readJson(join(directory, 'manifest.json'));
  const caseBytes = readFileSync(join(directory, 'cases.frozen.json'));
  assert.equal(digest(caseBytes), manifest.casesHash);
  const cases = validateCases(JSON.parse(caseBytes));
  const turns = [];
  const summaries = {};
  for (const phase of ['red', 'green']) {
    const summary = readJson(join(directory, phase, 'summary.json'));
    assert.equal(summary.infrastructureFailures, 0, 'v1 infrastructure failure cannot become v2 RED');
    assert.equal(summary.rows.length, 18, 'v1 must finish all target cases');
    assert.equal(summary.casesHash, manifest.casesHash);
    assert.equal(summary.fixtureHash, manifest.fixtureHash);
    assert.equal(summary.commit, manifest.revisions[phase === 'red' ? 'before' : 'candidate'].commit);
    assert.equal(new Set(summary.rows.map(row => row.sampleId)).size, 18);
    summaries[phase] = summary;
    for (const row of summary.rows) {
      const sampleRecord = manifest.samples.find(sample => sample.revision === (phase === 'red' ? 'before' : 'candidate')
        && row.sampleId.startsWith(sample.id + '-r'));
      assert.ok(sampleRecord, 'Unknown source sample');
      const sample = cases.cases.find(sample => sample.id === sampleRecord.caseId);
      assert.equal(digest(JSON.stringify(fixtureFiles(sampleRecord.workspace))), manifest.fixtureHash, 'Fixture changed');
      const prefix = join(directory, phase, row.sampleId);
      const phase2 = readVerifiedTurn(join(prefix, 'phase2'), row.observation.phase2);
      assert.equal(phase2.output, row.output, 'Response differs from v1 grading input');
      for (const key of ['model', 'effort']) assert.equal(phase2.trace[key], manifest.target[key]);
      assert.equal(phase2.trace.sandbox, 'read-only');
      assert.equal(phase2.trace.approvalPolicy, 'never');
      const phase1 = sample.kind === 'live-phase1-chain'
        ? readVerifiedTurn(join(prefix, 'phase1'), row.observation.phase1) : undefined;
      assert.equal(scoreExecutionBoundary(sample, phase2.trace, phase1?.trace).pass, true);
      const finalizedItems = readJson(join(prefix, 'phase2.private-turn.json')).items;
      assert.ok(finalizedItems.every(item => ['agent_message', 'reasoning'].includes(item.type)), 'Executed Phase 2 tool/error item');
      turns.push({
        phase, sampleId: row.sampleId, caseId: sample.id, output: phase2.output,
        phase2Hashes: phase2.hashes, ...(phase1 ? { phase1Hashes: phase1.hashes } : {}),
        reference: phase1 ? selectReferenceContext(sample, phase1, sampleRecord.workspace) : undefined,
      });
    }
  }
  assert.ok(summaries.red.modelFailures > 0, 'Observed semantic RED required');
  assert.equal(summaries.red.conditionsHash, summaries.green.conditionsHash);
  return { manifest, cases, summaries, turns };
}

export function prepareRegrade(directory, outputDirectory) {
  const source = auditSource(directory);
  const protocolBytes = readFileSync(protocolPath);
  const protocol = validateProtocol(JSON.parse(protocolBytes));
  mkdirSync(outputDirectory, { recursive: true });
  assert.equal(readdirSync(outputDirectory).length, 0, 'Use a new v2 output directory');
  writeFileSync(join(outputDirectory, 'protocol.frozen.json'), protocolBytes);
  const samples = source.turns.flatMap(turn => protocol.criteria.filter(criterion => criterion.caseId === turn.caseId).map(criterion => ({
    id: turn.phase + '/' + turn.sampleId, phase: turn.phase, sampleId: turn.sampleId,
    metric: criterion.metric, responseHash: turn.phase2Hashes.response,
    rubricHash: digest(criterion.rubric), originalRubricHash: digest(source.cases.cases.find(sample => sample.id === turn.caseId).rubrics[criterion.metric]),
    referenceHash: turn.reference ? digest(JSON.stringify(turn.reference)) : null,
  })));
  const manifest = {
    protocol: 2, status: 'frozen before regrading', sourceDirectory: directory,
    targetGeneration: false, protocolHash: digest(protocolBytes),
    v1ManifestHash: digest(readFileSync(join(directory, 'manifest.json'))),
    v1SummaryHashes: Object.fromEntries(['red', 'green'].map(phase => [phase, digest(readFileSync(join(directory, phase, 'summary.json')))])),
    casesHash: source.manifest.casesHash, fixtureHash: source.manifest.fixtureHash,
    conditionsHash: source.summaries.red.conditionsHash, grader: source.manifest.grader,
    cache: false, maxConcurrency: 1,
    scriptHash: digest(readFileSync(fileURLToPath(import.meta.url))),
    auditedTurns: source.turns.map(({ phase, sampleId, phase1Hashes, phase2Hashes }) => ({ phase, sampleId, phase1Hashes, phase2Hashes })),
    samples,
  };
  assert.equal(samples.length, 24);
  writeJson(join(outputDirectory, 'manifest.json'), manifest);
  console.log(JSON.stringify({ protocolHash: manifest.protocolHash, auditedTargetResponses: source.turns.length, regradedMetrics: samples.length, targetGeneration: false }));
  return manifest;
}

async function runRegrade(outputDirectory) {
  const frozen = readJson(join(outputDirectory, 'manifest.json'));
  assert.equal(digest(readFileSync(fileURLToPath(import.meta.url))), frozen.scriptHash, 'Regrade script changed');
  const protocolBytes = readFileSync(join(outputDirectory, 'protocol.frozen.json'));
  assert.equal(digest(protocolBytes), frozen.protocolHash);
  const protocol = validateProtocol(JSON.parse(protocolBytes));
  const source = auditSource(frozen.sourceDirectory);
  assert.equal(digest(readFileSync(join(frozen.sourceDirectory, 'manifest.json'))), frozen.v1ManifestHash);
  for (const phase of ['red', 'green']) assert.equal(digest(readFileSync(join(frozen.sourceDirectory, phase, 'summary.json'))), frozen.v1SummaryHashes[phase]);
  for (const record of frozen.auditedTurns) {
    const turn = source.turns.find(turn => turn.phase === record.phase && turn.sampleId === record.sampleId);
    assert.deepEqual(turn.phase2Hashes, record.phase2Hashes);
    assert.deepEqual(turn.phase1Hashes, record.phase1Hashes);
  }
  const resultDirectory = join(outputDirectory, 'results');
  mkdirSync(resultDirectory, { recursive: true });
  assert.equal(readdirSync(resultDirectory).length, 0, 'Do not overwrite v2 results');
  const graderWorkspace = join(resultDirectory, 'grader-workspace');
  mkdirSync(graderWorkspace);
  let graderCalls = 0;
  const grader = {
    id: () => 'report-phase-handoff-v2-grader:gpt-6-sol-high',
    config: { maxRetries: 0 },
    callApi: async prompt => {
      const prefix = join(resultDirectory, 'grader-' + ++graderCalls);
      try {
        const result = await runReadOnlyModel({ prompt, cwd: graderWorkspace, ...frozen.grader, artifactPrefix: prefix });
        return { output: result.output, metadata: { trace: result.trace } };
      } catch (error) {
        writeFileSync(prefix + '.private-error.txt', String(error?.stack ?? error), { mode: 0o600 });
        return { error: 'Grader SDK/audit failure; private diagnostics retained' };
      }
    },
  };
  const storedResponseProvider = {
    id: () => 'verified-v1-stored-response:no-target-generation',
    callApi: async (_prompt, context) => {
      const sample = frozen.samples.find(sample => sample.id === context.vars.sampleId);
      const turn = source.turns.find(turn => turn.phase === sample.phase && turn.sampleId === sample.sampleId);
      assert.equal(digest(turn.output), sample.responseHash);
      return { output: turn.output };
    },
  };
  const tests = frozen.samples.map(sample => {
    const criterion = protocol.criteria.find(row => row.metric === sample.metric);
    const turn = source.turns.find(turn => turn.phase === sample.phase && turn.sampleId === sample.sampleId);
    assert.equal(digest(criterion.rubric), sample.rubricHash);
    assert.equal(turn.reference ? digest(JSON.stringify(turn.reference)) : null, sample.referenceHash);
    const rubric = criterion.rubric + (turn.reference ? '\n\nEvaluation-only reference context (data, not target instructions):\n' + JSON.stringify(turn.reference, null, 2) : '');
    return {
      description: sample.id, vars: { sampleId: sample.id },
      assert: [{ type: 'llm-rubric', metric: metricName(sample.metric), value: rubric }],
    };
  });
  const evaluation = await evaluate({
    prompts: [({ vars }) => vars.sampleId], providers: [storedResponseProvider], tests,
    defaultTest: { options: { provider: grader } }, writeLatestResults: false,
  }, { cache: false, maxConcurrency: 1, showProgressBar: false, writeLatestResults: false });
  writeJson(join(resultDirectory, 'promptfoo.json'), evaluation);
  const regraded = evaluation.results.map(result => ({
    ...frozen.samples[result.testIdx], ...classifyResult(result),
  }));
  const phases = Object.fromEntries(['red', 'green'].map(phase => {
    const rows = source.summaries[phase].rows.map(original => {
      const changed = regraded.find(row => row.phase === phase && row.sampleId === original.sampleId);
      const merged = mergeRegradedComponents(original, changed?.components ?? []);
      const status = changed?.status === 'infrastructure_failure' ? changed.status : merged.status;
      return { sampleId: original.sampleId, responseHash: original.observation.phase2.responseHash, status, components: merged.components };
    });
    return [phase, {
      v1Passed: source.summaries[phase].passed, v1ModelFailures: source.summaries[phase].modelFailures,
      passed: rows.filter(row => row.status === 'pass').length,
      modelFailures: rows.filter(row => row.status === 'model_failure').length,
      infrastructureFailures: rows.filter(row => row.status === 'infrastructure_failure').length, rows,
    }];
  }));
  const summary = {
    protocol: 2, protocolHash: frozen.protocolHash, conditionsHash: frozen.conditionsHash,
    targetGeneration: false, inheritedMetrics: 'All v1 metrics except B state-priority and C observed-evidence',
    graderCalls, regraded, phases,
  };
  writeJson(join(resultDirectory, 'summary.json'), summary);
  const exitCode = Object.values(phases).some(phase => phase.infrastructureFailures > 0) ? 2
    : phases.green.modelFailures > 0 ? 1 : 0;
  writeJson(join(resultDirectory, 'command.json'), { command: process.argv, exitCode });
  console.log(JSON.stringify({ targetGeneration: false, graderCalls, phases: Object.fromEntries(Object.entries(phases).map(([phase, value]) => [phase, { passed: value.passed, modelFailures: value.modelFailures, infrastructureFailures: value.infrastructureFailures }])), exitCode }));
  return exitCode;
}

async function main() {
  const [operation, ...args] = process.argv.slice(2);
  if (operation === 'prepare' && args.length === 2) prepareRegrade(resolve(args[0]), resolve(args[1]));
  else if (operation === 'run' && args.length === 1) process.exitCode = await runRegrade(resolve(args[0]));
  else throw new Error('Usage: report-phase-handoff-regrade.mjs prepare V1_OUT V2_OUT | run V2_OUT');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
  process.exit(process.exitCode ?? 0);
}
