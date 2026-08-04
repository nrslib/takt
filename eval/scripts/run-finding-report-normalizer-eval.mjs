#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import {
  createRawFindingsOutputJsonSchema,
} from '../../dist/core/models/finding-schemas.js';
import {
  buildFindingIntakeExtractionPrompt,
  FINDING_INTAKE_EXTRACTION_PROMPT_TEMPLATE,
} from '../../dist/shared/prompts/finding-intake-extraction.js';
import { callClaudeCustom } from '../../dist/infra/claude/client.js';
import {
  callOpenCodeCustom,
  resetSharedServer,
} from '../../dist/infra/opencode/client.js';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const evalDir = resolve(scriptDir, '..');
const caseDir = join(evalDir, 'cases', 'finding-normalizer');
const catalogPath = join(caseDir, 'extraction-catalog.json');
const scorerFixturePath = join(caseDir, 'scorer-adversarial.json');
const workDir = join(evalDir, '.work', 'finding-report-normalizer');
const resultRootDir = join(workDir, 'results');
const isolationDir = join(tmpdir(), 'takt-finding-report-normalizer');

const targetConfigs = {
  gemma4: { provider: 'opencode', model: 'ollama-cloud/gemma4:31b' },
  luna: { provider: 'codex', model: 'gpt-5.6-luna' },
  terra: { provider: 'codex', model: 'gpt-5.6-terra' },
  haiku: { provider: 'claude', model: 'haiku' },
  sonnet: { provider: 'claude', model: 'sonnet' },
};

function readOption(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function parsePositiveInteger(value, name) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseSafeName(value, name) {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(value)) {
    throw new Error(`${name} contains unsupported characters`);
  }
  return value;
}

