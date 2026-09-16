import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  assertRescoreFixtureMatches,
  buildSamples,
  classifyResult,
  fixtureSnapshot,
  fixtureWorkspaceEvidence,
  fixtureVerificationEvidence,
  manifestFor,
  providerSelectionFor,
  providers,
  readCases,
  validateSavedPromptHashes,
  validateSavedRowHashes,
} from '../scripts/instruction-research-handoff-eval.mjs';
import { buildSemanticRubric } from './instruction-research-handoff-rubric.mjs';
import { scoreTransition } from './completion-routing.mjs';

const casesPath = new URL('../cases/instruction-research-handoff.yaml', import.meta.url);

test('freezes ten role-specific cases and the exact four-model matrix', () => {
  const { cases, casesHash } = readCases(casesPath);
  assert.equal(cases.length, 10);
  assert.equal(cases.filter(sample => sample.responsibility === 'summary').length, 5);
  assert.equal(cases.filter(sample => sample.responsibility !== 'summary').length, 5);
  assert.deepEqual(providers.map(provider => [provider.cli, provider.model, provider.effort]), [
    ['claude', 'claude-opus-5', null],
    ['codex', 'gpt-5.6-sol', 'high'],
    ['codex', 'gpt-5.6-luna', 'max'],
    ['opencode', 'moonshotai/kimi-k3', null],
  ]);
  assert.match(casesHash, /^[a-f0-9]{64}$/);
});

test('pins every fixture file in the baseline manifest', () => {
  const { cases, casesHash } = readCases(casesPath);
  const samples = buildSamples(cases, casesHash);
  const manifest = manifestFor('test-revision', casesHash, samples);
  const paths = manifest.fixture.files.map(file => file.path);

  assert.ok(paths.includes('src/sdk-adapter.js'));
  assert.ok(paths.includes('tests/settings.test.js'));
  assert.match(manifest.fixture.aggregateSha256, /^[a-f0-9]{64}$/);
  assert.equal(
    manifest.fixture.aggregateSha256,
    createHash('sha256').update(JSON.stringify(manifest.fixture.files)).digest('hex'),
  );
});

test('rejects a saved prompt or fixture mismatch during offline rescoring', () => {
  const { cases, casesHash } = readCases(casesPath);
  const fixture = fixtureSnapshot();
  const samples = buildSamples(cases, casesHash, fixture);
  const manifest = manifestFor('test-revision', casesHash, samples, fixture);
  const savedPrompts = new Map(samples.map(sample => [sample.id, sample.prompt]));

  assert.doesNotThrow(() => validateSavedPromptHashes(manifest, savedPrompts, samples));
  const changedPrompts = new Map(savedPrompts);
  changedPrompts.set('summary-unconfirmed-method', savedPrompts.get('summary-unconfirmed-method') + '\nchanged');
  assert.throws(
    () => validateSavedPromptHashes(manifest, changedPrompts, samples),
    /prompt hash does not match/i,
  );
  assert.throws(
    () => assertRescoreFixtureMatches({ fixture: { files: [], aggregateSha256: 'changed' } }, fixture),
    /fixture differs/i,
  );
  const savedRow = [{
    caseId: samples[0].id,
    inputHash: manifest.samples[0].inputHash,
    promptHash: manifest.samples[0].promptHash,
  }];
  assert.doesNotThrow(() => validateSavedRowHashes(manifest, savedRow));
  assert.throws(
    () => validateSavedRowHashes(manifest, [{ ...savedRow[0], promptHash: 'changed' }]),
    /row hash differs/i,
  );
});

test('records an unavailable provider without substituting another model', () => {
  const selected = providerSelectionFor(['kimi-k3']);

  assert.deepEqual(selected.executed, [
    'claude-opus-5',
    'gpt-5.6-sol-high',
    'gpt-5.6-luna-max',
  ]);
  assert.deepEqual(selected.skipped.map(provider => provider.id), ['kimi-k3']);
  assert.match(selected.skipped[0].reason, /no replacement model/i);
});

test('keeps the limited approval as a short user OK after the assistant question', () => {
  const { cases } = readCases(casesPath);
  const sample = cases.find(candidate => candidate.id === 'summary-limited-approval');
  assert.ok(sample);
  assert.equal(sample.history.at(-2).role, 'user');
  assert.equal(sample.history.at(-2).content, 'OK');
  assert.match(sample.history[0].content, /--profile/);
  assert.match(sample.history[1].content, /実 API は使わず/);
  assert.deepEqual(sample.rubric.checks, [
    'preserve_goal',
    'preserve_profile_request',
    'preserve_limited_ok',
    'classify_candidate',
    'no_candidate_promotion',
    'no_scope_expansion',
  ]);
});

