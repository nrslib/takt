#!/usr/bin/env node
/**
 * Supplement the instruction-research handoff matrix with Kimi Code CLI.
 *
 * The four-provider runner deliberately keeps the failed opencode route. This
 * runner reads its frozen baseline/candidate prompt artifacts and evaluates
 * only the replacement Kimi Code CLI route.
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertRescoreFixtureMatches,
  buildSamples,
  classifyResult,
  fixtureSnapshot,
  fixtureVerificationEvidence,
  fixtureWorkspaceEvidence,
  readCases,
  runPromptfooEvaluation,
  validateSavedPromptHashes,
  validateSavedRowHashes,
} from './instruction-research-handoff-eval.mjs';
import { parseKimiAssistantOutput } from './development-loop-eval.mjs';
import { createIsolatedWorkingDirectory, runProcess } from '../providers/cli-review.mjs';

process.env.PROMPTFOO_DISABLE_TELEMETRY = 'true';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const defaultCasesPath = join(repoRoot, 'eval/cases/instruction-research-handoff.yaml');
const fixtureDirectory = join(repoRoot, 'eval/fixtures/instruction-research-handoff');
const configuredRouteProvenancePath = process.env.TAKT_KIMI_ROUTE_PROVENANCE;
const kimiCliPath = process.env.TAKT_EVAL_KIMI_BIN ?? 'kimi';
const kimiCliVersion = '0.43.1';
const requestedModelAlias = 'kimi-code/k3';
const actualModel = 'k3';
const thinkingEffort = 'high';
const providerId = 'kimi-code-cli-k3';
const providerLabel = 'KimiCodeCLI K3/high補足';
const phaseNames = Object.freeze(['baseline', 'candidate']);

const kimiProvider = Object.freeze({
  id: providerId,
  cli: kimiCliPath,
  model: actualModel,
  effort: thinkingEffort,
  label: providerLabel,
  requestedAlias: requestedModelAlias,
  cliVersion: kimiCliVersion,
  endpointType: 'unknown',
  auto: false,
});

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function writeNewJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  chmodSync(path, 0o600);
}

function writePrivateNew(path, value) {
  writeFileSync(path, value, { mode: 0o600, flag: 'wx' });
  chmodSync(path, 0o600);
}

function requireString(value, description) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(description + ' is missing');
  }
  return value;
}

function sourceRows(directory) {
  const rowsDirectory = join(directory, 'rows');
  if (!existsSync(rowsDirectory)) throw new Error('Saved source rows directory is missing: ' + rowsDirectory);
  return readdirSync(rowsDirectory)
    .filter(name => name.endsWith('.json'))
    .sort()
    .map(name => JSON.parse(readFileSync(join(rowsDirectory, name), 'utf8')));
}

const sourceProviderDefinitions = Object.freeze([
  { id: 'claude-opus-5', cli: 'claude', model: 'claude-opus-5', effort: null, label: 'claude-opus-5' },
  { id: 'gpt-5.6-sol-high', cli: 'codex', model: 'gpt-5.6-sol', effort: 'high', label: 'gpt-5.6-sol/high' },
  { id: 'gpt-5.6-luna-max', cli: 'codex', model: 'gpt-5.6-luna', effort: 'max', label: 'gpt-5.6-luna/max' },
  { id: 'kimi-k3', cli: 'opencode', model: 'moonshotai/kimi-k3', effort: null, label: 'moonshotai/kimi-k3' },
]);
const sourceProviderIds = Object.freeze(sourceProviderDefinitions.map(provider => provider.id));
const sourceProviderDefinitionById = new Map(
  sourceProviderDefinitions.map(provider => [provider.id, provider]),
);

function sourceSampleMap(manifest) {
  if (!Array.isArray(manifest.samples) || manifest.samples.length !== 10) {
    throw new Error('Saved source manifest must contain exactly 10 samples');
  }
  const samples = new Map();
  for (const sample of manifest.samples) {
    if (typeof sample?.id !== 'string' || samples.has(sample.id)) {
      throw new Error('Saved source manifest has an invalid or duplicate sample id');
    }
    samples.set(sample.id, sample);
  }
  return samples;
}

function validateProviderSelection(manifest) {
  const selection = manifest.providerSelection;
  if (selection === null || typeof selection !== 'object'
    || !Array.isArray(selection.executed) || !Array.isArray(selection.skipped)) {
    throw new Error('Saved source providerSelection is missing executed/skipped lists');
  }
  const executed = selection.executed;
  const skipped = selection.skipped;
  const skippedIds = skipped.map(entry => entry?.id);
  const allIds = [...executed, ...skippedIds];
  if (executed.some(id => typeof id !== 'string')
    || skipped.some(entry => typeof entry?.id !== 'string' || typeof entry.reason !== 'string'
      || entry.reason.length === 0)
    || new Set(allIds).size !== allIds.length
    || allIds.length !== sourceProviderDefinitions.length
    || sourceProviderDefinitions.some(provider => !allIds.includes(provider.id))) {
    throw new Error('Saved source providerSelection does not cover the fixed providers exactly once');
  }
  if (executed.length === 0) throw new Error('Saved source providerSelection has no executed provider');
  return {
    executed: new Set(executed),
    skipped: new Map(skipped.map(entry => [entry.id, entry])),
  };
}

function expectedSourceRevision(manifest) {
  return manifest.sourceRevision
    ?? (manifest.candidatePromptHashes === undefined ? 'baseline' : 'candidate');
}

function expectedRowRevision(manifest, phase) {
  const sourceRevision = expectedSourceRevision(manifest);
  const revision = manifest.revision ?? sourceRevision;
  if (manifest.revision !== undefined && manifest.revision !== `${sourceRevision}-rescored`) {
    throw new Error('Saved source manifest has an invalid row revision: ' + String(manifest.revision));
  }
  if (sourceRevision !== phase) {
    throw new Error('Saved source has wrong revision for ' + phase + ': ' + String(sourceRevision));
  }
  return revision;
}

export function validateSourceRows(manifest, rows, phase = expectedSourceRevision(manifest)) {
  const savedSamples = sourceSampleMap(manifest);
  const savedProviders = Array.isArray(manifest.providers) ? manifest.providers : [];
  if (JSON.stringify(savedProviders) !== JSON.stringify(sourceProviderDefinitions)) {
    throw new Error('Saved source manifest provider definitions differ from the fixed matrix');
  }
  const providerSelection = validateProviderSelection(manifest);
  const expectedRevision = expectedRowRevision(manifest, phase);
  const expectedManifestHash = digest(JSON.stringify(manifest));
  const expected = sourceProviderIds.length * savedSamples.size;
  if (rows.length !== expected) {
    throw new Error('Saved source rows are incomplete: expected ' + expected + ', received ' + rows.length);
  }
  const rowKeys = new Set();
  for (const row of rows) {
    if (!sourceProviderIds.includes(row.provider)) {
      throw new Error('Saved source row has an unexpected provider ' + String(row.provider));
    }
    const sample = savedSamples.get(row.caseId);
    if (sample === undefined) throw new Error('Saved source row has unknown case ' + String(row.caseId));
    const key = String(row.provider) + '--' + row.caseId;
    if (rowKeys.has(key)) throw new Error('Saved source rows contain duplicate ' + key);
    rowKeys.add(key);
    const provider = sourceProviderDefinitionById.get(row.provider);
    if (row.schemaVersion !== 1
      || row.manifestHash !== expectedManifestHash
      || row.revision !== expectedRevision
      || row.model !== provider.model
      || row.effort !== provider.effort
      || row.responsibility !== sample.responsibility
      || row.language !== sample.language
      || row.origin !== sample.origin
      || row.inputHash !== sample.inputHash
      || row.promptHash !== sample.promptHash
      || row.rubricHash !== sample.rubricHash) {
      throw new Error('Saved source row metadata or hash differs from its manifest for ' + key);
    }
    if (providerSelection.skipped.has(row.provider)
      && (row.status !== 'infrastructure_failure' || row.pass !== false || row.rawResponse !== '')) {
      throw new Error('Saved source skipped provider row must be infrastructure_failure for ' + key);
    }
  }
  for (const providerId of sourceProviderIds) {
    for (const sampleId of savedSamples.keys()) {
      const key = providerId + '--' + sampleId;
      if (!rowKeys.has(key)) throw new Error('Saved source rows are missing ' + key);
    }
  }
  validateSavedRowHashes(manifest, rows);
  return rows;
}

function readSavedPromptAndRubric(directory, manifest, currentSamples) {
  const savedPrompts = new Map();
  for (const sample of currentSamples) {
    const path = join(directory, 'prompts', sample.id + '.md');
    if (!existsSync(path)) throw new Error('Saved source prompt is missing: ' + path);
    savedPrompts.set(sample.id, readFileSync(path, 'utf8'));
  }
  validateSavedPromptHashes(manifest, savedPrompts, currentSamples);

  const manifestSamples = sourceSampleMap(manifest);
  return currentSamples.map(sample => {
    const savedManifestSample = manifestSamples.get(sample.id);
    const prompt = savedPrompts.get(sample.id);
    if (savedManifestSample === undefined || prompt === undefined) {
      throw new Error('Saved source is missing sample ' + sample.id);
    }
    if (sample.inputHash !== savedManifestSample.inputHash) {
      throw new Error('Saved source input differs from current fixed case for ' + sample.id);
    }
    if (JSON.stringify(sample.rubric.checks) !== JSON.stringify(savedManifestSample.rubricChecks)) {
      throw new Error('Saved source rubric checks differ from current fixed case for ' + sample.id);
    }
    if (sample.responsibility === 'judge') {
      if (savedManifestSample.rubricHash !== null) {
        throw new Error('Judge case unexpectedly has a semantic rubric hash for ' + sample.id);
      }
      return {
        ...sample,
        prompt,
        promptHash: digest(prompt),
        rubricHash: null,
        semanticRubric: null,
      };
    }

    const rubricPath = join(directory, 'rubrics', sample.id + '.md');
    if (!existsSync(rubricPath)) throw new Error('Saved source rubric is missing: ' + rubricPath);
    const semanticRubric = readFileSync(rubricPath, 'utf8');
    if (digest(semanticRubric) !== savedManifestSample.rubricHash) {
      throw new Error('Saved source rubric hash does not match its manifest for ' + sample.id);
    }
    if (sample.rubricHash !== savedManifestSample.rubricHash) {
      throw new Error('Saved source rubric differs from current rubric for ' + sample.id);
    }
    return {
      ...sample,
      prompt,
      promptHash: digest(prompt),
      semanticRubric,
      rubricHash: digest(semanticRubric),
    };
  });
}

function validateSavedSource(directory, phase, context) {
  const manifestPath = join(directory, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error('Saved source manifest is missing: ' + manifestPath);
  const manifestText = readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(manifestText);
  if (manifest.schemaVersion !== 2) throw new Error('Unsupported saved source manifest schema');
  if (manifest.casesHash !== context.casesHash) {
    throw new Error('Saved source cases differ from current fixed cases for ' + phase);
  }
  const sourceRevision = expectedSourceRevision(manifest);
  if (sourceRevision !== phase) {
    throw new Error('Saved source has wrong revision for ' + phase + ': ' + String(sourceRevision));
  }
  if (typeof manifest.baselineRevision !== 'string' || manifest.baselineRevision.length === 0) {
    throw new Error('Saved source baselineRevision is missing');
  }
  assertRescoreFixtureMatches(manifest, context.fixture);

  const frozenSamples = readSavedPromptAndRubric(directory, manifest, context.samples);
  validateSourceRows(manifest, sourceRows(directory), phase);
  return {
    phase,
    directory: resolve(directory),
    manifest,
    manifestText,
    manifestSha256: digest(manifestText),
    samples: frozenSamples,
  };
}

function sourceManifest(value) {
  return value?.manifest ?? value;
}

export function validatePairedSources(baseline, candidate) {
  const baselineManifest = sourceManifest(baseline);
  const candidateManifest = sourceManifest(candidate);
  if (expectedSourceRevision(baselineManifest) !== 'baseline'
    || expectedSourceRevision(candidateManifest) !== 'candidate') {
    throw new Error('Paired sources must contain baseline followed by candidate');
  }
  if (typeof baselineManifest.baselineRevision !== 'string'
    || baselineManifest.baselineRevision !== candidateManifest.baselineRevision) {
    throw new Error('Paired sources have different baselineRevision values');
  }
  if (JSON.stringify(baselineManifest.providers) !== JSON.stringify(candidateManifest.providers)) {
    throw new Error('Paired sources have different provider definitions');
  }
  if (JSON.stringify(baselineManifest.providerSelection)
    !== JSON.stringify(candidateManifest.providerSelection)) {
    throw new Error('Paired sources have different provider selections');
  }
  return true;
}

function validationContext(casesPath) {
  const { cases, casesHash } = readCases(casesPath);
  const fixture = fixtureSnapshot();
  const samples = buildSamples(
    cases,
    casesHash,
    fixture,
    fixtureWorkspaceEvidence(),
    fixtureVerificationEvidence(),
  );
  return { cases, casesHash, fixture, samples };
}

export function loadFrozenPhase(directory, phase, casesPath = defaultCasesPath) {
  return validateSavedSource(resolve(directory), phase, validationContext(casesPath));
}

export function parseKimiStdoutEvidence(jsonl) {
  let cliVersion;
  let sessionId;
  for (const line of jsonl.split(/\r?\n/).filter(line => line.trim())) {
    const event = JSON.parse(line);
    if (event.role !== 'meta') continue;
    if (event.type === 'system.version') {
      cliVersion = event.version ?? event.data?.version ?? event.content?.version;
    }
    if (event.type === 'session.resume_hint') {
      sessionId = event.session_id ?? event.sessionId ?? event.data?.session_id ?? event.data?.sessionId;
    }
  }
  return {
    cliVersion: requireString(cliVersion, 'Kimi system.version'),
    sessionId: requireString(sessionId, 'Kimi session.resume_hint session_id'),
  };
}

export function parseKimiSessionListOutput(json) {
  const parsed = JSON.parse(json);
  const entries = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.sessions)
      ? parsed.sessions
      : Array.isArray(parsed.items)
        ? parsed.items
        : [parsed];
  const entry = entries[0];
  if (entry === undefined || entry === null || typeof entry !== 'object') {
    throw new Error('Kimi session list returned no session');
  }
  return {
    sessionId: requireString(entry.id ?? entry.sessionId ?? entry.session_id, 'Kimi session id'),
    sessionDir: requireString(entry.sessionDir ?? entry.session_dir, 'Kimi sessionDir'),
    lastTurnReason: requireString(entry.lastTurnReason ?? entry.last_turn_reason, 'Kimi lastTurnReason'),
  };
}

export function parseKimiWireEvidence(jsonl) {
  const requests = [];
  for (const line of jsonl.split(/\r?\n/).filter(line => line.trim())) {
    const event = JSON.parse(line);
    if (event.type === 'llm.request') requests.push(event);
  }
  if (requests.length === 0) throw new Error('Kimi wire.jsonl has no llm.request event');
  const invalidRequest = requests.find(request => request.model !== actualModel
    || (request.modelAlias ?? request.model_alias) !== requestedModelAlias
    || (request.thinkingEffort ?? request.thinking_effort) !== thinkingEffort);
  if (invalidRequest !== undefined) {
    throw new Error('Kimi wire provenance has a non-k3/high llm.request');
  }
  const request = requests.at(-1);
  return {
    requestCount: requests.length,
    provider: request.provider ?? null,
    model: requireString(request.model, 'Kimi wire llm.request model'),
    modelAlias: requireString(request.modelAlias ?? request.model_alias, 'Kimi wire llm.request modelAlias'),
    thinkingEffort: requireString(
      request.thinkingEffort ?? request.thinking_effort,
      'Kimi wire llm.request thinkingEffort',
    ),
  };
}

export function validateKimiProvenance(provenance) {
  if (provenance.cliVersion !== kimiCliVersion) {
    throw new Error('Kimi CLI version evidence differs: ' + String(provenance.cliVersion));
  }
  if (provenance.wire?.model !== actualModel
    || provenance.wire?.modelAlias !== requestedModelAlias
    || provenance.wire?.thinkingEffort !== thinkingEffort) {
    throw new Error('Kimi wire provenance does not match k3/high');
  }
  if (!['managed', 'unknown'].includes(provenance.endpointType)) {
    throw new Error('Kimi endpoint provenance is missing or invalid');
  }
  if (provenance.lastTurnReason !== 'completed') {
    throw new Error('Kimi session did not complete: ' + String(provenance.lastTurnReason));
  }
  requireString(provenance.sessionListSessionId, 'Kimi session list session id');
  if (provenance.sessionListSessionId !== provenance.sessionId) {
    throw new Error('Kimi stdout and session list session IDs differ');
  }
  requireString(provenance.sessionId, 'Kimi session id');
  requireString(provenance.sessionDir, 'Kimi sessionDir');
  requireString(provenance.lastTurnReason, 'Kimi lastTurnReason');
  requireString(provenance.wireSha256, 'Kimi wire SHA-256');
  requireString(provenance.stateSha256, 'Kimi state SHA-256');
  return provenance;
}

function readRouteProvenance(path) {
  if (!existsSync(path)) throw new Error('Kimi route provenance is missing: ' + path);
  const text = readFileSync(path, 'utf8');
  const probe = JSON.parse(text);
  if (probe.cliVersion !== kimiCliVersion || probe.requestedAlias !== requestedModelAlias) {
    throw new Error('Kimi route provenance version or requested alias differs');
  }
  if (probe.healthCheck?.exitCode !== 0) throw new Error('Kimi route provenance health check failed');
  const requests = (Array.isArray(probe.wireModelEvents) ? probe.wireModelEvents : [])
    .filter(event => event.type === 'llm.request');
  if (requests.length === 0 || requests.some(request => request.model !== actualModel
    || (request.modelAlias ?? request.model_alias) !== requestedModelAlias
    || (request.thinkingEffort ?? request.thinking_effort) !== thinkingEffort)) {
    throw new Error('Kimi route provenance wire model differs');
  }
  const request = requests.at(-1);
  const managedConfig = JSON.stringify(probe.safeConfig ?? {});
  if (typeof probe.managedEndpoint !== 'string' || !managedConfig.includes('managed:kimi-code')) {
    throw new Error('Kimi route provenance is not a managed endpoint');
  }
  return {
    source: resolve(path),
    fileSha256: digest(text),
    cliVersion: probe.cliVersion,
    requestedAlias: probe.requestedAlias,
    model: request.model,
    thinkingEffort: request.thinkingEffort,
    endpointType: 'managed',
    healthCheck: 'passed',
  };
}

function unknownRouteProvenance() {
  return {
    source: null,
    fileSha256: null,
    cliVersion: null,
    requestedAlias: null,
    model: null,
    thinkingEffort: null,
    endpointType: 'unknown',
    healthCheck: 'not-provided',
  };
}

function resolveRouteProvenance(path) {
  return path === undefined || path === null ? unknownRouteProvenance() : readRouteProvenance(path);
}

function sessionDirectoryPath(sessionDir, cwd) {
  return sessionDir.startsWith('/') ? sessionDir : resolve(cwd, sessionDir);
}

async function callKimiCli({ phase, sample, outputDirectory, provenanceEntries, endpointType, abortSignal }) {
  const isolated = createIsolatedWorkingDirectory(fixtureDirectory);
  const cwd = realpathSync(isolated.cwd);
  const started = Date.now();
  const rawDirectory = join(outputDirectory, 'raw', phase);
  const rawPath = join(rawDirectory, sample.id + '.stdout');
  const errorPath = join(rawDirectory, sample.id + '.private-error.txt');
  mkdirSync(rawDirectory, { recursive: true });
  let validatedProvenance;
  try {
    const skillsDirectory = join(cwd, '.empty-skills');
    mkdirSync(skillsDirectory);
    const prompt = sample.prompt.replaceAll('/eval/project', cwd);
    const args = [
      '-m', requestedModelAlias,
      '--skills-dir', skillsDirectory,
      '--output-format', 'stream-json',
      '-p', prompt,
    ];
    const raw = await runProcess(kimiCliPath, args, {
      cwd,
      input: '',
      timeoutMs: 900_000,
      abortSignal,
    });
    // Preserve the provider stream before parsing or invoking the judge.
    writePrivateNew(rawPath, raw);

    const sessionListRaw = await runProcess(kimiCliPath, [
      'session', 'list', '--cwd', cwd, '--json', '--limit', '1',
    ], { cwd, input: '', timeoutMs: 60_000, abortSignal });
    const session = parseKimiSessionListOutput(sessionListRaw);
    const sessionDir = sessionDirectoryPath(session.sessionDir, cwd);
    const wirePath = join(sessionDir, 'agents', 'main', 'wire.jsonl');
    const statePath = join(sessionDir, 'state.json');
    if (!existsSync(wirePath)) throw new Error('Kimi wire.jsonl is missing: ' + wirePath);
    if (!existsSync(statePath)) throw new Error('Kimi state.json is missing: ' + statePath);
    const wireBytes = readFileSync(wirePath);
    const stateBytes = readFileSync(statePath);
    const wire = parseKimiWireEvidence(wireBytes.toString('utf8'));
    const stdout = parseKimiStdoutEvidence(raw);
    validatedProvenance = validateKimiProvenance({
      ...session,
      ...stdout,
      sessionListSessionId: session.sessionId,
      wire,
      endpointType,
      requestedAlias: requestedModelAlias,
      actualModel,
      thinkingEffort,
      auto: false,
      wireSha256: digest(wireBytes),
      stateSha256: digest(stateBytes),
      rawStdoutSha256: digest(raw),
      rawStdoutPath: relative(outputDirectory, rawPath),
      durationMs: Date.now() - started,
    });
    const output = parseKimiAssistantOutput(raw);
    provenanceEntries.push({ phase, caseId: sample.id, ...validatedProvenance });
    return { output };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!existsSync(errorPath)) writePrivateNew(errorPath, message);
    provenanceEntries.push({
      ...(validatedProvenance ?? {}),
      phase,
      caseId: sample.id,
      status: 'infrastructure_failure',
      error: 'Kimi CLI execution or provenance validation failed; private diagnostic saved',
      rawStdoutPath: existsSync(rawPath) ? relative(outputDirectory, rawPath) : null,
      durationMs: Date.now() - started,
    });
    return { error: 'Kimi CLI execution or provenance validation failed; private diagnostic saved' };
  } finally {
    isolated.cleanup();
  }
}

function createKimiProvider(phase, samples, outputDirectory, provenanceEntries, endpointType, abortSignal) {
  const samplesById = new Map(samples.map(sample => [sample.id, sample]));
  return {
    id: () => 'instruction-research-handoff:' + providerId,
    label: providerLabel,
    config: { ...kimiProvider, endpointType, maxRetries: 0 },
    callApi: async (_prompt, context = {}) => {
      const caseId = String(context.vars?.caseId ?? '');
      const sample = samplesById.get(caseId);
      if (sample === undefined) {
        return { error: 'Unknown Kimi evaluation case ' + caseId };
      }
      return callKimiCli({ phase, sample, outputDirectory, provenanceEntries, endpointType, abortSignal });
    },
  };
}

function rowFromResult(result, sample, phase, manifestHash) {
  const classified = classifyResult(result);
  return {
    schemaVersion: 1,
    manifestHash,
    revision: phase,
    provider: providerId,
    model: actualModel,
    effort: thinkingEffort,
    caseId: sample.id,
    responsibility: sample.responsibility,
    language: sample.language,
    origin: sample.origin,
    inputHash: sample.inputHash,
    promptHash: sample.promptHash,
    rubricHash: sample.rubricHash,
    pass: classified.status === 'pass',
    status: classified.status,
    reason: classified.reason,
    rawResponse: classified.output,
    judgment: {
      reason: classified.reason,
      score: classified.component?.score ?? result.score ?? 0,
      evidenceRequirement: sample.responsibility === 'judge'
        ? 'Production transition scorer matched the expected route tag.'
        : 'llm-rubric reason must contain exact evidence quotes from the generated output.',
      graderMetadata: classified.component?.metadata ?? null,
    },
    durationMs: result.latencyMs ?? null,
  };
}

export function rowsForPhase(evaluationResults, samples, phase, manifestHash, phaseFailure = null) {
  const byIndex = new Map();
  for (const result of evaluationResults) {
    if (!Number.isInteger(result.testIdx) || byIndex.has(result.testIdx)) {
      throw new Error('Kimi promptfoo returned an invalid or duplicate test index');
    }
    byIndex.set(result.testIdx, result);
  }
  return samples.map((sample, index) => {
    const result = byIndex.get(index);
    if (result === undefined) {
      const phaseFailed = phaseFailure?.status === 'infrastructure_failure';
      const reason = phaseFailed
        ? phaseFailure.reason
        : 'promptfoo did not return a result for this Kimi provider and case';
      return {
        schemaVersion: 1,
        manifestHash,
        revision: phase,
        provider: providerId,
        model: actualModel,
        effort: thinkingEffort,
        caseId: sample.id,
        responsibility: sample.responsibility,
        language: sample.language,
        origin: sample.origin,
        inputHash: sample.inputHash,
        promptHash: sample.promptHash,
        rubricHash: sample.rubricHash,
        pass: false,
        status: phaseFailed ? 'infrastructure_failure' : 'unexecuted',
        reason,
        rawResponse: '',
        judgment: {
          reason,
          score: 0,
          evidenceRequirement: phaseFailed
            ? 'The Kimi promptfoo phase failed; the private phase diagnostic identifies the failure.'
            : 'A row is valid only when the provider and grader returned an execution result.',
          graderMetadata: null,
        },
        durationMs: null,
      };
    }
    return rowFromResult(result, sample, phase, manifestHash);
  });
}

function writeRows(directory, rows) {
  mkdirSync(join(directory, 'rows'), { recursive: true });
  for (const row of rows) {
    const path = join(directory, 'rows', `${providerId}--${row.revision}--${row.caseId}.json`);
    writeNewJson(path, row);
  }
}

function summarize(rows, phases = phaseNames) {
  return phases.flatMap(phase => ['summary', 'plan', 'report', 'judge'].map(responsibility => {
    const selected = rows.filter(row => row.revision === phase && row.responsibility === responsibility);
    return {
      provider: providerId,
      label: providerLabel,
      phase,
      responsibility,
      passed: selected.filter(row => row.pass).length,
      total: selected.length,
      modelFailures: selected.filter(row => row.status === 'model_failure').length,
      infrastructureFailures: selected.filter(row => row.status === 'infrastructure_failure').length,
      unexecuted: selected.filter(row => row.status === 'unexecuted').length,
    };
  }));
}

export function evaluationExitCode(rows) {
  if (rows.some(row => row.status === 'infrastructure_failure' || row.status === 'unexecuted')) return 2;
  if (rows.some(row => row.revision === 'candidate' && row.status === 'model_failure')) return 1;
  return 0;
}

function outputManifest(sources, context, routeProvenance, phases = phaseNames) {
  const samples = sources.flatMap(source => source.samples.map(sample => ({
    phase: source.phase,
    id: sample.id,
    responsibility: sample.responsibility,
    language: sample.language,
    origin: sample.origin,
    promptHash: sample.promptHash,
    inputHash: sample.inputHash,
    rubricHash: sample.rubricHash,
    expected_transition: sample.expected_transition ?? null,
  })));
  return {
    schemaVersion: 1,
    evaluation: 'instruction-research-handoff-kimi-code-cli',
    label: providerLabel,
    casesHash: context.casesHash,
    fixture: context.fixture,
    phaseOrder: phases,
    expectedRows: phases.length * 10,
    providers: [{
      ...kimiProvider,
      endpointType: routeProvenance.endpointType,
      invocation: [
        '-m', requestedModelAlias,
        '--skills-dir', '<empty-dir>',
        '--output-format', 'stream-json',
        '-p', '<prompt>',
      ],
      autoFlag: 'omitted: Kimi Code CLI 0.43.1 rejects --auto with -p',
    }],
    routeProvenance,
    sources: Object.fromEntries(sources.map(source => [source.phase, {
      directory: source.directory,
      revision: source.manifest.revision,
      sourceRevision: source.manifest.sourceRevision,
      manifestSha256: source.manifestSha256,
    }])),
    samples,
    rawLayout: 'raw/<phase>/<caseId>.stdout (mode 600)',
    provenanceArtifact: 'provenance.json',
  };
}

export function phasePlanFromManifest(manifest) {
  if (!Array.isArray(manifest.phaseOrder)
    || (manifest.phaseOrder.length !== 1 && manifest.phaseOrder.length !== 2)) {
    throw new Error('Saved Kimi output must record one candidate phase or both phases');
  }
  const phases = manifest.phaseOrder;
  const expectedOrder = phases.length === 1 ? ['candidate'] : phaseNames;
  if (JSON.stringify(phases) !== JSON.stringify(expectedOrder)) {
    throw new Error('Saved Kimi output has an invalid phase order');
  }
  if (manifest.expectedRows !== phases.length * 10) {
    throw new Error('Saved Kimi output expectedRows does not match its phase order');
  }
  if (!Array.isArray(manifest.samples) || manifest.samples.length !== manifest.expectedRows) {
    throw new Error('Saved Kimi output samples do not match its phase count');
  }
  const sampleKeys = new Set();
  for (const sample of manifest.samples) {
    if (!phases.includes(sample?.phase) || typeof sample.id !== 'string') {
      throw new Error('Saved Kimi output has a sample for an unrecorded phase');
    }
    const key = `${sample.phase}/${sample.id}`;
    if (sampleKeys.has(key)) throw new Error('Saved Kimi output has a duplicate sample ' + key);
    sampleKeys.add(key);
  }
  for (const phase of phases) {
    const count = manifest.samples.filter(sample => sample.phase === phase).length;
    if (count !== 10) throw new Error('Saved Kimi output must contain 10 samples for ' + phase);
  }
  return phases;
}

function assertNewOutputDirectory(directory) {
  mkdirSync(directory, { recursive: true });
  if (readdirSync(directory).length > 0) {
    throw new Error('Output directory is not empty: ' + directory + '; use a new directory');
  }
}

function phaseEvaluationResults(evaluation, phase) {
  return (evaluation.results ?? []).map(result => ({ phase, ...result }));
}

async function evaluatePhase(source, outputDirectory, manifestHash, provenanceEntries, endpointType, abortSignal) {
  try {
    const evaluation = await runPromptfooEvaluation(
      source.samples,
      [kimiProvider],
      () => createKimiProvider(
        source.phase,
        source.samples,
        outputDirectory,
        provenanceEntries,
        endpointType,
        abortSignal,
      ),
    );
    return { results: phaseEvaluationResults(evaluation, source.phase) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const diagnosticPath = source.phase + '.private-error.txt';
    writePrivateNew(join(outputDirectory, diagnosticPath), message);
    return {
      results: [],
      phaseFailure: {
        status: 'infrastructure_failure',
        reason: 'Kimi promptfoo phase failed; private diagnostic saved',
        diagnosticPath,
      },
    };
  }
}

export async function runKimiCliComparison({
  baselineSourceDirectory,
  candidateSourceDirectory,
  outputDirectory,
  casesPath,
  routeProvenancePath,
  candidateOnly = false,
}) {
  const resolvedCasesPath = casesPath ?? defaultCasesPath;
  const phases = candidateOnly ? ['candidate'] : phaseNames;
  const baselineSource = resolve(baselineSourceDirectory);
  const candidateSource = resolve(candidateSourceDirectory);
  const output = resolve(outputDirectory);
  assertNewOutputDirectory(output);
  const context = validationContext(resolvedCasesPath);
  const routeProvenance = resolveRouteProvenance(routeProvenancePath);
  const sourceDirectories = { baseline: baselineSource, candidate: candidateSource };
  const sources = phases.map(phase => validateSavedSource(sourceDirectories[phase], phase, context));
  if (!candidateOnly) validatePairedSources(sources[0], sources[1]);
  const manifest = outputManifest(sources, context, routeProvenance, phases);
  writeNewJson(join(output, 'manifest.json'), manifest);
  const manifestHash = digest(JSON.stringify(manifest));
  const provenanceEntries = [];
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  const evaluations = [];
  const rows = [];
  const phaseFailures = [];
  try {
    for (const source of sources) {
      console.log(`${providerLabel}: ${source.phase} 10 cases`);
      const evaluation = await evaluatePhase(
        source,
        output,
        manifestHash,
        provenanceEntries,
        routeProvenance.endpointType,
        controller.signal,
      );
      evaluations.push(...evaluation.results);
      if (evaluation.phaseFailure !== undefined) phaseFailures.push({ phase: source.phase, ...evaluation.phaseFailure });
      rows.push(...rowsForPhase(
        evaluation.results,
        source.samples,
        source.phase,
        manifestHash,
        evaluation.phaseFailure,
      ));
    }
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  }
  rows.sort((left, right) => `${left.revision}/${left.caseId}`.localeCompare(`${right.revision}/${right.caseId}`));
  provenanceEntries.sort((left, right) => `${left.phase}/${left.caseId}`.localeCompare(`${right.phase}/${right.caseId}`));
  writeRows(output, rows);
  writeNewJson(join(output, 'evaluation-results.json'), evaluations);
  writeNewJson(join(output, 'provenance.json'), {
    schemaVersion: 1,
    label: providerLabel,
    provider: { ...kimiProvider, endpointType: routeProvenance.endpointType },
    routeProvenance,
    entries: provenanceEntries,
  });
  const summary = {
    schemaVersion: 1,
    label: providerLabel,
    provider: { ...kimiProvider, endpointType: routeProvenance.endpointType },
    manifestHash,
    cases: 10,
    expectedRows: phases.length * 10,
    rows: rows.length,
    phases,
    summary: summarize(rows, phases),
    phaseFailures,
    infrastructureFailures: rows.filter(row => row.status === 'infrastructure_failure').length,
    unexecuted: rows.filter(row => row.status === 'unexecuted').length,
    provenanceEntries: provenanceEntries.length,
  };
  summary.exitCode = evaluationExitCode(rows);
  writeNewJson(join(output, 'scored-results.json'), rows);
  writeNewJson(join(output, 'summary.json'), summary);
  return { manifest, manifestHash, rows, summary };
}

function savedOutputSource(outputManifestValue, phase) {
  const source = outputManifestValue.sources?.[phase];
  if (source?.directory === undefined) throw new Error('Output manifest is missing source directory for ' + phase);
  return source.directory;
}

export function validateSavedKimiOutput(outputDirectory, manifest) {
  if (manifest.providers?.length !== 1 || manifest.providers[0].id !== providerId) {
    throw new Error('Saved Kimi output has an unexpected provider');
  }
  const phases = phasePlanFromManifest(manifest);
  const rowsDirectory = join(outputDirectory, 'rows');
  if (!existsSync(rowsDirectory)) throw new Error('Saved Kimi rows directory is missing: ' + rowsDirectory);
  const rows = readdirSync(rowsDirectory)
    .filter(name => name.endsWith('.json'))
    .sort()
    .map(name => JSON.parse(readFileSync(join(rowsDirectory, name), 'utf8')));
  if (rows.length !== manifest.expectedRows) {
    throw new Error('Saved Kimi output must contain ' + manifest.expectedRows + ' rows');
  }
  const manifestHash = digest(JSON.stringify(manifest));
  const samples = new Map(manifest.samples.map(sample => [`${sample.phase}/${sample.id}`, sample]));
  const keys = new Set();
  for (const row of rows) {
    const key = `${row.revision}/${row.caseId}`;
    const sample = samples.get(key);
    if (row.provider !== providerId || !phases.includes(row.revision)
      || sample === undefined || keys.has(key)) {
      throw new Error('Saved Kimi output has an invalid row ' + key);
    }
    keys.add(key);
    if (row.manifestHash !== manifestHash
      || row.inputHash !== sample.inputHash
      || row.promptHash !== sample.promptHash
      || row.rubricHash !== sample.rubricHash) {
      throw new Error('Saved Kimi row hash differs from its manifest for ' + key);
    }
  }
  if (keys.size !== samples.size || keys.size !== manifest.expectedRows) {
    throw new Error('Saved Kimi output rows do not cover all phase cases');
  }
  return rows;
}

function normalizeRecoveredProvenance(entry) {
  // The preserved first run was recovered after its fixture cwd was removed.
  // Its recovery marker records that stdout and the completed session were
  // matched by ID, but the old entry predates sessionListSessionId.
  if (entry?.sessionListSessionId === undefined
    && entry?.recoveredFrom === 'stdout session_id matched to completed session state and all wire llm.request events') {
    return { ...entry, sessionListSessionId: entry.sessionId };
  }
  return entry;
}

function savedAnswers(outputDirectory, manifest, rows) {
  const provenancePath = join(outputDirectory, 'provenance.json');
  if (!existsSync(provenancePath)) throw new Error('Saved Kimi provenance is missing: ' + provenancePath);
  const provenance = JSON.parse(readFileSync(provenancePath, 'utf8'));
  if (provenance.provider?.id !== providerId || !Array.isArray(provenance.entries)) {
    throw new Error('Saved Kimi provenance has an unexpected provider or entry list');
  }
  const entries = new Map(provenance.entries.map(entry => [`${entry.phase}/${entry.caseId}`, entry]));
  if (entries.size !== provenance.entries.length) throw new Error('Saved Kimi provenance has duplicate entries');
  const rowKeys = new Set(rows.map(row => `${row.revision}/${row.caseId}`));
  for (const key of entries.keys()) {
    if (!rowKeys.has(key)) throw new Error('Saved Kimi provenance has an unexpected entry ' + key);
  }
  const answers = new Map();
  const errors = new Map();
  for (const row of rows) {
    const key = `${row.revision}/${row.caseId}`;
    const entry = entries.get(key);
    if (entry?.status === 'infrastructure_failure' || entry === undefined) {
      errors.set(key, 'Saved Kimi row has no successful provider provenance');
      continue;
    }
    if (entry.status === 'reused_saved_answer') {
      errors.set(key, 'Saved Kimi output cannot be rescored from a rescore artifact');
      continue;
    }
    const validatedEntry = normalizeRecoveredProvenance(entry);
    validateKimiProvenance(validatedEntry);
    entries.set(key, validatedEntry);
    const expectedRawPath = `raw/${row.revision}/${row.caseId}.stdout`;
    if (entry.rawStdoutPath !== expectedRawPath) {
      throw new Error('Saved Kimi provenance points to an unexpected raw output for ' + key);
    }
    const rawPath = join(outputDirectory, entry.rawStdoutPath);
    if (!existsSync(rawPath)) throw new Error('Saved Kimi raw output is missing: ' + rawPath);
    const raw = readFileSync(rawPath, 'utf8');
    if (digest(raw) !== entry.rawStdoutSha256) {
      throw new Error('Saved Kimi raw output hash differs from provenance for ' + key);
    }
    try {
      answers.set(key, parseKimiAssistantOutput(raw));
    } catch (_error) {
      errors.set(key, 'Saved Kimi raw output could not be parsed as an assistant answer');
    }
  }
  return { answers, errors, entries };
}

function copySavedRawStreams(sourceDirectory, outputDirectory, phases) {
  for (const phase of phases) {
    const sourceRawDirectory = join(sourceDirectory, 'raw', phase);
    const outputRawDirectory = join(outputDirectory, 'raw', phase);
    mkdirSync(outputRawDirectory, { recursive: true });
    if (!existsSync(sourceRawDirectory)) continue;
    for (const name of readdirSync(sourceRawDirectory).filter(name => name.endsWith('.stdout'))) {
      writePrivateNew(
        join(outputRawDirectory, name),
        readFileSync(join(sourceRawDirectory, name), 'utf8'),
      );
    }
  }
}

function sourceRawReference(sourceDirectory, entry, phase, caseId) {
  const expectedPath = `raw/${phase}/${caseId}.stdout`;
  if (entry?.rawStdoutPath !== expectedPath) {
    return {
      sourceOutputDirectory: resolve(sourceDirectory),
      sourceRawStdoutPath: null,
      sourceRawStdoutSha256: null,
    };
  }
  const path = join(sourceDirectory, expectedPath);
  if (!existsSync(path)) {
    return {
      sourceOutputDirectory: resolve(sourceDirectory),
      sourceRawStdoutPath: null,
      sourceRawStdoutSha256: null,
    };
  }
  const raw = readFileSync(path, 'utf8');
  const sha256 = digest(raw);
  if (entry.rawStdoutSha256 !== undefined && entry.rawStdoutSha256 !== sha256) {
    return {
      sourceOutputDirectory: resolve(sourceDirectory),
      sourceRawStdoutPath: null,
      sourceRawStdoutSha256: null,
    };
  }
  return {
    sourceOutputDirectory: resolve(sourceDirectory),
    sourceRawStdoutPath: expectedPath,
    sourceRawStdoutSha256: sha256,
  };
}

function copiedRawReference(outputDirectory, sourceReference, phase, caseId) {
  if (sourceReference.sourceRawStdoutPath === null) {
    return { rawStdoutPath: null, rawStdoutSha256: null };
  }
  const rawStdoutPath = `raw/${phase}/${caseId}.stdout`;
  const path = join(outputDirectory, rawStdoutPath);
  if (!existsSync(path)) return { rawStdoutPath: null, rawStdoutSha256: null };
  const rawStdoutSha256 = digest(readFileSync(path, 'utf8'));
  if (rawStdoutSha256 !== sourceReference.sourceRawStdoutSha256) {
    return { rawStdoutPath: null, rawStdoutSha256: null };
  }
  return { rawStdoutPath, rawStdoutSha256 };
}

export async function rescoreKimiCliOutput(sourceDirectory, outputDirectory, casesPath, routeProvenancePath) {
  const resolvedCasesPath = casesPath ?? defaultCasesPath;
  const sourceOutput = resolve(sourceDirectory);
  const sourceManifestPath = join(sourceOutput, 'manifest.json');
  if (!existsSync(sourceManifestPath)) throw new Error('Kimi CLI output manifest is missing: ' + sourceManifestPath);
  const sourceManifestText = readFileSync(sourceManifestPath, 'utf8');
  const sourceManifest = JSON.parse(sourceManifestText);
  const phases = phasePlanFromManifest(sourceManifest);
  const sourceRows = validateSavedKimiOutput(sourceOutput, sourceManifest);
  const {
    answers: savedAnswersByKey,
    errors: savedAnswerErrors,
    entries: savedProvenanceEntries,
  } = savedAnswers(
    sourceOutput,
    sourceManifest,
    sourceRows,
  );
  const context = validationContext(resolvedCasesPath);
  const routeProvenance = resolveRouteProvenance(routeProvenancePath);
  const sources = phases.map(phase => validateSavedSource(
    savedOutputSource(sourceManifest, phase),
    phase,
    context,
  ));
  assertNewOutputDirectory(resolve(outputDirectory));
  const output = resolve(outputDirectory);
  const manifest = outputManifest(sources, context, routeProvenance, phases);
  manifest.rescoredFromManifestFileSha256 = digest(sourceManifestText);
  manifest.rescorePromptSource = 'saved source prompt artifacts';
  writeNewJson(join(output, 'manifest.json'), manifest);
  const manifestHash = digest(JSON.stringify(manifest));
  copySavedRawStreams(sourceOutput, output, phases);
  const provenanceEntries = [];
  const rows = [];
  const evaluations = [];
  for (const source of sources) {
    const runProvider = { ...kimiProvider, endpointType: routeProvenance.endpointType };
    const providerFactory = () => ({
      id: () => 'instruction-research-handoff:' + providerId,
      label: providerLabel,
      config: { ...runProvider, maxRetries: 0 },
      callApi: async (_prompt, requestContext = {}) => {
        const key = `${source.phase}/${String(requestContext.vars?.caseId ?? '')}`;
        const error = savedAnswerErrors.get(key);
        if (error !== undefined) return { error };
        const output = savedAnswersByKey.get(key);
        if (output === undefined) return { error: 'Saved Kimi answer is missing for ' + key };
        return { output };
      },
    });
    const evaluation = await runPromptfooEvaluation(source.samples, [runProvider], providerFactory);
    const results = phaseEvaluationResults(evaluation, source.phase);
    evaluations.push(...results);
    rows.push(...rowsForPhase(results, source.samples, source.phase, manifestHash));
    provenanceEntries.push(...source.samples.map(sample => {
      const key = `${source.phase}/${sample.id}`;
      const sourceEntry = savedProvenanceEntries.get(key);
      const sourceReference = sourceRawReference(sourceOutput, sourceEntry, source.phase, sample.id);
      const copiedReference = copiedRawReference(output, sourceReference, source.phase, sample.id);
      return {
        ...(sourceEntry ?? {}),
        phase: source.phase,
        caseId: sample.id,
        status: savedAnswerErrors.has(key) ? 'infrastructure_failure' : 'reused_saved_answer',
        ...sourceReference,
        ...copiedReference,
      };
    }));
  }
  rows.sort((left, right) => `${left.revision}/${left.caseId}`.localeCompare(`${right.revision}/${right.caseId}`));
  writeRows(output, rows);
  writeNewJson(join(output, 'evaluation-results.json'), evaluations);
  writeNewJson(join(output, 'provenance.json'), {
    schemaVersion: 1,
    label: providerLabel,
    provider: { ...kimiProvider, endpointType: routeProvenance.endpointType },
    routeProvenance,
    entries: provenanceEntries,
  });
  const summary = {
    schemaVersion: 1,
    label: providerLabel,
    provider: { ...kimiProvider, endpointType: routeProvenance.endpointType },
    manifestHash,
    sourceManifestFileSha256: digest(sourceManifestText),
    rescorePromptSource: 'saved source prompt artifacts',
    expectedRows: phases.length * 10,
    rows: rows.length,
    phases,
    summary: summarize(rows, phases),
  };
  summary.exitCode = evaluationExitCode(rows);
  writeNewJson(join(output, 'scored-results.json'), rows);
  writeNewJson(join(output, 'summary.json'), summary);
  return { manifest, manifestHash, rows, summary };
}

export function parseCliArguments(argumentsList) {
  const positional = [];
  let routeProvenancePath = configuredRouteProvenancePath;
  let casesPath = defaultCasesPath;
  let candidateOnly = false;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === '--candidate-only') {
      candidateOnly = true;
    } else if (argument === '--route-provenance') {
      routeProvenancePath = argumentsList[++index];
      if (routeProvenancePath === undefined) throw new Error('--route-provenance requires a path');
    } else if (argument.startsWith('--route-provenance=')) {
      routeProvenancePath = argument.slice('--route-provenance='.length);
    } else if (argument === '--cases') {
      casesPath = argumentsList[++index];
      if (casesPath === undefined) throw new Error('--cases requires a path');
    } else if (argument.startsWith('--cases=')) {
      casesPath = argument.slice('--cases='.length);
    } else {
      positional.push(argument);
    }
  }
  return { positional, routeProvenancePath, casesPath, candidateOnly };
}

async function main() {
  const { positional, routeProvenancePath, casesPath, candidateOnly } = parseCliArguments(process.argv.slice(2));
  const [command, first, second, third] = positional;
  if (command === 'run' && first !== undefined && second !== undefined && third !== undefined) {
    const result = await runKimiCliComparison({
      baselineSourceDirectory: first,
      candidateSourceDirectory: second,
      outputDirectory: third,
      casesPath,
      routeProvenancePath,
      candidateOnly,
    });
    process.exitCode = result.summary.exitCode;
    console.log(JSON.stringify(result.summary, null, 2));
    return;
  }
  if (command === 'rescore' && first !== undefined && second !== undefined) {
    const result = await rescoreKimiCliOutput(first, second, casesPath, routeProvenancePath);
    process.exitCode = result.summary.exitCode;
    console.log(JSON.stringify(result.summary, null, 2));
    return;
  }
  throw new Error(
    'Usage: node eval/scripts/instruction-research-handoff-kimi-cli.mjs '
    + 'run <baseline-source> <candidate-source> <output-dir> [--candidate-only] '
    + '[--route-provenance path] [--cases path] | '
    + 'rescore <kimi-output-dir> <output-dir> [--route-provenance path] [--cases path]',
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}

export {
  actualModel,
  kimiCliPath,
  kimiCliVersion,
  kimiProvider,
  providerId,
  providerLabel,
  requestedModelAlias,
  thinkingEffort,
};