function parseCommaList(value) {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

const renderOnly = process.argv.includes('--render-only');
const scoreOnly = process.argv.includes('--score-only');
const selfTest = process.argv.includes('--self-test');
const allowExternalReviewData = process.argv.includes(
  '--allow-external-review-data',
);
if ([renderOnly, scoreOnly, selfTest].filter(Boolean).length > 1) {
  throw new Error(
    '--render-only, --score-only, and --self-test are mutually exclusive',
  );
}

const resultSet = parseSafeName(
  readOption('--result-set') ?? 'current',
  '--result-set',
);
const resultDir = join(resultRootDir, resultSet);
const repeat = parsePositiveInteger(readOption('--repeat') ?? '1', '--repeat');
const timeoutMs = parsePositiveInteger(
  readOption('--timeout-ms') ?? String(10 * 60 * 1000),
  '--timeout-ms',
);
const modelOption = readOption('--models');
if (!modelOption && !renderOnly && !selfTest) {
  throw new Error(
    `Specify targets explicitly: --models ${Object.keys(targetConfigs).join(',')}`,
  );
}
if (selfTest && modelOption !== undefined) {
  throw new Error('--self-test does not accept --models');
}
const targets = modelOption === undefined ? [] : parseCommaList(modelOption);
if (!renderOnly && !selfTest && targets.length === 0) {
  throw new Error('--models must contain at least one target');
}
if (new Set(targets).size !== targets.length) {
  throw new Error('--models must not contain duplicates');
}
for (const target of targets) {
  if (!(target in targetConfigs)) {
    throw new Error(
      `Unknown target "${target}". Available: ${Object.keys(targetConfigs).join(', ')}`,
    );
  }
}

function parseReports(source) {
  const marker = '## Candidate reports\n\n';
  const markerIndex = source.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error('Candidate reports were not found');
  }
  const reports = source
    .slice(markerIndex + marker.length)
    .split(/\n\n---\n\n(?=### Candidate report )/)
    .map((section) => {
      const match = section.match(/^### Candidate report (\d+)\n\n([\s\S]*)$/);
      if (!match) {
        throw new Error('Invalid candidate report section');
      }
      return {
        number: Number.parseInt(match[1], 10),
        content: match[2].trim(),
      };
    });
  if (
    reports.length === 0
    || reports.some(({ number }, index) => number !== index + 1)
  ) {
    throw new Error('Candidate reports must be sequentially numbered from 1');
  }
  return reports;
}

function expectedExcerpt(report, specification) {
  const start = report.indexOf(specification.rawExcerptAnchor);
  if (start === -1) {
    throw new Error(
      `Gold anchor was not found: ${specification.rawExcerptAnchor}`,
    );
  }
  const end = specification.rawExcerptEndMarker === undefined
    ? report.length
    : report.indexOf(specification.rawExcerptEndMarker, start);
  if (end === -1) {
    throw new Error(
      `Gold end marker was not found: ${specification.rawExcerptEndMarker}`,
    );
  }
  return report.slice(start, end).trim();
}

function loadCases() {
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
  if (!Array.isArray(catalog.cases) || catalog.cases.length === 0) {
    throw new Error('Extraction catalog must contain cases');
  }
  return catalog.cases.map((entry) => {
    if (
      !['synthetic', 'requires_explicit_approval'].includes(
        entry.externalExecution,
      )
    ) {
      throw new Error(
        `Case ${entry.id} must declare a supported externalExecution value`,
      );
    }
    const source = readFileSync(join(caseDir, entry.source), 'utf8');
    const gold = JSON.parse(readFileSync(join(caseDir, entry.gold), 'utf8'));
    const reports = parseReports(source).map((report) => {
      const reportGold = gold.reports?.[String(report.number)];
      if (!reportGold || !Array.isArray(reportGold.candidates)) {
        throw new Error(
          `Gold is missing ${entry.id} candidate report ${report.number}`,
        );
      }
      return {
        ...report,
        expectedOutput: {
          rawFindings: reportGold.candidates.map((candidate) => ({
            rawExcerpt: expectedExcerpt(report.content, candidate),
            candidate: candidate.candidate,
          })),
        },
      };
    });
    return { ...entry, reports };
  });
}

const requestedCases = readOption('--cases');
const allCases = loadCases();
const selectedCaseIds = requestedCases === undefined
  ? allCases.map(({ id }) => id)
  : parseCommaList(requestedCases);
if (selectedCaseIds.length === 0) {
  throw new Error('--cases must contain at least one case');
}
if (new Set(selectedCaseIds).size !== selectedCaseIds.length) {
  throw new Error('--cases must not contain duplicates');
}
const selectedCases = selectedCaseIds.map((caseId) => {
  const selected = allCases.find(({ id }) => id === caseId);
  if (selected === undefined) {
    throw new Error(
      `Unknown case "${caseId}". Available: ${allCases.map(({ id }) => id).join(', ')}`,
    );
  }
  return selected;
});
const protectedCases = selectedCases.filter(({ externalExecution }) => (
  externalExecution === 'requires_explicit_approval'
));
if (
  !renderOnly
  && !scoreOnly
  && !selfTest
  && protectedCases.length > 0
  && !allowExternalReviewData
) {
  throw new Error(
    'External model execution for local review material requires explicit '
    + 'approval and --allow-external-review-data. Protected cases: '
    + protectedCases.map(({ id }) => id).join(', '),
  );
}

const reportOption = readOption('--reports');
if (reportOption !== undefined && selectedCases.length !== 1) {
  throw new Error('--reports requires exactly one selected case');
}
const requestedReports = reportOption === undefined
  ? undefined
  : parseCommaList(reportOption).map((value) => (
      parsePositiveInteger(value, '--reports')
    ));
if (requestedReports !== undefined && requestedReports.length === 0) {
  throw new Error('--reports must contain at least one report');
}
if (
  requestedReports !== undefined
  && new Set(requestedReports).size !== requestedReports.length
) {
  throw new Error('--reports must not contain duplicates');
}
const invocations = selectedCases.flatMap((testCase) => {
  const reports = requestedReports === undefined
    ? testCase.reports
    : testCase.reports.filter(({ number }) => requestedReports.includes(number));
  if (
    requestedReports !== undefined
    && reports.length !== requestedReports.length
  ) {
    throw new Error(
      `--reports contains a number outside ${testCase.id}`,
    );
  }
  return reports.map((report) => ({ testCase, report }));
});

const promptTemplate = FINDING_INTAKE_EXTRACTION_PROMPT_TEMPLATE;

function buildPrompt(report) {
  return buildFindingIntakeExtractionPrompt(report.content);
}

function createTimeoutError(wallClockTimeoutMs) {
  const error = new Error(`Wall-clock timeout after ${wallClockTimeoutMs} ms`);
  error.name = 'WallClockTimeoutError';
  return error;
}

function runCommand(command, args, stdin, wallClockTimeoutMs) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: isolationDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killTimer;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    }, wallClockTimeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      if (timedOut) {
        const error = createTimeoutError(wallClockTimeoutMs);
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      if (code !== 0) {
        const error = new Error(`${command} exited with ${code}\n${stderr}\n${stdout}`);
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolvePromise({ stdout, stderr });
    });
    child.stdin.end(stdin);
  });
}

