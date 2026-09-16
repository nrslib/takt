#!/usr/bin/env node
/**
 * Compare the summary and development handoff prompts.
 *
 * Baseline freezes prompts and rubrics and completes every provider before the
 * candidate phase is allowed. Semantic output uses promptfoo's llm-rubric.
 * Phase 3 route tags use the production transition scorer.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate } from 'promptfoo';
import { parse } from 'yaml';
import { buildSemanticRubric, checklistFor } from '../asserts/instruction-research-handoff-rubric.mjs';
import { scoreTransition } from '../asserts/completion-routing.mjs';
import { loadCompletionRoutingStep, default as buildCompletionRoutingPrompt } from '../completion-routing-prompt.mjs';
import {
  createCliReviewSession,
  createIsolatedWorkingDirectory,
  runProcess,
} from '../providers/cli-review.mjs';

process.env.PROMPTFOO_DISABLE_TELEMETRY = 'true';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const defaultCasesPath = join(repoRoot, 'eval/cases/instruction-research-handoff.yaml');
const fixtureDirectory = join(repoRoot, 'eval/fixtures/instruction-research-handoff');
const providers = Object.freeze([
  { id: 'claude-opus-5', cli: 'claude', model: 'claude-opus-5', effort: null, label: 'claude-opus-5' },
  { id: 'gpt-5.6-sol-high', cli: 'codex', model: 'gpt-5.6-sol', effort: 'high', label: 'gpt-5.6-sol/high' },
  { id: 'gpt-5.6-luna-max', cli: 'codex', model: 'gpt-5.6-luna', effort: 'max', label: 'gpt-5.6-luna/max' },
  { id: 'kimi-k3', cli: 'opencode', model: 'moonshotai/kimi-k3', effort: null, label: 'moonshotai/kimi-k3' },
]);

const { buildSummaryPrompt } = await import(
  repoRoot + '/dist/features/interactive/interactive-summary.js'
);
const { loadPersonaPromptFromPath, loadWorkflowByIdentifier } = await import(
  repoRoot + '/dist/infra/config/index.js'
);
const { withGlobalConfigDirOverride } = await import(repoRoot + '/dist/infra/config/paths.js');
const { InstructionBuilder } = await import(repoRoot + '/dist/core/workflow/instruction/InstructionBuilder.js');
const { ReportInstructionBuilder } = await import(repoRoot + '/dist/core/workflow/instruction/ReportInstructionBuilder.js');
const { findStepTarget } = await import('./prepare.mjs');

const englishConfigDirectory = mkdtempSync(join(tmpdir(), 'takt-instruction-eval-config-'));
writeFileSync(join(englishConfigDirectory, 'config.yaml'), 'language: en\n');

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fixtureSnapshot(directory = fixtureDirectory) {
  const files = [];
  const visit = currentDirectory => {
    const entries = readdirSync(currentDirectory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile()) {
        files.push({
          path: relative(directory, path).split(sep).join('/'),
          sha256: digest(readFileSync(path)),
        });
      } else {
        throw new Error('Fixture contains an unsupported entry: ' + path);
      }
    }
  };
  visit(directory);
  return {
    files,
    aggregateSha256: digest(JSON.stringify(files)),
  };
}

function fixtureWorkspaceEvidence(directory = fixtureDirectory) {
  const snapshot = fixtureSnapshot(directory);
  return snapshot.files.map(file => ({
    ...file,
    content: readFileSync(join(directory, file.path), 'utf8'),
  }));
}

function fixtureVerificationEvidence(directory = fixtureDirectory) {
  const output = execFileSync('npm', ['test'], { cwd: directory, encoding: 'utf8' });
  const tests = output.match(/(?:^|\n)ℹ tests (\d+)/)?.[1] ?? 'unknown';
  const passed = output.match(/(?:^|\n)ℹ pass (\d+)/)?.[1] ?? 'unknown';
  const failed = output.match(/(?:^|\n)ℹ fail (\d+)/)?.[1] ?? 'unknown';
  return [{
    command: 'npm test',
    result: `exit 0; tests=${tests}; pass=${passed}; fail=${failed}`,
  }];
}

function providerSelectionFor(skipProviderIds = []) {
  const uniqueSkipped = [...new Set(skipProviderIds)];
  const knownIds = new Set(providers.map(provider => provider.id));
  for (const providerId of uniqueSkipped) {
    if (!knownIds.has(providerId)) throw new Error('Unknown provider to skip: ' + providerId);
  }
  if (uniqueSkipped.length === providers.length) {
    throw new Error('At least one provider must remain active');
  }
  const skipped = uniqueSkipped.map(id => ({
    id,
    reason: 'Provider execution was skipped after a confirmed provider failure; no replacement model was used.',
  }));
  const skippedIds = new Set(uniqueSkipped);
  return {
    executed: providers.filter(provider => !skippedIds.has(provider.id)).map(provider => provider.id),
    skipped,
  };
}

function evaluationExitCode(rows, phase, providerSelection = providerSelectionFor()) {
  const skippedIds = new Set((providerSelection.skipped ?? []).map(provider => provider.id));
  // Deliberate skips remain recorded as infrastructure rows; the CLI status
  // reflects only providers that this invocation was asked to execute.
  const activeRows = rows.filter(row => !skippedIds.has(row.provider));
  if (activeRows.some(row => row.status === 'infrastructure_failure' || row.status === 'unexecuted')) {
    return 2;
  }
  if (phase === 'candidate' && activeRows.some(row => row.pass !== true)) return 1;
  return 0;
}

function rescoreLineageFor(sourceManifest) {
  const sourceRevision = sourceManifest.sourceRevision
    ?? (sourceManifest.candidatePromptHashes === undefined ? 'baseline' : 'candidate');
  return {
    sourceRevision,
    revision: sourceRevision + '-rescored',
  };
}

function configDirectory(language) {
  return language === 'ja' ? join(repoRoot, 'eval/config') : englishConfigDirectory;
}

function withLanguage(language, action) {
  return withGlobalConfigDirOverride(configDirectory(language), action);
}

function validateCases(source, cases) {
  if (!Array.isArray(cases) || cases.length !== 10) {
    throw new Error('Expected exactly 10 fixed cases, received ' + (cases?.length ?? '(not a list)'));
  }
  const ids = new Set();
  for (const sample of cases) {
    if (!sample || !/^[a-z0-9-]+$/.test(sample.id) || ids.has(sample.id)) {
      throw new Error('Invalid or duplicate case id: ' + String(sample?.id));
    }
    ids.add(sample.id);
    if (!['summary', 'plan', 'report', 'judge'].includes(sample.responsibility)) {
      throw new Error('Unknown responsibility for ' + sample.id);
    }
    if (!['ja', 'en'].includes(sample.language)) throw new Error('Unknown language for ' + sample.id);
    if (!['runtime-derived', 'held-out-domain', 'control'].includes(sample.origin)) {
      throw new Error('Unknown origin for ' + sample.id);
    }
    if (!sample.rubric || !Array.isArray(sample.rubric.checks) || sample.rubric.checks.length === 0) {
      throw new Error('Missing fixed rubric checks for ' + sample.id);
    }
    checklistFor(sample);
    if (sample.responsibility === 'summary') {
      if (!Array.isArray(sample.history) || sample.history.length < 2) {
        throw new Error('Summary case needs role-separated history: ' + sample.id);
      }
      for (const message of sample.history) {
        if (!['user', 'assistant'].includes(message.role) || typeof message.content !== 'string') {
          throw new Error('Invalid summary history entry for ' + sample.id);
        }
      }
    } else if (sample.responsibility !== 'judge'
      && (typeof sample.task !== 'string' || sample.task.trim() === '')) {
      throw new Error('Missing task for ' + sample.id);
    }
    if (sample.responsibility === 'judge'
      && (typeof sample.report !== 'string' || !sample.expected_transition)) {
      throw new Error('Judge case needs report and expected transition: ' + sample.id);
    }
  }
  return { cases, casesHash: digest(source) };
}

const planTargetCache = new Map();
function getPlanTarget(language) {
  const cached = planTargetCache.get(language);
  if (cached) return cached;
  const target = withLanguage(language, () => {
    const workflow = loadWorkflowByIdentifier('default', repoRoot);
    if (!workflow) throw new Error('default workflow is unavailable for ' + language);
    const found = findStepTarget(workflow, 'plan', repoRoot);
    if (!found) throw new Error('default workflow plan step is unavailable for ' + language);
    return found;
  });
  planTargetCache.set(language, target);
  return target;
}

function buildSummaryCasePrompt(sample) {
  return buildSummaryPrompt(
    sample.history,
    false,
    sample.language,
    '',
    sample.language === 'ja' ? '## 会話履歴' : '## Conversation History',
    undefined,
    undefined,
    undefined,
    false,
    false,
    true,
  );
}

function buildPlanCasePrompt(sample) {
  const found = getPlanTarget(sample.language);
  const context = {
    task: sample.task,
    iteration: 1,
    maxSteps: found.workflow.maxSteps ?? 51,
    stepIteration: 1,
    cwd: '/eval/project',
    projectCwd: '/eval/project',
    userInputs: [],
    ...(sample.response === undefined ? {} : { previousOutput: { content: sample.response } }),
    reportDir: '/eval/reports',
    validateReportReferences: false,
    workflowSteps: found.workflow.steps ?? [],
    currentStepIndex: found.stepIndex,
    workflowName: found.workflow.name,
    workflowDescription: found.workflow.description,
    workflowRules: found.workflowRules,
    workflowCallVars: found.workflowCallVars,
    language: sample.language,
  };
  const instruction = new InstructionBuilder(found.target, context).build();
  const persona = found.target.personaPath
    ? loadPersonaPromptFromPath(found.target.personaPath, repoRoot).trim()
    : '';
  return persona ? persona + '\n\n' + instruction : instruction;
}

function buildReportCasePrompt(sample) {
  const found = getPlanTarget(sample.language);
  return new ReportInstructionBuilder(found.target, {
    cwd: '/eval/project',
    task: sample.task,
    reportDir: '/eval/reports',
    stepIteration: 1,
    language: sample.language,
    targetFile: 'plan.md',
    lastResponse: sample.response,
  }).build();
}

function buildJudgeCasePrompt(sample) {
  return buildCompletionRoutingPrompt({ vars: {
    workflow: sample.workflow ?? 'development-core',
    step_name: sample.step_name,
    language: sample.language,
    report: sample.report,
    interactive: false,
  } });
}

function buildPrompt(sample) {
  if (sample.responsibility === 'summary') return buildSummaryCasePrompt(sample);
  if (sample.responsibility === 'plan') return buildPlanCasePrompt(sample);
  if (sample.responsibility === 'report') return buildReportCasePrompt(sample);
  if (sample.responsibility === 'judge') return buildJudgeCasePrompt(sample);
  throw new Error('Unknown responsibility: ' + sample.responsibility);
}

function inputFor(sample) {
  if (sample.responsibility === 'summary') {
    return { history: sample.history, language: sample.language };
  }
  return {
    task: sample.task,
    response: sample.response ?? null,
    report: sample.report ?? null,
    language: sample.language,
    workflow: sample.workflow ?? null,
    step_name: sample.step_name ?? null,
  };
}

function buildSamples(
  cases,
  casesHash,
  fixture = fixtureSnapshot(),
  workspaceFiles = fixture.files,
  verificationEvidence = [],
) {
  return cases.map((sample) => {
    const prompt = buildPrompt(sample);
    const semanticRubric = sample.responsibility === 'judge'
      ? null
      : buildSemanticRubric(sample, { workspaceFiles, verificationEvidence });
    const routeStep = sample.responsibility === 'judge'
      ? loadCompletionRoutingStep({
        workflow: sample.workflow ?? 'development-core',
        step_name: sample.step_name,
        language: sample.language,
        report: sample.report,
        interactive: false,
      })
      : null;
    return {
      ...sample,
      casesHash,
      prompt,
      promptHash: digest(prompt),
      inputHash: digest(JSON.stringify(inputFor(sample))),
      semanticRubric,
      rubricHash: semanticRubric === null ? null : digest(semanticRubric),
      routeStep,
    };
  });
}

function manifestFor(
  baselineRevision,
  casesHash,
  samples,
  fixture = fixtureSnapshot(),
  providerSelection = providerSelectionFor(),
) {
  return {
    schemaVersion: 2,
    baselineRevision,
    casesHash,
    fixture,
    providerSelection,
    providers: providers.map(({ id, cli, model, effort, label }) => ({ id, cli, model, effort, label })),
    samples: samples.map(sample => ({
      id: sample.id,
      responsibility: sample.responsibility,
      language: sample.language,
      origin: sample.origin,
      promptHash: sample.promptHash,
      inputHash: sample.inputHash,
      rubricHash: sample.rubricHash,
      rubricChecks: sample.rubric.checks,
      expected_transition: sample.expected_transition ?? null,
    })),
  };
}

function writeNewJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
}

function assertOutputDirectoryIsNew(directory) {
  mkdirSync(directory, { recursive: true });
  if (readdirSync(directory).length > 0) {
    throw new Error('Output directory is not empty: ' + directory + '; use a new directory');
  }
}

function parseOpenCodeOutput(raw) {
  const text = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === 'text' && typeof event.part?.text === 'string') text.push(event.part.text);
  }
  if (text.length === 0) throw new Error('opencode completed without a text response');
  return text.join('\n');
}

function makeTargetProvider(config) {
  return {
    id: () => 'instruction-research-handoff:' + config.id,
    label: config.label,
    config: { ...config, maxRetries: 0 },
    callApi: async (prompt, _context, options = {}) => {
      const isolated = createIsolatedWorkingDirectory(
        join(repoRoot, 'eval/fixtures/instruction-research-handoff'),
      );
      const { cwd } = isolated;
      try {
        const isolatedPrompt = prompt.replaceAll('/eval/project', cwd);
        if (config.cli === 'opencode') {
          const raw = await runProcess('opencode', [
            'run', '--dir', cwd, '-m', config.model, '--pure', '--format', 'json',
            '--print-logs', '--log-level', 'INFO', isolatedPrompt,
          ], { cwd, input: '', timeoutMs: 900_000, abortSignal: options.abortSignal });
          return { output: parseOpenCodeOutput(raw) };
        }
        const output = await createCliReviewSession({
          cli: config.cli,
          model: config.model,
          reasoning_effort: config.effort,
          timeout_ms: 900_000,
          disable_inherited_skills: true,
        }, { cwd, abortSignal: options.abortSignal }).run(isolatedPrompt);
        return { output };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      } finally {
        isolated.cleanup();
      }
    },
  };
}

function makeReplayProvider(config, rowsByKey) {
  return {
    id: () => 'instruction-research-handoff:replay:' + config.id,
    label: config.label,
    config: { ...config, maxRetries: 0 },
    callApi: async (_prompt, context = {}) => {
      const caseId = String(context.vars?.caseId ?? '');
      const row = rowsByKey.get(resultKey(config.id, caseId));
      if (row === undefined) return { error: 'Missing saved output for ' + config.id + '/' + caseId };
      if (typeof row.rawResponse !== 'string' || row.rawResponse.trim() === '') {
        return { error: 'Saved output is empty for ' + config.id + '/' + caseId };
      }
      return { output: row.rawResponse };
    },
  };
}

function makeSemanticGrader() {
  return {
    id: () => 'instruction-research-handoff-semantic-judge:gpt-5.6-luna-max',
    label: 'semantic-judge:gpt-5.6-luna/max',
    config: { cli: 'codex', model: 'gpt-5.6-luna', reasoning_effort: 'max', maxRetries: 0 },
    callApi: async (prompt, _context, options = {}) => {
      const cwd = mkdtempSync(join(tmpdir(), 'takt-instruction-judge-'));
      try {
        const output = await createCliReviewSession({
          cli: 'codex',
          model: 'gpt-5.6-luna',
          reasoning_effort: 'max',
          timeout_ms: 900_000,
          disable_inherited_skills: true,
        }, { cwd, abortSignal: options.abortSignal }).run(prompt);
        return { output };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
  };
}

function routeAssertion(sample) {
  return (output) => {
    const result = scoreTransition(output, sample.routeStep, sample.expected_transition, false);
    return { ...result, score: result.pass ? 1 : 0 };
  };
}

async function runPromptfooEvaluation(
  samples,
  activeProviders = providers,
  providerFactory = makeTargetProvider,
) {
  const promptById = new Map(samples.map(sample => [sample.id, sample.prompt]));
  const tests = samples.map(sample => ({
    description: sample.id,
    vars: { caseId: sample.id },
    assert: sample.responsibility === 'judge'
      ? [{ type: 'javascript', metric: 'instruction-research-handoff/' + sample.id + '/route', value: routeAssertion(sample) }]
      : [{ type: 'llm-rubric', metric: 'instruction-research-handoff/' + sample.id + '/semantic', value: sample.semanticRubric }],
  }));
  return evaluate({
    prompts: [({ vars }) => {
      const prompt = promptById.get(String(vars.caseId));
      if (prompt === undefined) throw new Error('Unknown eval case ' + String(vars.caseId));
      return prompt;
    }],
    providers: activeProviders.map(providerFactory),
    defaultTest: { options: { provider: makeSemanticGrader() } },
    tests,
    writeLatestResults: false,
  }, {
    maxConcurrency: 4,
    showProgressBar: false,
    silent: false,
    cache: false,
    writeLatestResults: false,
  });
}

function firstComponent(result) {
  return result.gradingResult?.componentResults?.[0] ?? result.gradingResult;
}

function resultKey(providerId, sampleId) {
  return providerId + '--' + sampleId;
}

function classifyResult(result) {
  const component = firstComponent(result);
  const output = typeof result.response?.output === 'string' ? result.response.output : '';
  const responseError = result.response?.error;
  const hasGradingResult = result.gradingResult !== undefined;
  const graderError = component?.metadata?.graderError === true;
  // Promptfoo puts assertion failures in result.error too.  Only its explicit
  // ERROR failure reason is an uncaught provider failure when no response was
  // returned; a grading result with result.error is a model assertion failure.
  const uncaughtProviderError = result.failureReason === 2 && !hasGradingResult;
  const infrastructureFailure = responseError !== undefined || graderError || uncaughtProviderError;
  const status = infrastructureFailure
    ? 'infrastructure_failure'
    : output.trim() === ''
      ? 'model_failure'
      : result.success === true
        ? 'pass'
        : 'model_failure';
  const reason = infrastructureFailure
    ? (responseError === undefined
      ? (graderError ? 'semantic_grader_error' : String(result.error))
      : 'provider_error')
    : component?.reason ?? result.gradingResult?.reason ?? 'no grading reason';
  return { component, output, responseError, infrastructureFailure, status, reason };
}

function saveResultRows(
  evaluation,
  samples,
  directory,
  revision,
  manifestHash,
  activeProviders = providers,
  skippedProviders = [],
) {
  const activeProviderIds = new Set(activeProviders.map(provider => provider.id));
  const skippedById = new Map(skippedProviders.map(provider => [provider.id, provider]));
  const resultByKey = new Map();
  for (const result of evaluation.results ?? []) {
    const sample = samples[result.testIdx];
    if (!sample) throw new Error('Promptfoo returned unknown test index ' + String(result.testIdx));
    const provider = providers.find(candidate => candidate.label === result.provider?.label)
      ?? providers.find(candidate => result.provider?.id?.endsWith(':' + candidate.id));
    if (!provider) {
      throw new Error(
        'Promptfoo returned unknown provider '
        + String(result.provider?.label ?? result.provider?.id ?? '(missing)'),
      );
    }
    const key = resultKey(provider.id, sample.id);
    if (resultByKey.has(key)) throw new Error('Promptfoo returned duplicate result ' + key);
    resultByKey.set(key, { result, sample, provider });
  }

  const rows = [];
  for (const provider of providers) for (const sample of samples) {
    const key = resultKey(provider.id, sample.id);
    const entry = resultByKey.get(key);
    const skipped = skippedById.get(provider.id);
    if (!activeProviderIds.has(provider.id) && skipped !== undefined) {
      const row = {
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
        pass: false,
        status: 'infrastructure_failure',
        reason: skipped.reason,
        rawResponse: '',
        judgment: {
          reason: skipped.reason,
          score: 0,
          evidenceRequirement: 'This provider was unavailable before execution; no model output exists for this row.',
          graderMetadata: null,
        },
        durationMs: null,
      };
      writeNewJson(join(directory, 'rows', key + '.json'), row);
      rows.push(row);
      continue;
    }
    if (!entry) {
      const row = {
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
        pass: false,
        status: 'unexecuted',
        reason: 'promptfoo did not return a result for this provider and case',
        rawResponse: '',
        judgment: {
          reason: 'promptfoo did not return a result for this provider and case',
          score: 0,
          evidenceRequirement: 'A row is valid only when the provider and grader returned an execution result.',
          graderMetadata: null,
        },
        durationMs: null,
      };
      writeNewJson(join(directory, 'rows', key + '.json'), row);
      rows.push(row);
      continue;
    }

    const { result } = entry;
    const {
      component,
      output,
      responseError,
      infrastructureFailure,
      status,
      reason,
    } = classifyResult(result);
    const row = {
      schemaVersion: 1,
      manifestHash,
      revision,
      provider: provider.id,
      model: provider.model,
      effort: provider?.effort ?? null,
      caseId: sample.id,
      responsibility: sample.responsibility,
      language: sample.language,
      origin: sample.origin,
      inputHash: sample.inputHash,
      promptHash: sample.promptHash,
      rubricHash: sample.rubricHash,
      pass: status === 'pass',
      status,
      reason,
      rawResponse: output,
      judgment: {
        reason,
        score: component?.score ?? result.score ?? 0,
        evidenceRequirement: sample.responsibility === 'judge'
          ? 'Production transition scorer matched the expected route tag.'
          : 'llm-rubric reason must contain exact evidence quotes from the generated output.',
        graderMetadata: component?.metadata ?? null,
      },
      durationMs: result.latencyMs ?? null,
    };
    writeNewJson(join(directory, 'rows', key + '.json'), row);
    if (infrastructureFailure) {
      writeFileSync(
        join(directory, 'rows', key + '.private-error.txt'),
        String(responseError ?? result.error ?? reason),
        { mode: 0o600, flag: 'wx' },
      );
    }
    rows.push(row);
  }
  if (rows.length !== providers.length * samples.length) throw new Error('Result row count invariant failed');
  return rows;
}

function summarize(rows) {
  return providers.flatMap(provider => ['summary', 'plan', 'report', 'judge'].map(responsibility => {
    const selected = rows.filter(row => row.provider === provider.id && row.responsibility === responsibility);
    return {
      provider: provider.id,
      model: provider.model,
      effort: provider.effort,
      responsibility,
      passed: selected.filter(row => row.pass).length,
      total: selected.length,
      modelFailures: selected.filter(row => row.status === 'model_failure').length,
      infrastructureFailures: selected.filter(row => row.status === 'infrastructure_failure').length,
      unexecuted: selected.filter(row => row.status === 'unexecuted').length,
    };
  }));
}

function writePromptArtifacts(directory, samples) {
  mkdirSync(join(directory, 'prompts'), { recursive: true });
  mkdirSync(join(directory, 'rubrics'), { recursive: true });
  mkdirSync(join(directory, 'rows'), { recursive: true });
  for (const sample of samples) {
    writeFileSync(join(directory, 'prompts', sample.id + '.md'), sample.prompt, { flag: 'wx' });
    if (sample.semanticRubric !== null) {
      writeFileSync(join(directory, 'rubrics', sample.id + '.md'), sample.semanticRubric, { flag: 'wx' });
    }
  }
}

function readCases(casesPath) {
  const source = readFileSync(casesPath, 'utf8');
  return validateCases(source, parse(source));
}

function baselineRows(directory) {
  const rowsDirectory = join(directory, 'rows');
  if (!existsSync(rowsDirectory)) return [];
  return readdirSync(rowsDirectory)
    .filter(name => name.endsWith('.json'))
    .map(name => JSON.parse(readFileSync(join(rowsDirectory, name), 'utf8')));
}

function savedRowsByKey(directory) {
  const rows = baselineRows(directory);
  const byKey = new Map();
  for (const row of rows) {
    const key = resultKey(row.provider, row.caseId);
    if (byKey.has(key)) throw new Error('Duplicate saved row ' + key);
    byKey.set(key, row);
  }
  return { rows, byKey };
}

function assertRescoreFixtureMatches(sourceManifest, currentFixture) {
  if (JSON.stringify(sourceManifest.fixture) !== JSON.stringify(currentFixture)) {
    throw new Error('Saved baseline fixture differs from the current fixture; regenerate model outputs first');
  }
}

function validateSavedPromptHashes(sourceManifest, savedPrompts, samples) {
  const sampleById = new Map(sourceManifest.samples.map(sample => [sample.id, sample]));
  for (const sample of samples) {
    const savedSample = sampleById.get(sample.id);
    if (savedSample === undefined) throw new Error('Saved baseline is missing case ' + sample.id);
    const savedPrompt = savedPrompts.get(sample.id);
    if (savedPrompt === undefined || digest(savedPrompt) !== savedSample.promptHash) {
      throw new Error('Saved baseline prompt hash does not match its prompt artifact for ' + sample.id);
    }
    if (sample.inputHash !== savedSample.inputHash) {
      throw new Error('Saved baseline input differs from the current fixed case for ' + sample.id);
    }
  }
}

function validateSavedRowHashes(sourceManifest, rows) {
  const sampleById = new Map(sourceManifest.samples.map(sample => [sample.id, sample]));
  for (const row of rows) {
    const sample = sampleById.get(row.caseId);
    if (sample === undefined) throw new Error('Saved baseline row has unknown case ' + row.caseId);
    if (row.inputHash !== sample.inputHash || row.promptHash !== sample.promptHash) {
      throw new Error('Saved baseline row hash differs from its manifest for ' + row.caseId);
    }
  }
}

function samplesWithSavedPrompts(sourceDirectory, sourceManifest, samples) {
  const savedPrompts = new Map();
  for (const sample of samples) {
    const path = join(sourceDirectory, 'prompts', sample.id + '.md');
    if (!existsSync(path)) throw new Error('Saved baseline prompt is missing: ' + path);
    savedPrompts.set(sample.id, readFileSync(path, 'utf8'));
  }
  validateSavedPromptHashes(sourceManifest, savedPrompts, samples);
  return samples.map(sample => {
    const prompt = savedPrompts.get(sample.id);
    return { ...sample, prompt, promptHash: digest(prompt) };
  });
}

async function runBaseline(outputDirectory, casesPath, skipProviderIds = []) {
  assertOutputDirectoryIsNew(outputDirectory);
  const { cases, casesHash } = readCases(casesPath);
  const fixture = fixtureSnapshot();
  const samples = buildSamples(
    cases,
    casesHash,
    fixture,
    fixtureWorkspaceEvidence(),
    fixtureVerificationEvidence(),
  );
  const baselineRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  const selected = providerSelectionFor(skipProviderIds);
  const activeProviders = providers.filter(provider => selected.executed.includes(provider.id));
  const manifest = manifestFor(baselineRevision, casesHash, samples, fixture, selected);
  writePromptArtifacts(outputDirectory, samples);
  writeNewJson(join(outputDirectory, 'manifest.json'), manifest);
  const manifestHash = digest(JSON.stringify(manifest));
  const evaluation = await runPromptfooEvaluation(samples, activeProviders);
  writeNewJson(join(outputDirectory, 'evaluation-results.json'), evaluation.results ?? []);
  const rows = saveResultRows(
    evaluation,
    samples,
    outputDirectory,
    'baseline',
    manifestHash,
    activeProviders,
    selected.skipped,
  );
  const summary = summarize(rows);
  writeFileSync(join(outputDirectory, 'scored-results.json'), JSON.stringify(rows, null, 2) + '\n');
  writeFileSync(join(outputDirectory, 'summary.json'), JSON.stringify({
    revision: 'baseline',
    manifestHash,
    cases: cases.length,
    expectedRows: providers.length * samples.length,
    providerSelection: selected,
    red: rows.some(row => row.status === 'model_failure' && row.origin !== 'control'),
    infrastructureFailures: rows.filter(row => row.status === 'infrastructure_failure').length,
    unexecuted: rows.filter(row => row.status === 'unexecuted').length,
    summary,
  }, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = evaluationExitCode(rows, 'baseline', selected);
  console.log(JSON.stringify({
    phase: 'baseline',
    cases: cases.length,
    providers: providers.length,
    red: rows.some(row => row.status === 'model_failure' && row.origin !== 'control'),
    next: 'Run candidate after every active provider/case row is present and no active infrastructure or unexecuted rows remain; explicitly skipped providers remain unevaluated.',
  }));
}

async function runRescore(sourceDirectory, outputDirectory, casesPath) {
  if (!existsSync(join(sourceDirectory, 'manifest.json'))) {
    throw new Error('Source baseline manifest is missing: ' + sourceDirectory);
  }
  assertOutputDirectoryIsNew(outputDirectory);
  const sourceManifestText = readFileSync(join(sourceDirectory, 'manifest.json'), 'utf8');
  const sourceManifest = JSON.parse(sourceManifestText);
  const { cases, casesHash } = readCases(casesPath);
  if (sourceManifest.casesHash !== casesHash) {
    throw new Error('Saved baseline cases differ from the current fixed cases; regenerate model outputs first');
  }
  const fixture = fixtureSnapshot();
  const samples = buildSamples(
    cases,
    casesHash,
    fixture,
    fixtureWorkspaceEvidence(),
    fixtureVerificationEvidence(),
  );
  assertRescoreFixtureMatches(sourceManifest, fixture);
  const samplesWithFrozenPrompts = samplesWithSavedPrompts(sourceDirectory, sourceManifest, samples);
  const selected = providerSelectionFor(
    (sourceManifest.providerSelection?.skipped ?? []).map(provider => provider.id),
  );
  const currentManifest = manifestFor(
    sourceManifest.baselineRevision,
    casesHash,
    samplesWithFrozenPrompts,
    fixture,
    selected,
  );
  const { rows: sourceRows, byKey } = savedRowsByKey(sourceDirectory);
  const expected = providers.length * samples.length;
  if (sourceRows.length !== expected) {
    throw new Error('Saved baseline is incomplete: expected ' + expected + ', received ' + sourceRows.length);
  }
  validateSavedRowHashes(sourceManifest, sourceRows);
  const activeProviders = providers.filter(provider => selected.executed.includes(provider.id));
  const replayEvaluation = await runPromptfooEvaluation(
    samplesWithFrozenPrompts,
    activeProviders,
    config => makeReplayProvider(config, byKey),
  );
  writePromptArtifacts(outputDirectory, samplesWithFrozenPrompts);
  const { sourceRevision, revision } = rescoreLineageFor(sourceManifest);
  const manifest = {
    ...currentManifest,
    revision,
    sourceRevision,
    rescoredFromManifestFileSha256: digest(sourceManifestText),
    rescorePromptSource: 'saved source prompt artifacts',
  };
  writeNewJson(join(outputDirectory, 'manifest.json'), manifest);
  const manifestHash = digest(JSON.stringify(manifest));
  writeNewJson(join(outputDirectory, 'evaluation-results.json'), replayEvaluation.results ?? []);
  const rows = saveResultRows(
    replayEvaluation,
    samplesWithFrozenPrompts,
    outputDirectory,
    revision,
    manifestHash,
    activeProviders,
    selected.skipped,
  );
  const summary = summarize(rows);
  writeFileSync(join(outputDirectory, 'scored-results.json'), JSON.stringify(rows, null, 2) + '\n');
  writeFileSync(join(outputDirectory, 'summary.json'), JSON.stringify({
    revision,
    sourceRevision,
    manifestHash,
    rescorePromptSource: manifest.rescorePromptSource,
    rescoredFromManifestFileSha256: manifest.rescoredFromManifestFileSha256,
    cases: cases.length,
    expectedRows: expected,
    providerSelection: selected,
    red: rows.some(row => row.status === 'model_failure' && row.origin !== 'control'),
    infrastructureFailures: rows.filter(row => row.status === 'infrastructure_failure').length,
    unexecuted: rows.filter(row => row.status === 'unexecuted').length,
    summary,
  }, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = evaluationExitCode(rows, sourceRevision, selected);
}

function assertBaselineCompatible(savedManifest, currentManifest, rows) {
  const projection = manifest => ({
    schemaVersion: manifest.schemaVersion,
    casesHash: manifest.casesHash,
    fixture: manifest.fixture,
    providerSelection: manifest.providerSelection,
    providers: manifest.providers,
    samples: manifest.samples.map(sample => ({
      id: sample.id,
      inputHash: sample.inputHash,
      rubricHash: sample.rubricHash,
      rubricChecks: sample.rubricChecks,
      expected_transition: sample.expected_transition,
    })),
  });
  if (JSON.stringify(projection(savedManifest)) !== JSON.stringify(projection(currentManifest))) {
    throw new Error('Cases, expectations, providers, or semantic rubrics changed after baseline');
  }
  const expected = providers.length * currentManifest.samples.length;
  if (rows.length !== expected) throw new Error('Baseline is incomplete: expected ' + expected + ', received ' + rows.length);
  const skippedProviderIds = new Set(
    (savedManifest.providerSelection?.skipped ?? []).map(provider => provider.id),
  );
  const incomplete = rows.filter(row =>
    !skippedProviderIds.has(row.provider)
    && (row.status === 'infrastructure_failure' || row.status === 'unexecuted')
  );
  if (incomplete.length > 0) throw new Error('Baseline has ' + incomplete.length + ' incomplete rows');
}

async function runCandidate(baselineDirectory, outputDirectory, casesPath, skipProviderIds = []) {
  if (!existsSync(join(baselineDirectory, 'manifest.json'))) {
    throw new Error('Baseline manifest is missing: ' + baselineDirectory);
  }
  assertOutputDirectoryIsNew(outputDirectory);
  const savedManifest = JSON.parse(readFileSync(join(baselineDirectory, 'manifest.json'), 'utf8'));
  const { cases, casesHash } = readCases(casesPath);
  const fixture = fixtureSnapshot();
  const samples = buildSamples(
    cases,
    casesHash,
    fixture,
    fixtureWorkspaceEvidence(),
    fixtureVerificationEvidence(),
  );
  const selected = providerSelectionFor(skipProviderIds);
  const activeProviders = providers.filter(provider => selected.executed.includes(provider.id));
  const currentManifest = manifestFor(
    savedManifest.baselineRevision,
    casesHash,
    samples,
    fixture,
    selected,
  );
  const rows = baselineRows(baselineDirectory);
  assertBaselineCompatible(savedManifest, currentManifest, rows);
  writePromptArtifacts(outputDirectory, samples);
  const manifest = {
    ...currentManifest,
    baselineManifestHash: digest(JSON.stringify(savedManifest)),
    candidatePromptHashes: Object.fromEntries(samples.map(sample => [sample.id, sample.promptHash])),
  };
  writeNewJson(join(outputDirectory, 'manifest.json'), manifest);
  const manifestHash = digest(JSON.stringify(manifest));
  const evaluation = await runPromptfooEvaluation(samples, activeProviders);
  writeNewJson(join(outputDirectory, 'evaluation-results.json'), evaluation.results ?? []);
  const candidateRows = saveResultRows(
    evaluation,
    samples,
    outputDirectory,
    'candidate',
    manifestHash,
    activeProviders,
    selected.skipped,
  );
  const summary = summarize(candidateRows);
  writeFileSync(join(outputDirectory, 'scored-results.json'), JSON.stringify(candidateRows, null, 2) + '\n');
  writeFileSync(join(outputDirectory, 'summary.json'), JSON.stringify({
    revision: 'candidate',
    manifestHash,
    baselineManifestHash: manifest.baselineManifestHash,
    cases: cases.length,
    expectedRows: providers.length * samples.length,
    providerSelection: selected,
    summary,
  }, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = evaluationExitCode(candidateRows, 'candidate', selected);
}

async function main() {
  const [phase, ...rawArgs] = process.argv.slice(2);
  const positional = [];
  const skipProviderIds = [];
  for (let index = 0; index < rawArgs.length; index += 1) {
    const argument = rawArgs[index];
    if (argument === '--skip-provider') {
      const providerId = rawArgs[index + 1];
      if (providerId === undefined) throw new Error('--skip-provider requires a provider id');
      skipProviderIds.push(providerId);
      index += 1;
    } else if (argument.startsWith('--skip-provider=')) {
      skipProviderIds.push(argument.slice('--skip-provider='.length));
    } else {
      positional.push(argument);
    }
  }
  const [first, second, third] = positional;
  if (phase === 'baseline' && first !== undefined && second === undefined) {
    await runBaseline(resolve(first), defaultCasesPath, skipProviderIds);
    return;
  }
  if (phase === 'baseline' && first !== undefined && second !== undefined) {
    await runBaseline(resolve(first), resolve(second), skipProviderIds);
    return;
  }
  if (phase === 'candidate' && first !== undefined && second !== undefined && third === undefined) {
    await runCandidate(resolve(first), resolve(second), defaultCasesPath, skipProviderIds);
    return;
  }
  if (phase === 'candidate' && first !== undefined && second !== undefined && third !== undefined) {
    await runCandidate(resolve(first), resolve(second), resolve(third), skipProviderIds);
    return;
  }
  if (phase === 'rescore' && first !== undefined && second !== undefined && third === undefined) {
    await runRescore(resolve(first), resolve(second), defaultCasesPath);
    return;
  }
  if (phase === 'rescore' && first !== undefined && second !== undefined && third !== undefined) {
    await runRescore(resolve(first), resolve(second), resolve(third));
    return;
  }
  throw new Error(
    'Usage: node eval/scripts/instruction-research-handoff-eval.mjs '
    + 'baseline <output-dir> [cases-file] [--skip-provider <id>] | '
    + 'candidate <baseline-dir> <output-dir> [cases-file] [--skip-provider <id>] | '
    + 'rescore <source-baseline-dir> <output-dir> [cases-file]',
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } finally {
    rmSync(englishConfigDirectory, { recursive: true, force: true });
  }
}

export {
  buildPrompt,
  buildSamples,
  classifyResult,
  evaluationExitCode,
  assertRescoreFixtureMatches,
  manifestFor,
  fixtureSnapshot,
  fixtureWorkspaceEvidence,
  fixtureVerificationEvidence,
  providerSelectionFor,
  providers,
  rescoreLineageFor,
  readCases,
  runPromptfooEvaluation,
  scoreTransition,
  validateSavedPromptHashes,
  validateSavedRowHashes,
};
