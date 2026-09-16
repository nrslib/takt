import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseKimiAssistantOutput } from '../scripts/development-loop-eval.mjs';
import {
  actualModel,
  evaluationExitCode,
  kimiCliVersion,
  loadFrozenPhase,
  phasePlanFromManifest,
  parseCliArguments,
  parseKimiSessionListOutput,
  parseKimiStdoutEvidence,
  parseKimiWireEvidence,
  providerId,
  requestedModelAlias,
  rowsForPhase,
  validatePairedSources,
  validateSavedKimiOutput,
  validateKimiProvenance,
} from '../scripts/instruction-research-handoff-kimi-cli.mjs';
import {
  buildSamples,
  fixtureSnapshot,
  fixtureVerificationEvidence,
  fixtureWorkspaceEvidence,
  manifestFor,
  providerSelectionFor,
  readCases,
  classifyResult,
} from '../scripts/instruction-research-handoff-eval.mjs';

const casesPath = new URL('../cases/instruction-research-handoff.yaml', import.meta.url);
const hash = value => createHash('sha256').update(value).digest('hex');

function writeSyntheticSource(
  directory,
  phase,
  samples,
  fixture,
  casesHash,
  promptOverrides = {},
  skipProviderIds = [],
) {
  mkdirSync(join(directory, 'prompts'), { recursive: true });
  mkdirSync(join(directory, 'rubrics'), { recursive: true });
  mkdirSync(join(directory, 'rows'), { recursive: true });
  const manifest = {
    ...manifestFor('test-revision', casesHash, samples, fixture, providerSelectionFor(skipProviderIds)),
    revision: phase + '-rescored',
    sourceRevision: phase,
  };
  manifest.samples = manifest.samples.map(sample => {
    const prompt = promptOverrides[sample.id] ?? samples.find(candidate => candidate.id === sample.id).prompt;
    return { ...sample, promptHash: hash(prompt) };
  });
  for (const sample of samples) {
    const prompt = promptOverrides[sample.id] ?? sample.prompt;
    writeFileSync(join(directory, 'prompts', sample.id + '.md'), prompt);
    if (sample.semanticRubric !== null) writeFileSync(join(directory, 'rubrics', sample.id + '.md'), sample.semanticRubric);
  }
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const manifestHash = hash(JSON.stringify(manifest));
  const revision = manifest.revision ?? phase;
  const skippedProviderIds = new Set(manifest.providerSelection.skipped.map(provider => provider.id));
  for (const provider of manifest.providers) for (const sample of manifest.samples) {
    const skipped = skippedProviderIds.has(provider.id);
    writeFileSync(join(directory, 'rows', `${provider.id}--${sample.id}.json`), JSON.stringify({
      schemaVersion: 1,
      manifestHash,
      revision,
      provider: provider.id,
      model: provider.model,
      effort: provider.effort,
      caseId: sample.id,
      responsibility: sample.responsibility,
      language: sample.language,
      origin: sample.origin,
      inputHash: sample.inputHash,
      promptHash: sample.promptHash,
      rubricHash: sample.rubricHash,
      pass: !skipped,
      status: skipped ? 'infrastructure_failure' : 'pass',
      reason: skipped ? 'synthetic skipped provider' : 'synthetic pass',
      rawResponse: skipped ? '' : 'synthetic answer',
      judgment: {
        reason: skipped ? 'synthetic skipped provider' : 'synthetic pass',
        score: skipped ? 0 : 1,
        evidenceRequirement: 'synthetic',
        graderMetadata: null,
      },
      durationMs: 0,
    }));
  }
}

test('parses Kimi stream output without mixing tool events into the answer', () => {
  const stream = [
    { role: 'meta', type: 'system.version', version: kimiCliVersion },
    { role: 'assistant', tool_calls: [{ type: 'function', id: 'tool-1' }] },
    { role: 'tool', tool_call_id: 'tool-1', content: 'private fixture output' },
    { role: 'assistant', content: 'final answer' },
    { role: 'meta', type: 'session.resume_hint', session_id: 'session-test' },
  ].map(event => JSON.stringify(event)).join('\n');

  assert.equal(parseKimiAssistantOutput(stream), 'final answer');
  assert.deepEqual(parseKimiStdoutEvidence(stream), {
    cliVersion: kimiCliVersion,
    sessionId: 'session-test',
  });
});