async function withAbortTimeout(operation, wallClockTimeoutMs, afterTimeout) {
  const controller = new globalThis.AbortController();
  let timedOut = false;
  const timeoutError = createTimeoutError(wallClockTimeoutMs);
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(timeoutError);
  }, wallClockTimeoutMs);
  try {
    const result = await operation(controller.signal);
    if (timedOut) throw timeoutError;
    return result;
  } catch (error) {
    if (timedOut) throw timeoutError;
    throw error;
  } finally {
    clearTimeout(timeout);
    if (timedOut && afterTimeout) {
      try {
        await afterTimeout();
      } catch (error) {
        timeoutError.cleanupError = error instanceof Error
          ? error.message
          : String(error);
      }
    }
  }
}

function parseCodexEvents(stdout) {
  let providerUsage;
  let toolUseCount = 0;
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === 'turn.completed' && event.usage) {
        providerUsage = event.usage;
      }
      if (
        event.type === 'item.completed'
        && ['command_execution', 'mcp_tool_call', 'file_change'].includes(
          event.item?.type,
        )
      ) {
        toolUseCount += 1;
      }
    } catch {
      // Provider diagnostics remain in the JSONL artifact.
    }
  }
  return { providerUsage, toolUseCount };
}

async function callCodex(config, prompt, schemaPath, outputBase) {
  const resultPath = `${outputBase}.output.json`;
  try {
    const command = await runCommand('codex', [
      'exec',
      '--json',
      '--model', config.model,
      '--sandbox', 'read-only',
      '--ephemeral',
      '--skip-git-repo-check',
      '--output-schema', schemaPath,
      '--output-last-message', resultPath,
      '-C', isolationDir,
      '-',
    ], prompt, timeoutMs);
    writeFileSync(`${outputBase}.jsonl`, command.stdout);
    return {
      structuredOutput: JSON.parse(readFileSync(resultPath, 'utf8')),
      ...parseCodexEvents(command.stdout),
      status: 'done',
      error: undefined,
    };
  } catch (error) {
    if (typeof error.stdout === 'string') {
      writeFileSync(`${outputBase}.jsonl`, error.stdout);
      Object.assign(error, parseCodexEvents(error.stdout));
    }
    throw error;
  }
}

async function callClaude(config, prompt, outputSchema) {
  const response = await withAbortTimeout(
    (abortSignal) => callClaudeCustom(
      'finding-report-normalizer',
      prompt,
      'Extract only verbatim claims from the supplied report. Do not use tools.',
      {
        cwd: isolationDir,
        model: config.model,
        permissionMode: 'readonly',
        allowedTools: [],
        outputSchema,
        abortSignal,
      },
    ),
    timeoutMs,
  );
  return {
    structuredOutput: response.structuredOutput,
    providerUsage: response.providerUsage,
    status: response.status,
    error: response.error,
    toolUseCount: 0,
  };
}

async function callGemma(prompt, outputSchema) {
  const response = await withAbortTimeout(
    (abortSignal) => callOpenCodeCustom(
      'finding-report-normalizer',
      prompt,
      'Extract only verbatim claims from the supplied report. Do not use tools.',
      {
        cwd: isolationDir,
        model: targetConfigs.gemma4.model,
        permissionMode: 'readonly',
        allowedTools: [],
        outputSchema,
        language: 'en',
        interactionTimeoutMs: Math.min(
          timeoutMs + 5_000,
          Number.MAX_SAFE_INTEGER,
        ),
        abortSignal,
      },
    ),
    timeoutMs,
    () => resetSharedServer(),
  );
  return {
    structuredOutput: response.structuredOutput,
    providerUsage: response.providerUsage,
    status: response.status,
    error: response.error,
    toolUseCount: 0,
  };
}

function countOccurrences(source, value) {
  if (typeof value !== 'string' || value.length === 0) return 0;
  let count = 0;
  let offset = 0;
  while (offset <= source.length - value.length) {
    const index = source.indexOf(value, offset);
    if (index === -1) break;
    count += 1;
    offset = index + value.length;
  }
  return count;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringArray(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === 'string')
    : [];
}

function findingRawExcerpt(finding) {
  return isRecord(finding) && typeof finding.rawExcerpt === 'string'
    ? finding.rawExcerpt
    : undefined;
}

function findingCandidate(finding) {
  return isRecord(finding) ? finding.candidate : undefined;
}

