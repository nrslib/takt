#!/usr/bin/env node
import { spawn } from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import {
  RawFindingsOutputJsonSchema,
  createRawFindingsOutputJsonSchema,
} from '../../dist/core/models/finding-schemas.js';
import {
  callClaudeCustom,
} from '../../dist/infra/claude/client.js';
import {
  callOpenCodeCustom,
  resetSharedServer,
} from '../../dist/infra/opencode/client.js';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const evalDir = resolve(scriptDir, '..');
const caseDir = join(evalDir, 'cases', 'finding-normalizer');
const workDir = join(evalDir, '.work', 'finding-normalizer');
const resultRootDir = join(workDir, 'results');
const isolationDir = join(tmpdir(), 'takt-finding-normalizer');

const targetConfigs = {
  sol: { provider: 'codex', model: 'gpt-5.6-sol' },
  luna: { provider: 'codex', model: 'gpt-5.6-luna' },
  terra: { provider: 'codex', model: 'gpt-5.6-terra' },
  opus: { provider: 'claude', model: 'opus' },
  haiku: { provider: 'claude', model: 'haiku' },
  sonnet: { provider: 'claude', model: 'sonnet' },
  gemma4: { provider: 'opencode', model: 'ollama-cloud/gemma4:31b' },
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

const renderOnly = process.argv.includes('--render-only');
const scoreOnly = process.argv.includes('--score-only');
if (renderOnly && scoreOnly) {
  throw new Error('--render-only and --score-only cannot be used together');
}

const resultSet = parseSafeName(
  readOption('--result-set') ?? 'current',
  '--result-set',
);
const resultDir = join(resultRootDir, resultSet);
const modelOption = readOption('--models');
if (!modelOption && !renderOnly) {
  throw new Error(
    `Specify targets explicitly: --models ${Object.keys(targetConfigs).join(',')}`,
  );
}
const targets = (modelOption ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
for (const target of targets) {
  if (!(target in targetConfigs)) {
    throw new Error(
      `Unknown target "${target}". Available: ${Object.keys(targetConfigs).join(', ')}`,
    );
  }
}

const batchSize = parsePositiveInteger(
  readOption('--batch-size') ?? '1',
  '--batch-size',
);
if (batchSize !== 1) {
  throw new Error('The finding normalizer requires --batch-size 1');
}
const repeat = parsePositiveInteger(readOption('--repeat') ?? '1', '--repeat');
const timeoutMs = parsePositiveInteger(
  readOption('--timeout-ms') ?? String(10 * 60 * 1000),
  '--timeout-ms',
);
const reportOption = readOption('--reports');
const requestedReports = reportOption
  ? reportOption
    .split(',')
    .map((value) => parsePositiveInteger(value.trim(), '--reports'))
  : undefined;

function parseReports(caseSource) {
  const marker = '## Candidate reports\n\n';
  const markerIndex = caseSource.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error('Candidate reports were not found');
  }
  const reports = caseSource
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

function buildPrompt(report) {
  return `You are a deterministic JSON assembler, not a reviewer, verifier,
classifier, or normalizer that invents values.

Return exactly one JSON object matching the supplied RawFindingsOutputJsonSchema.
Return no prose, Markdown fence, or keys outside that schema.

The input below is self-contained:
- rawExcerpt and every nullable candidate field are explicitly supplied.
- Copy the typed target and evidenceRequests exactly. They are requests only;
  never add proofId, snapshotId, runId, offsets, digests, or query results.
- Treat the supplied JSON fragments as JSON values: decode each JSON escape
  sequence exactly once, then serialize the decoded value exactly once in the
  output JSON. For example, an input JSON string containing "\\n" represents
  a newline in the value. Do not change it into literal backslash+n characters
  and do not double-escape it.
- Do not infer, summarize, translate, classify, repair, or add any value.
- Keep raw findings in input order.
- When the input explicitly says there are no raw findings, return
  {"rawFindings":[]}.

## Normalizer input

${report.content}
`;
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
  const controller = new AbortController();
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
      // Keep unparsed diagnostics in the JSONL artifact.
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
      'finding-normalizer',
      prompt,
      'Assemble only the supplied fields into the required JSON schema.',
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
      'finding-normalizer',
      prompt,
      'Assemble only the supplied fields into the required JSON schema.',
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

function readStoredResponse(resultPath) {
  const stored = JSON.parse(readFileSync(resultPath, 'utf8'));
  if (!Number.isSafeInteger(stored.toolUseCount) || stored.toolUseCount < 0) {
    throw new Error(`Invalid toolUseCount in ${resultPath}`);
  }
  return {
    durationMs: stored.durationMs,
    structuredOutput: stored.structuredOutput,
    providerUsage: stored.providerUsage,
    status: stored.status,
    error: stored.error,
    toolUseCount: stored.toolUseCount,
  };
}

function countExtraKeys(output) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return null;
  const topLevelAllowed = new Set(
    Object.keys(RawFindingsOutputJsonSchema.properties),
  );
  let count = Object.keys(output).filter((key) => !topLevelAllowed.has(key)).length;
  if (!Array.isArray(output.rawFindings)) return count;
  const itemAllowed = new Set(
    Object.keys(
      RawFindingsOutputJsonSchema.properties.rawFindings.items.properties,
    ),
  );
  for (const rawFinding of output.rawFindings) {
    if (!rawFinding || typeof rawFinding !== 'object' || Array.isArray(rawFinding)) {
      continue;
    }
    count += Object.keys(rawFinding).filter((key) => !itemAllowed.has(key)).length;
  }
  return count;
}

function scoreResult(result, validate, expectedOutput, report) {
  const output = result.structuredOutput;
  const schemaValid = validate(output);
  const executionCompleted = result.status === 'done'
    && (
      result.error === undefined
      || result.error === null
      || result.error === ''
    );
  const expectedRawFindings = expectedOutput.rawFindings;
  const actualRawFindings = Array.isArray(output?.rawFindings)
    ? output.rawFindings
    : [];
  const requiredFields = (
    RawFindingsOutputJsonSchema.properties.rawFindings.items.required
  );
  let exactFieldCount = 0;
  const expectedFieldCount = expectedRawFindings.length * requiredFields.length;
  for (let index = 0; index < expectedRawFindings.length; index += 1) {
    const expectedFinding = expectedRawFindings[index];
    const actualFinding = actualRawFindings[index];
    for (const field of requiredFields) {
      if (isDeepStrictEqual(actualFinding?.[field], expectedFinding[field])) {
        exactFieldCount += 1;
      }
    }
  }
  const extraKeyCount = countExtraKeys(output);
  const outputExact = isDeepStrictEqual(output, expectedOutput);
  const exactGoldPassed = executionCompleted
    && schemaValid
    && result.toolUseCount === 0
    && extraKeyCount === 0
    && outputExact;

  return {
    ...result,
    candidateReport: report.number,
    structuredOutput: output,
    executionCompleted,
    schemaValid,
    schemaErrors: schemaValid ? [] : validate.errors,
    expectedRawFindingCount: expectedRawFindings.length,
    actualRawFindingCount: actualRawFindings.length,
    rawFindingCountExact: (
      actualRawFindings.length === expectedRawFindings.length
    ),
    requiredFieldExactRate: expectedFieldCount === 0
      ? 1
      : exactFieldCount / expectedFieldCount,
    extraKeyCount,
    outputExact,
    exactGoldPassed,
    outputContract: 'RawFindingsOutputJsonSchema',
  };
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

function aggregateResults(results) {
  const byTarget = {};
  for (const result of results) {
    const aggregate = byTarget[result.target] ?? {
      executions: 0,
      executionCompleted: 0,
      exactGoldPassed: 0,
      exactRequiredFields: 0,
      requiredFields: 0,
      extraKeyCount: 0,
      maxDurationMs: 0,
    };
    const requiredFieldsPerFinding = (
      RawFindingsOutputJsonSchema.properties.rawFindings.items.required.length
    );
    const requiredFields = result.expectedRawFindingCount
      * requiredFieldsPerFinding;
    aggregate.executions += 1;
    aggregate.executionCompleted += result.executionCompleted ? 1 : 0;
    aggregate.exactGoldPassed += result.exactGoldPassed ? 1 : 0;
    aggregate.requiredFields += requiredFields;
    aggregate.exactRequiredFields += result.requiredFieldExactRate * requiredFields;
    aggregate.extraKeyCount += Number.isInteger(result.extraKeyCount)
      ? result.extraKeyCount
      : 0;
    aggregate.maxDurationMs = Math.max(
      aggregate.maxDurationMs,
      Number.isFinite(result.durationMs) ? result.durationMs : 0,
    );
    byTarget[result.target] = aggregate;
  }
  return byTarget;
}

const gold = JSON.parse(
  readFileSync(join(caseDir, 'fc-json-assembly.gold.json'), 'utf8'),
);
const caseReports = parseReports(
  readFileSync(join(caseDir, 'fc-json-assembly.md'), 'utf8'),
);
const selectedReports = requestedReports === undefined
  ? caseReports
  : caseReports.filter(({ number }) => requestedReports.includes(number));
if (
  requestedReports !== undefined
  && (
    selectedReports.length !== requestedReports.length
    || new Set(requestedReports).size !== requestedReports.length
  )
) {
  throw new Error(
    `--reports must contain unique candidate report numbers from 1 to ${caseReports.length}`,
  );
}

if (!scoreOnly && !renderOnly) {
  rmSync(resultDir, { recursive: true, force: true });
  rmSync(isolationDir, { recursive: true, force: true });
  mkdirSync(isolationDir, { recursive: true });
}
mkdirSync(resultDir, { recursive: true });

if (renderOnly) {
  for (const report of selectedReports) {
    const expected = gold.reports[String(report.number)];
    if (!expected) {
      throw new Error(`Gold is missing candidate report ${report.number}`);
    }
    const outputSchema = createRawFindingsOutputJsonSchema();
    const validate = new Ajv({
      allErrors: true,
      strict: false,
    }).compile(outputSchema);
    if (!validate(expected.output) || countExtraKeys(expected.output) !== 0) {
      throw new Error(
        `Gold does not match RawFindingsOutputJsonSchema for report ${report.number}: `
        + JSON.stringify(validate.errors ?? []),
      );
    }
    writeFileSync(
      join(resultDir, `rendered-p${report.number}.prompt.md`),
      buildPrompt(report),
    );
    writeFileSync(
      join(resultDir, `rendered-p${report.number}.schema.json`),
      `${JSON.stringify(outputSchema, null, 2)}\n`,
    );
  }
  process.stdout.write(
    `Rendered ${selectedReports.length} direct-FC prompt(s) without model calls.\n`,
  );
  process.exit(0);
}

const results = [];
let cleanupError;
try {
  for (const target of targets) {
    const config = targetConfigs[target];
    for (let repetition = 1; repetition <= repeat; repetition += 1) {
      for (const report of selectedReports) {
        const expected = gold.reports[String(report.number)];
        if (!expected?.output) {
          throw new Error(`Gold is incomplete for candidate report ${report.number}`);
        }
        const outputSchema = createRawFindingsOutputJsonSchema();
        const validate = new Ajv({
          allErrors: true,
          strict: false,
        }).compile(outputSchema);
        const outputBase = join(
          resultDir,
          `${target}-r${repetition}-p${report.number}`,
        );
        const schemaPath = `${outputBase}.schema.json`;
        writeFileSync(schemaPath, `${JSON.stringify(outputSchema, null, 2)}\n`);

        let response;
        let durationMs;
        if (scoreOnly) {
          try {
            const stored = readStoredResponse(`${outputBase}.result.json`);
            ({ durationMs, ...response } = stored);
          } catch (error) {
            ({ durationMs, ...response } = errorResponse(error, 0));
          }
        } else {
          const prompt = buildPrompt(report);
          writeFileSync(`${outputBase}.prompt.md`, prompt);
          const startedAt = Date.now();
          try {
            if (config.provider === 'codex') {
              response = await callCodex(config, prompt, schemaPath, outputBase);
            } else if (config.provider === 'claude') {
              response = await callClaude(config, prompt, outputSchema);
            } else {
              response = await callGemma(prompt, outputSchema);
            }
            durationMs = Date.now() - startedAt;
          } catch (error) {
            durationMs = Date.now() - startedAt;
            response = errorResponse(error, durationMs);
          }
        }

        const scored = scoreResult({
          target,
          provider: config.provider,
          model: config.model,
          repetition,
          durationMs,
          ...response,
        }, validate, expected.output, report);
        results.push(scored);
        const suffix = scoreOnly ? '.rescored.json' : '.result.json';
        writeFileSync(
          `${outputBase}${suffix}`,
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
  suite: 'finding-normalizer-direct-fc-json',
  outputSet: resultSet,
  invocationMode: 'one-self-contained-report-per-call',
  outputContract: 'RawFindingsOutputJsonSchema',
  repeat,
  timeoutMs,
  cleanupError,
  results,
  aggregates: aggregateResults(results),
  exactGoldPassed: cleanupError === undefined
    && results.every(({ exactGoldPassed }) => exactGoldPassed),
};
writeFileSync(
  join(resultDir, scoreOnly ? 'summary.rescored.json' : 'summary.json'),
  `${JSON.stringify(summary, null, 2)}\n`,
);
for (const result of results) {
  process.stdout.write(
    `${result.exactGoldPassed ? 'EXACT_GOLD_PASS' : 'EXACT_GOLD_FAIL'} `
    + `${result.target} report=${result.candidateReport} `
    + `completed=${result.executionCompleted ? '1' : '0'} `
    + `schema=${result.schemaValid ? '1' : '0'} `
    + `fields=${result.requiredFieldExactRate.toFixed(2)} `
    + `extra-keys=${result.extraKeyCount ?? 'n/a'} `
    + `duration-ms=${result.durationMs}\n`,
  );
}
process.exitCode = summary.exactGoldPassed ? 0 : 1;