test('parses candidate-only without changing the run positional arguments', () => {
  const parsed = parseCliArguments([
    'run',
    'baseline-source',
    'candidate-source',
    'output-directory',
    '--candidate-only',
  ]);
  assert.deepEqual(parsed.positional, [
    'run',
    'baseline-source',
    'candidate-source',
    'output-directory',
  ]);
  assert.equal(parsed.candidateOnly, true);
});

test('requires the session list and wire model evidence to identify K3/high', () => {
  const session = parseKimiSessionListOutput(JSON.stringify({
    id: 'session-test',
    sessionDir: '/tmp/kimi-session',
    lastTurnReason: 'completed',
  }));
  const wireRequest = {
    type: 'llm.request',
    provider: 'openai',
    model: actualModel,
    modelAlias: requestedModelAlias,
    thinkingEffort: 'high',
  };
  const wire = parseKimiWireEvidence([
    JSON.stringify(wireRequest),
    JSON.stringify(wireRequest),
  ].join('\n'));
  assert.equal(wire.requestCount, 2);
  assert.throws(
    () => parseKimiWireEvidence([
      JSON.stringify({
        type: 'llm.request',
        model: actualModel,
        modelAlias: requestedModelAlias,
        thinkingEffort: 'high',
      }),
      JSON.stringify({
        type: 'llm.request',
        model: 'wrong-model',
        modelAlias: requestedModelAlias,
        thinkingEffort: 'high',
      }),
    ].join('\n')),
    /non-k3\/high/i,
  );
  const provenance = validateKimiProvenance({
    cliVersion: kimiCliVersion,
    sessionId: 'session-test',
    sessionListSessionId: 'session-test',
    ...session,
    wire,
    endpointType: 'managed',
    wireSha256: 'wire-sha',
    stateSha256: 'state-sha',
  });
  assert.equal(provenance.wire.model, actualModel);
  assert.equal(validateKimiProvenance({
    cliVersion: kimiCliVersion,
    sessionId: 'session-test',
    sessionListSessionId: 'session-test',
    ...session,
    wire,
    endpointType: 'unknown',
    wireSha256: 'wire-sha',
    stateSha256: 'state-sha',
  }).endpointType, 'unknown');
  assert.throws(
    () => parseKimiSessionListOutput(JSON.stringify({
      sessionDir: '/tmp/kimi-session',
      lastTurnReason: 'completed',
    })),
    /session id/i,
  );
  assert.throws(
    () => validateKimiProvenance({
      cliVersion: kimiCliVersion,
      sessionId: 'session-test',
      sessionListSessionId: 'session-test',
      ...session,
      wire: { ...wire, model: 'wrong-model' },
      endpointType: 'managed',
      wireSha256: 'wire-sha',
      stateSha256: 'state-sha',
    }),
    /wire provenance/i,
  );
});