function candidateSourceStrings(candidate) {
  if (!isRecord(candidate)) return [];
  const strings = [
    candidate.rawFindingId,
    candidate.relation,
    candidate.targetFindingId,
    candidate.familyTag,
    candidate.severity,
    candidate.title,
    candidate.description,
    candidate.suggestion,
  ];
  const target = isRecord(candidate.target) ? candidate.target : undefined;
  if (target?.kind === 'code') {
    strings.push(...stringArray(target.paths));
  } else if (target?.kind === 'structure') {
    const scope = isRecord(target.scope) ? target.scope : undefined;
    strings.push(
      ...stringArray(scope?.roots),
      ...stringArray(target.manifestTargets),
    );
  } else if (target?.kind === 'absence') {
    const predicate = isRecord(target.predicate)
      ? target.predicate
      : undefined;
    if (predicate?.kind === 'path_state') {
      strings.push(predicate.path);
    } else if (predicate?.kind === 'exact_literal_search') {
      strings.push(
        ...stringArray(predicate.roots),
        predicate.literal,
      );
    }
  }
  const evidenceRequests = Array.isArray(candidate.evidenceRequests)
    ? candidate.evidenceRequests
    : [];
  for (const request of evidenceRequests) {
    if (!isRecord(request)) continue;
    if (request.kind === 'file_quote') {
      strings.push(request.path, request.verbatimExcerpt);
      continue;
    }
    const subject = isRecord(request.subject) ? request.subject : undefined;
    if (subject?.kind === 'authoritative_quote') {
      strings.push(
        subject.declarationId,
        subject.verbatimExcerpt,
      );
    }
  }
  return strings.filter((value) => typeof value === 'string');
}

function getAtPath(value, path) {
  return path.reduce((current, segment) => current?.[segment], value);
}

function collectAmbiguityPaths(value, path = []) {
  if (value === null || (Array.isArray(value) && value.length === 0)) {
    return [path];
  }
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => (
    collectAmbiguityPaths(child, [...path, key])
  ));
}

function isExecutionCompleted(result) {
  return result.status === 'done'
    && (
      result.error === undefined
      || result.error === null
      || result.error === ''
    );
}

function scoreResult(result, validate, invocation) {
  const output = result.structuredOutput;
  const schemaValid = validate(output);
  const executionCompleted = isExecutionCompleted(result);
  const actual = isRecord(output) && Array.isArray(output.rawFindings)
    ? output.rawFindings
    : [];
  const expected = invocation.report.expectedOutput.rawFindings;
  const actualByExcerpt = new Map();
  for (const finding of actual) {
    const rawExcerpt = findingRawExcerpt(finding);
    if (rawExcerpt !== undefined) {
      actualByExcerpt.set(rawExcerpt, finding);
    }
  }
  const recalled = expected.filter(({ rawExcerpt }) => (
    actualByExcerpt.has(rawExcerpt)
  )).length;
  const sourceBound = actual.filter((finding) => (
    countOccurrences(
      invocation.report.content,
      findingRawExcerpt(finding),
    ) === 1
  )).length;
  const unexpected = actual.filter((finding) => (
    !expected.some(({ rawExcerpt }) => (
      rawExcerpt === findingRawExcerpt(finding)
    ))
  ));
  const exactCandidates = expected.filter((expectedFinding) => (
    isDeepStrictEqual(
      findingCandidate(actualByExcerpt.get(expectedFinding.rawExcerpt)),
      expectedFinding.candidate,
    )
  )).length;
  const ambiguityChecks = expected.flatMap((expectedFinding) => (
    collectAmbiguityPaths(expectedFinding.candidate).map((path) => ({
      expectedFinding,
      path,
    }))
  ));
  const preservedAmbiguity = ambiguityChecks.filter(({ expectedFinding, path }) => (
    isDeepStrictEqual(
      getAtPath(
        findingCandidate(actualByExcerpt.get(expectedFinding.rawExcerpt)),
        path,
      ),
      getAtPath(expectedFinding.candidate, path),
    )
  )).length;
  const inventedStrings = actual.flatMap((finding) => (
    candidateSourceStrings(findingCandidate(finding))
      .filter((value) => (
        !findingRawExcerpt(finding)?.includes(value)
      ))
      .map((value) => ({
        rawExcerpt: findingRawExcerpt(finding),
        value,
      }))
  ));
  const findingOrderExact = actual.length === expected.length
    && expected.every((expectedFinding, index) => (
      findingRawExcerpt(actual[index]) === expectedFinding.rawExcerpt
    ));
  const claimRecall = expected.length === 0 ? 1 : recalled / expected.length;
  const sourceBindingRate = actual.length === 0 ? 1 : sourceBound / actual.length;
  const candidateExactRate = expected.length === 0
    ? 1
    : exactCandidates / expected.length;
  const ambiguityPreservationRate = ambiguityChecks.length === 0
    ? 1
    : preservedAmbiguity / ambiguityChecks.length;
  const nonFabricationPassed = unexpected.length === 0
    && inventedStrings.length === 0
    && actual.length === expected.length;
  const noCrossReportMixing = sourceBindingRate === 1
    && inventedStrings.length === 0;
  const toolIsolationPassed = result.toolUseCount === 0;
  const passed = executionCompleted
    && result.promptArtifactMatchesCurrent
    && schemaValid
    && claimRecall === 1
    && sourceBindingRate === 1
    && candidateExactRate === 1
    && nonFabricationPassed
    && ambiguityPreservationRate === 1
    && findingOrderExact
    && noCrossReportMixing
    && toolIsolationPassed;
  return {
    ...result,
    caseId: invocation.testCase.id,
    candidateReport: invocation.report.number,
    executionCompleted,
    promptArtifactMatchesCurrent: result.promptArtifactMatchesCurrent,
    schemaValidationCompleted: true,
    schemaValid,
    schemaErrors: schemaValid ? [] : validate.errors,
    expectedClaimCount: expected.length,
    actualClaimCount: actual.length,
    claimRecall,
    sourceBindingRate,
    candidateExactRate,
    unexpectedClaimCount: unexpected.length,
    inventedStrings,
    nonFabricationPassed,
    ambiguityPreservationRate,
    findingOrderExact,
    noCrossReportMixing,
    toolIsolationPassed,
    passed,
  };
}