test('keeps semantic rubric and generation prompt on separate sides of the harness', () => {
  const { cases, casesHash } = readCases(casesPath);
  const fixture = fixtureSnapshot();
  const workspaceFiles = fixtureWorkspaceEvidence();
  const verificationEvidence = fixtureVerificationEvidence();
  const samples = buildSamples(cases, casesHash, fixture, workspaceFiles, verificationEvidence);
  for (const sample of samples.filter(candidate => candidate.responsibility !== 'judge')) {
    assert.equal(sample.prompt.includes('no_candidate_promotion'), false, sample.id);
    assert.equal(sample.prompt.includes('fixed semantic judge'), false, sample.id);
    assert.equal(
      sample.rubricHash,
      createHash('sha256').update(buildSemanticRubric(sample, {
        workspaceFiles,
        verificationEvidence,
      })).digest('hex'),
    );
    assert.match(sample.semanticRubric, /Source context \(judge-only fixture\)/);
    assert.match(sample.semanticRubric, /WORKSPACE EVIDENCE/);
    assert.match(sample.semanticRubric, /CONTENT:/);
    assert.match(sample.semanticRubric, /VERIFIED WORKSPACE COMMANDS/);
    assert.match(sample.semanticRubric, /exact evidence quotes/i);
  }
});

test('wires the authority and limited-approval rules into both summary prompt languages', () => {
  const { cases, casesHash } = readCases(casesPath);
  const samples = buildSamples(cases, casesHash);
  const japanese = samples.find(sample => sample.id === 'summary-unconfirmed-method');
  const english = samples.find(sample => sample.id === 'summary-explicit-method-adoption');

  assert.ok(japanese);
  assert.ok(english);
  assert.match(japanese.prompt, /会話の出所と了承の範囲/);
  assert.match(japanese.prompt, /直前のアシスタントの質問/);
  assert.match(japanese.prompt, /アシスタントの提案や推測/);
  assert.match(japanese.prompt, /ワークスペースを実際に調査/);
  assert.match(english.prompt, /Conversation authority and approval scope/);
  assert.match(english.prompt, /immediately preceding assistant question/);
  assert.match(english.prompt, /assistant proposal or guess/);
  assert.match(english.prompt, /workspace inspection/);
});

test('retains positive and negative route controls for the initial plan rule', () => {
  const { cases, casesHash } = readCases(casesPath);
  const sample = buildSamples(cases, casesHash).find(candidate => candidate.id === 'judge-initial-local-investigation');
  assert.ok(sample);
  assert.equal(scoreTransition('[PLAN:1]', sample.routeStep, sample.expected_transition).pass, true);
  assert.equal(scoreTransition('[PLAN:3]', sample.routeStep, sample.expected_transition).pass, false);
  assert.equal(scoreTransition('The evidence is inconclusive.', sample.routeStep, sample.expected_transition).pass, false);
});

test('semantic controls state both adoption and confirmed contradiction', () => {
  const { cases } = readCases(casesPath);
  const adopted = cases.find(sample => sample.id === 'summary-explicit-method-adoption');
  const contradiction = cases.find(sample => sample.id === 'plan-confirmed-method-contradiction');
  assert.ok(adopted);
  assert.ok(contradiction);
  assert.match(buildSemanticRubric(adopted), /explicitly selected/);
  assert.match(buildSemanticRubric(contradiction), /incompatible public requirements/);
  assert.match(buildSemanticRubric(contradiction), /confirmed external constraint/);
});

test('separates assertion failures from provider and grader infrastructure failures', () => {
  const assertionFailure = classifyResult({
    response: { output: 'The generated plan' },
    error: 'Expected output to satisfy the rubric',
    failureReason: 1,
    gradingResult: {
      componentResults: [{ score: 0, reason: 'The output omitted a required handoff.' }],
    },
    success: false,
  });
  assert.equal(assertionFailure.status, 'model_failure');
  assert.equal(assertionFailure.infrastructureFailure, false);

  const providerFailure = classifyResult({
    response: { error: 'provider authentication failed' },
    error: 'provider authentication failed',
    failureReason: 2,
    success: false,
  });
  assert.equal(providerFailure.status, 'infrastructure_failure');
  assert.equal(providerFailure.infrastructureFailure, true);

  const graderFailure = classifyResult({
    response: { output: 'The generated plan' },
    error: 'grader failed',
    failureReason: 1,
    gradingResult: {
      componentResults: [{ metadata: { graderError: true } }],
    },
    success: false,
  });
  assert.equal(graderFailure.status, 'infrastructure_failure');
  assert.equal(graderFailure.infrastructureFailure, true);
});