test('freezes both source prompts and rejects changed prompt or fixture artifacts', () => {
  const { cases, casesHash } = readCases(casesPath);
  const fixture = fixtureSnapshot();
  const samples = buildSamples(
    cases,
    casesHash,
    fixture,
    fixtureWorkspaceEvidence(),
    fixtureVerificationEvidence(),
  );
  const root = mkdtempSync(join(tmpdir(), 'takt-kimi-source-contract-'));
  const baseline = join(root, 'baseline');
  const candidate = join(root, 'candidate');
  try {
    const changedId = 'summary-limited-approval';
    const oldPrompt = samples.find(sample => sample.id === changedId).prompt + '\nold frozen prompt';
    writeSyntheticSource(baseline, 'baseline', samples, fixture, casesHash, { [changedId]: oldPrompt });
    writeSyntheticSource(candidate, 'candidate', samples, fixture, casesHash);

    const frozenBaseline = loadFrozenPhase(baseline, 'baseline', casesPath);
    const frozenCandidate = loadFrozenPhase(candidate, 'candidate', casesPath);
    assert.notEqual(
      frozenBaseline.samples.find(sample => sample.id === changedId).promptHash,
      frozenCandidate.samples.find(sample => sample.id === changedId).promptHash,
    );
    assert.equal(
      frozenBaseline.samples.find(sample => sample.id === changedId).inputHash,
      frozenCandidate.samples.find(sample => sample.id === changedId).inputHash,
    );

    const rowPath = join(candidate, 'rows', 'claude-opus-5--summary-limited-approval.json');
    const changedProviderRow = JSON.parse(readFileSync(rowPath, 'utf8'));
    changedProviderRow.provider = 'replacement-provider';
    writeFileSync(rowPath, JSON.stringify(changedProviderRow));
    assert.throws(() => loadFrozenPhase(candidate, 'candidate', casesPath), /unexpected provider/i);
    changedProviderRow.provider = 'claude-opus-5';
    writeFileSync(rowPath, JSON.stringify(changedProviderRow));
    changedProviderRow.model = 'replacement-model';
    writeFileSync(rowPath, JSON.stringify(changedProviderRow));
    assert.throws(() => loadFrozenPhase(candidate, 'candidate', casesPath), /metadata or hash/i);
    changedProviderRow.model = 'claude-opus-5';
    writeFileSync(rowPath, JSON.stringify(changedProviderRow));

    writeFileSync(join(baseline, 'prompts', changedId + '.md'), oldPrompt + '\nmutated');
    assert.throws(() => loadFrozenPhase(baseline, 'baseline', casesPath), /prompt hash/i);

    const changedManifest = JSON.parse(readFileSync(join(candidate, 'manifest.json'), 'utf8'));
    changedManifest.fixture.aggregateSha256 = 'changed-fixture';
    writeFileSync(join(candidate, 'manifest.json'), JSON.stringify(changedManifest, null, 2) + '\n');
    assert.throws(() => loadFrozenPhase(candidate, 'candidate', casesPath), /fixture differs/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('marks a thrown phase as infrastructure while preserving pure missing rows as unexecuted', () => {
  const sample = {
    id: 'synthetic-case',
    responsibility: 'summary',
    language: 'ja',
    origin: 'runtime-derived',
    inputHash: 'input-hash',
    promptHash: 'prompt-hash',
    rubricHash: 'rubric-hash',
  };
  const missingRows = rowsForPhase([], [sample], 'candidate', 'manifest-hash');
  assert.equal(missingRows[0].status, 'unexecuted');
  const failedRows = rowsForPhase([], [sample], 'candidate', 'manifest-hash', {
    status: 'infrastructure_failure',
    reason: 'Kimi promptfoo phase failed; private diagnostic saved',
    diagnosticPath: 'candidate.private-error.txt',
  });
  assert.equal(failedRows[0].status, 'infrastructure_failure');
  assert.equal(failedRows[0].reason, 'Kimi promptfoo phase failed; private diagnostic saved');
  assert.equal(evaluationExitCode(failedRows), 2);
});

test('requires rows for a skipped provider to stay infrastructure failures', () => {
  const { cases, casesHash } = readCases(casesPath);
  const fixture = fixtureSnapshot();
  const samples = buildSamples(
    cases,
    casesHash,
    fixture,
    fixtureWorkspaceEvidence(),
    fixtureVerificationEvidence(),
  );
  const root = mkdtempSync(join(tmpdir(), 'takt-kimi-skip-contract-'));
  try {
    writeSyntheticSource(root, 'baseline', samples, fixture, casesHash, {}, ['kimi-k3']);
    assert.equal(loadFrozenPhase(root, 'baseline', casesPath).samples.length, 10);
    const rowPath = join(root, 'rows', 'kimi-k3--summary-limited-approval.json');
    const row = JSON.parse(readFileSync(rowPath, 'utf8'));
    row.status = 'pass';
    row.pass = true;
    row.rawResponse = 'fabricated answer';
    writeFileSync(rowPath, JSON.stringify(row));
    assert.throws(() => loadFrozenPhase(root, 'baseline', casesPath), /skipped provider row/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects paired sources with different baseline lineage or execution metadata', () => {
  const { cases, casesHash } = readCases(casesPath);
  const fixture = fixtureSnapshot();
  const samples = buildSamples(
    cases,
    casesHash,
    fixture,
    fixtureWorkspaceEvidence(),
    fixtureVerificationEvidence(),
  );
  const root = mkdtempSync(join(tmpdir(), 'takt-kimi-pair-contract-'));
  const baselineDirectory = join(root, 'baseline');
  const candidateDirectory = join(root, 'candidate');
  try {
    writeSyntheticSource(baselineDirectory, 'baseline', samples, fixture, casesHash);
    writeSyntheticSource(candidateDirectory, 'candidate', samples, fixture, casesHash);
    const baseline = loadFrozenPhase(baselineDirectory, 'baseline', casesPath);
    const candidate = loadFrozenPhase(candidateDirectory, 'candidate', casesPath);
    assert.equal(validatePairedSources(baseline, candidate), true);
    assert.throws(
      () => validatePairedSources(baseline.manifest, {
        ...candidate.manifest,
        baselineRevision: 'different-revision',
      }),
      /baselineRevision/i,
    );
    assert.throws(
      () => validatePairedSources(baseline.manifest, {
        ...candidate.manifest,
        providers: candidate.manifest.providers.map(provider => provider.id === 'gpt-5.6-sol-high'
          ? { ...provider, model: 'replacement-model' }
          : provider),
      }),
      /provider definitions/i,
    );
    assert.throws(
      () => validatePairedSources(baseline.manifest, {
        ...candidate.manifest,
        providerSelection: {
          executed: ['claude-opus-5', 'gpt-5.6-luna-max', 'kimi-k3'],
          skipped: [{
            id: 'gpt-5.6-sol-high',
            reason: 'synthetic alternate selection',
          }],
        },
      }),
      /provider selections/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('validates candidate-only phase shape and hashes at the rescore boundary', () => {
  const { cases, casesHash } = readCases(casesPath);
  const fixture = fixtureSnapshot();
  const samples = buildSamples(
    cases,
    casesHash,
    fixture,
    fixtureWorkspaceEvidence(),
    fixtureVerificationEvidence(),
  );
  const root = mkdtempSync(join(tmpdir(), 'takt-kimi-rescore-contract-'));
  const manifest = {
    schemaVersion: 1,
    phaseOrder: ['candidate'],
    expectedRows: 10,
    providers: [{ id: providerId }],
    samples: samples.map(sample => ({
      phase: 'candidate',
      id: sample.id,
      inputHash: sample.inputHash,
      promptHash: sample.promptHash,
      rubricHash: sample.rubricHash,
    })),
  };
  const manifestHash = hash(JSON.stringify(manifest));
  try {
    mkdirSync(join(root, 'rows'));
    writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest));
    for (const sample of samples) {
      writeFileSync(join(root, 'rows', `${providerId}--candidate--${sample.id}.json`), JSON.stringify({
        manifestHash,
        provider: providerId,
        revision: 'candidate',
        caseId: sample.id,
        inputHash: sample.inputHash,
        promptHash: sample.promptHash,
        rubricHash: sample.rubricHash,
      }));
    }

    assert.deepEqual(phasePlanFromManifest(manifest), ['candidate']);
    assert.equal(validateSavedKimiOutput(root, manifest).length, 10);

    const wrongPhaseManifest = { ...manifest, phaseOrder: ['baseline'] };
    assert.throws(() => phasePlanFromManifest(wrongPhaseManifest), /phase order/i);

    const changedRowPath = join(root, 'rows', `${providerId}--candidate--${samples[0].id}.json`);
    const changedRow = JSON.parse(readFileSync(changedRowPath, 'utf8'));
    changedRow.promptHash = 'changed-prompt-hash';
    writeFileSync(changedRowPath, JSON.stringify(changedRow));
    assert.throws(() => validateSavedKimiOutput(root, manifest), /hash differs/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('keeps provider failures separate from model assertion failures', () => {
  const modelFailure = classifyResult({
    response: { output: 'answer' },
    gradingResult: { componentResults: [{ score: 0, reason: 'rubric mismatch' }] },
    success: false,
  });
  const infrastructureFailure = classifyResult({
    response: { error: 'Kimi provenance unavailable' },
    failureReason: 2,
    success: false,
  });

  assert.equal(modelFailure.status, 'model_failure');
  assert.equal(infrastructureFailure.status, 'infrastructure_failure');
  assert.equal(evaluationExitCode([{ revision: 'baseline', status: 'model_failure' }]), 0);
  assert.equal(evaluationExitCode([{ revision: 'candidate', status: 'model_failure' }]), 1);
  assert.equal(evaluationExitCode([{ revision: 'baseline', status: 'infrastructure_failure' }]), 2);
  assert.equal(providerId, 'kimi-code-cli-k3');
});