function scoringErrorResult(result, invocation, error) {
  const output = result.structuredOutput;
  const actualClaimCount = isRecord(output)
    && Array.isArray(output.rawFindings)
    ? output.rawFindings.length
    : 0;
  return {
    ...result,
    providerErrorKind: result.errorKind,
    errorKind: 'scoring_error',
    scoringError: error instanceof Error ? error.message : String(error),
    scoringStack: error instanceof Error ? error.stack : undefined,
    caseId: invocation.testCase.id,
    candidateReport: invocation.report.number,
    executionCompleted: isExecutionCompleted(result),
    schemaValidationCompleted: false,
    schemaValid: false,
    schemaErrors: [],
    expectedClaimCount: invocation.report.expectedOutput.rawFindings.length,
    actualClaimCount,
    claimRecall: 0,
    sourceBindingRate: 0,
    candidateExactRate: 0,
    unexpectedClaimCount: actualClaimCount,
    inventedStrings: [],
    nonFabricationPassed: false,
    ambiguityPreservationRate: 0,
    findingOrderExact: false,
    noCrossReportMixing: false,
    toolIsolationPassed: result.toolUseCount === 0,
    passed: false,
  };
}

function scoreResultSafely(result, validate, invocation, scorer) {
  try {
    return scorer(result, validate, invocation);
  } catch (error) {
    return scoringErrorResult(result, invocation, error);
  }
}

function errorResponse(error, durationMs) {
  return {
    durationMs,
    structuredOutput: null,
    providerUsage: error.providerUsage,
    status: 'error',
    error: error instanceof Error ? error.message : String(error),
    errorKind: error?.name === 'WallClockTimeoutError'
      ? 'wall_clock_timeout'
      : 'provider_error',
    cleanupError: error?.cleanupError,
    toolUseCount: Number.isSafeInteger(error?.toolUseCount)
      ? error.toolUseCount
      : 0,
  };
}

function readStoredResponse(resultPath, promptArtifactPath) {
  const stored = JSON.parse(readFileSync(resultPath, 'utf8'));
  if (!Number.isSafeInteger(stored.toolUseCount) || stored.toolUseCount < 0) {
    throw new Error(`Invalid toolUseCount in ${resultPath}`);
  }
  if (!existsSync(promptArtifactPath)) {
    throw new Error(`Prompt artifact is missing: ${promptArtifactPath}`);
  }
  return {
    durationMs: stored.durationMs,
    structuredOutput: stored.structuredOutput,
    providerUsage: stored.providerUsage,
    status: stored.status,
    error: stored.error,
    toolUseCount: stored.toolUseCount,
    promptArtifactSha256: sha256(readFileSync(promptArtifactPath, 'utf8')),
  };
}

function aggregateResults(results) {
  const aggregates = {};
  for (const result of results) {
    const aggregate = aggregates[result.target] ?? {
      executions: 0,
      executionCompleted: 0,
      promptArtifactMatchesCurrent: 0,
      schemaValidationCompleted: 0,
      passed: 0,
      schemaValid: 0,
      claimRecallTotal: 0,
      sourceBindingTotal: 0,
      candidateExactTotal: 0,
      unexpectedClaimCount: 0,
      inventedStringCount: 0,
      nonFabricationPassed: 0,
      ambiguityPreservationTotal: 0,
      findingOrderExact: 0,
      noCrossReportMixing: 0,
      toolIsolationPassed: 0,
      scoringErrorCount: 0,
      maxDurationMs: 0,
    };
    aggregate.executions += 1;
    aggregate.executionCompleted += result.executionCompleted ? 1 : 0;
    aggregate.promptArtifactMatchesCurrent += (
      result.promptArtifactMatchesCurrent ? 1 : 0
    );
    aggregate.schemaValidationCompleted += (
      result.schemaValidationCompleted ? 1 : 0
    );
    aggregate.passed += result.passed ? 1 : 0;
    aggregate.schemaValid += result.schemaValid ? 1 : 0;
    aggregate.claimRecallTotal += result.claimRecall;
    aggregate.sourceBindingTotal += result.sourceBindingRate;
    aggregate.candidateExactTotal += result.candidateExactRate;
    aggregate.unexpectedClaimCount += result.unexpectedClaimCount;
    aggregate.inventedStringCount += result.inventedStrings.length;
    aggregate.nonFabricationPassed += result.nonFabricationPassed ? 1 : 0;
    aggregate.ambiguityPreservationTotal += result.ambiguityPreservationRate;
    aggregate.findingOrderExact += result.findingOrderExact ? 1 : 0;
    aggregate.noCrossReportMixing += result.noCrossReportMixing ? 1 : 0;
    aggregate.toolIsolationPassed += result.toolIsolationPassed ? 1 : 0;
    aggregate.scoringErrorCount += result.errorKind === 'scoring_error' ? 1 : 0;
    aggregate.maxDurationMs = Math.max(
      aggregate.maxDurationMs,
      Number.isFinite(result.durationMs) ? result.durationMs : 0,
    );
    aggregates[result.target] = aggregate;
  }
  return aggregates;
}

function findInvocation(caseId, candidateReport) {
  const testCase = allCases.find(({ id }) => id === caseId);
  const report = testCase?.reports.find(({ number }) => (
    number === candidateReport
  ));
  if (testCase === undefined || report === undefined) {
    throw new Error(
      `Scorer fixture references unknown invocation ${caseId} `
      + `report ${candidateReport}`,
    );
  }
  return { testCase, report };
}

function createSelfTestResponse(structuredOutput) {
  return {
    target: 'scorer-self-test',
    provider: 'fixture',
    model: 'fixture',
    repetition: 1,
    durationMs: 0,
    structuredOutput,
    status: 'done',
    error: undefined,
    toolUseCount: 0,
    promptArtifactMatchesCurrent: true,
  };
}

function assertSelfTest(condition, message) {
  if (!condition) throw new Error(`Scorer self-test failed: ${message}`);
}

function runScorerSelfTest(validate) {
  const fixture = JSON.parse(readFileSync(scorerFixturePath, 'utf8'));
  if (!Array.isArray(fixture.malformedOutputs)) {
    throw new Error('Scorer fixture must contain malformedOutputs');
  }
  const baseInvocation = findInvocation(
    fixture.baseInvocation?.caseId,
    fixture.baseInvocation?.candidateReport,
  );
  const malformed = fixture.malformedOutputs.map(({ id, output }) => {
    const scored = scoreResultSafely(
      createSelfTestResponse(output),
      validate,
      baseInvocation,
      scoreResult,
    );
    assertSelfTest(scored.passed === false, `${id} unexpectedly passed`);
    assertSelfTest(scored.schemaValid === false, `${id} is schema-valid`);
    assertSelfTest(
      scored.errorKind !== 'scoring_error',
      `${id} threw during scoring`,
    );
    return { id, scored };
  });

  const orderInvocation = findInvocation(
    fixture.orderInvocation?.caseId,
    fixture.orderInvocation?.candidateReport,
  );
  const reversedOutput = {
    rawFindings: [
      ...orderInvocation.report.expectedOutput.rawFindings,
    ].reverse(),
  };
  const reversed = scoreResultSafely(
    createSelfTestResponse(reversedOutput),
    validate,
    orderInvocation,
    scoreResult,
  );
  assertSelfTest(reversed.schemaValid, 'reversed output is schema-invalid');
  assertSelfTest(reversed.claimRecall === 1, 'reversed output lost a claim');
  assertSelfTest(
    reversed.findingOrderExact === false,
    'reversed output preserved order',
  );
  assertSelfTest(reversed.passed === false, 'reversed output passed');

  const scoringException = scoreResultSafely(
    createSelfTestResponse(baseInvocation.report.expectedOutput),
    validate,
    baseInvocation,
    () => {
      throw new Error('injected scorer failure');
    },
  );
  assertSelfTest(
    scoringException.errorKind === 'scoring_error',
    'scoring exception was not classified',
  );
  assertSelfTest(
    scoringException.passed === false,
    'scoring exception passed',
  );
  const postErrorControl = scoreResultSafely(
    createSelfTestResponse(baseInvocation.report.expectedOutput),
    validate,
    baseInvocation,
    scoreResult,
  );
  assertSelfTest(
    postErrorControl.passed === true,
    'scoring did not continue after an exception',
  );
  const aggregate = aggregateResults([
    reversed,
    scoringException,
    postErrorControl,
  ])['scorer-self-test'];
  assertSelfTest(
    aggregate.findingOrderExact === 1,
    'aggregate did not count exact finding order',
  );
  assertSelfTest(
    aggregate.scoringErrorCount === 1,
    'aggregate did not count the scoring error',
  );
  return {
    malformed,
    reversed,
    scoringException,
    postErrorControl,
    aggregate,
  };
}

const outputSchema = createRawFindingsOutputJsonSchema();
const validate = new Ajv({
  allErrors: true,
  strict: false,
}).compile(outputSchema);
for (const invocation of invocations) {
  if (!validate(invocation.report.expectedOutput)) {
    throw new Error(
      `Gold schema error in ${invocation.testCase.id} report `
      + `${invocation.report.number}: ${JSON.stringify(validate.errors)}`,
    );
  }
  const goldScore = scoreResult({
    durationMs: 0,
    structuredOutput: invocation.report.expectedOutput,
    status: 'done',
    error: undefined,
    toolUseCount: 0,
    promptArtifactMatchesCurrent: true,
  }, validate, invocation);
  if (!goldScore.passed) {
    throw new Error(
      `Gold scorer error in ${invocation.testCase.id} report `
      + `${invocation.report.number}: ${JSON.stringify(goldScore)}`,
    );
  }
}

if (!scoreOnly && !renderOnly) {
  rmSync(resultDir, { recursive: true, force: true });
}
if (!scoreOnly && !renderOnly && !selfTest) {
  rmSync(isolationDir, { recursive: true, force: true });
  mkdirSync(isolationDir, { recursive: true });
}
mkdirSync(resultDir, { recursive: true });

if (renderOnly) {
  for (const invocation of invocations) {
    const prefix = `${invocation.testCase.id}-p${invocation.report.number}`;
    writeFileSync(
      join(resultDir, `${prefix}.prompt.md`),
      buildPrompt(invocation.report),
    );
    writeFileSync(
      join(resultDir, `${prefix}.gold.json`),
      `${JSON.stringify(invocation.report.expectedOutput, null, 2)}\n`,
    );
  }
  writeFileSync(
    join(resultDir, 'schema.json'),
    `${JSON.stringify(outputSchema, null, 2)}\n`,
  );
  process.stdout.write(
    `Rendered and validated ${invocations.length} independent extraction prompt(s).\n`,
  );
  process.exit(0);
}

if (selfTest) {
  const selfTestResult = runScorerSelfTest(validate);
  writeFileSync(
    join(resultDir, 'scorer-self-test.json'),
    `${JSON.stringify(selfTestResult, null, 2)}\n`,
  );
  process.stdout.write(
    `Scorer self-test passed: ${selfTestResult.malformed.length} malformed `
    + 'outputs, reversed finding order, and injected scoring error.\n',
  );
  process.exit(0);
}

const results = [];
let cleanupError;
try {
  for (const target of targets) {
    const config = targetConfigs[target];
    for (let repetition = 1; repetition <= repeat; repetition += 1) {
      for (const invocation of invocations) {
        const outputBase = join(
          resultDir,
          `${target}-r${repetition}-${invocation.testCase.id}`
          + `-p${invocation.report.number}`,
        );
        const schemaPath = `${outputBase}.schema.json`;
        const promptArtifactPath = `${outputBase}.prompt.md`;
        const currentPrompt = buildPrompt(invocation.report);
        const currentPromptSha256 = sha256(currentPrompt);
        writeFileSync(schemaPath, `${JSON.stringify(outputSchema, null, 2)}\n`);
        let response;
        let durationMs;
        let promptArtifactSha256;
        if (scoreOnly) {
          try {
            const stored = readStoredResponse(
              `${outputBase}.result.json`,
              promptArtifactPath,
            );
            ({ durationMs, ...response } = stored);
            promptArtifactSha256 = response.promptArtifactSha256;
          } catch (error) {
            ({ durationMs, ...response } = errorResponse(error, 0));
          }
        } else {
          writeFileSync(promptArtifactPath, currentPrompt);
          promptArtifactSha256 = currentPromptSha256;
          const startedAt = Date.now();
          try {
            if (config.provider === 'codex') {
              response = await callCodex(
                config,
                currentPrompt,
                schemaPath,
                outputBase,
              );
            } else if (config.provider === 'claude') {
              response = await callClaude(
                config,
                currentPrompt,
                outputSchema,
              );
            } else {
              response = await callGemma(currentPrompt, outputSchema);
            }
            durationMs = Date.now() - startedAt;
          } catch (error) {
            durationMs = Date.now() - startedAt;
            response = errorResponse(error, durationMs);
          }
        }
        const scored = scoreResultSafely({
          target,
          provider: config.provider,
          model: config.model,
          repetition,
          durationMs,
          currentPromptSha256,
          promptArtifactSha256,
          promptArtifactMatchesCurrent: (
            promptArtifactSha256 === currentPromptSha256
          ),
          ...response,
        }, validate, invocation, scoreResult);
        results.push(scored);
        writeFileSync(
          `${outputBase}${scoreOnly ? '.rescored.json' : '.result.json'}`,
          `${JSON.stringify(scored, null, 2)}\n`,
        );
      }
    }
  }
} finally {
  if (!scoreOnly) {
    try {
      await resetSharedServer();
    } catch (error) {
      cleanupError = error instanceof Error ? error.message : String(error);
    }
  }
}

const summary = {
  suite: 'finding-report-normalizer-extraction-only',
  resultSet,
  invocationMode: 'one-report-per-isolated-call',
  modelInputBoundary: {
    repositoryContentSupplied: false,
    repositoryWorkingDirectorySupplied: false,
    workingDirectory: 'empty temporary directory',
  },
  providerCapabilityBoundary: {
    codex: {
      toolsFullyDisabled: false,
      retainedCapability: 'Codex CLI tool layer, including read-only shell',
      sandbox: 'read-only',
      repositoryFilesystemReadCapabilityRemoved: false,
      toolUseAccounting: 'completed JSONL tool events',
    },
    claude: {
      requestedAllowedTools: [],
      permissionMode: 'readonly',
      toolUseAccounting: 'explicit empty allowedTools boundary',
    },
    opencode: {
      requestedAllowedTools: [],
      permissionMode: 'readonly',
      toolUseAccounting: 'explicit empty allowedTools boundary',
    },
  },
  promptSource: 'src/shared/prompts/finding-intake-extraction.ts',
  promptTemplateSha256: sha256(promptTemplate),
  promptArtifactPassCondition: (
    'stored invocation prompt SHA-256 matches the current rendered prompt'
  ),
  toolUsePassCondition: 'toolUseCount === 0',
  outputContract: 'RawFindingsOutputJsonSchema',
  repeat,
  timeoutMs,
  cleanupError,
  results,
  aggregates: aggregateResults(results),
  passed: cleanupError === undefined
    && results.every(({ passed }) => passed),
};
writeFileSync(
  join(resultDir, scoreOnly ? 'summary.rescored.json' : 'summary.json'),
  `${JSON.stringify(summary, null, 2)}\n`,
);
for (const result of results) {
  process.stdout.write(
    `${result.passed ? 'PASS' : 'FAIL'} ${result.target} `
    + `case=${result.caseId} report=${result.candidateReport} `
    + `prompt=${result.promptArtifactMatchesCurrent ? '1' : '0'} `
    + `schema=${result.schemaValid ? '1' : '0'} `
    + `recall=${result.claimRecall.toFixed(2)} `
    + `binding=${result.sourceBindingRate.toFixed(2)} `
    + `candidate=${result.candidateExactRate.toFixed(2)} `
    + `non-fabrication=${result.nonFabricationPassed ? '1' : '0'} `
    + `ambiguity=${result.ambiguityPreservationRate.toFixed(2)} `
    + `order=${result.findingOrderExact ? '1' : '0'} `
    + `mixing=${result.noCrossReportMixing ? '0' : '1'} `
    + `scoring-error=${result.errorKind === 'scoring_error' ? '1' : '0'} `
    + `tools=${result.toolUseCount} duration-ms=${result.durationMs}\n`,
  );
}
process.exitCode = summary.passed ? 0 : 1;
