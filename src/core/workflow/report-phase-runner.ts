import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import type { AgentResponse, WorkflowStep } from '../models/types.js';
import { resolveAgentErrorMessage } from '../models/response.js';
import type { RunAgentOptions } from '../../agents/runner.js';
import { executeAgent } from '../../agents/agent-usecases.js';
import { createLogger } from '../../shared/utils/index.js';
import { ReportInstructionBuilder } from './instruction/ReportInstructionBuilder.js';
import { getReportFiles } from './evaluation/rule-utils.js';
import { buildSessionKey } from './session-key.js';
import type { PhaseRunnerContext } from './phase-runner.js';

const log = createLogger('phase-runner');

/** Result when Phase 2 encounters a blocked status */
export type ReportPhaseBlockedResult = { blocked: true; response: AgentResponse };

function formatHistoryTimestamp(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hour = String(date.getUTCHours()).padStart(2, '0');
  const minute = String(date.getUTCMinutes()).padStart(2, '0');
  const second = String(date.getUTCSeconds()).padStart(2, '0');
  return `${year}${month}${day}T${hour}${minute}${second}Z`;
}

function buildVersionedFileName(fileName: string, timestamp: string, sequence: number): string {
  const duplicateSuffix = sequence === 0 ? '' : `.${sequence}`;
  return `${fileName}.${timestamp}${duplicateSuffix}`;
}

function backupExistingReport(reportDir: string, fileName: string, targetPath: string): void {
  if (!existsSync(targetPath)) {
    return;
  }

  const currentContent = readFileSync(targetPath, 'utf-8');
  const timestamp = formatHistoryTimestamp(new Date());
  let sequence = 0;
  let versionedPath = resolve(reportDir, buildVersionedFileName(fileName, timestamp, sequence));
  while (existsSync(versionedPath)) {
    sequence += 1;
    versionedPath = resolve(reportDir, buildVersionedFileName(fileName, timestamp, sequence));
  }

  writeFileSync(versionedPath, currentContent);
}

function writeReportFile(reportDir: string, fileName: string, content: string): void {
  const baseDir = resolve(reportDir);
  const targetPath = resolve(reportDir, fileName);
  const basePrefix = baseDir.endsWith(sep) ? baseDir : baseDir + sep;
  if (!targetPath.startsWith(basePrefix)) {
    throw new Error(`Report file path escapes report directory: ${fileName}`);
  }
  mkdirSync(dirname(targetPath), { recursive: true });
  backupExistingReport(baseDir, fileName, targetPath);
  writeFileSync(targetPath, content);
}

/**
 * Phase 2: Report output.
 * Resumes the agent session with no tools to request report content.
 * Each report file is generated individually in a loop.
 * Plain text responses are written directly to files (no JSON parsing).
 */
export async function runReportPhase(
  step: WorkflowStep,
  stepIteration: number,
  ctx: PhaseRunnerContext,
): Promise<ReportPhaseBlockedResult | void> {
  const sessionKey = buildSessionKey(step);
  let currentSessionId = ctx.getSessionId(sessionKey);
  const hasLastResponse = ctx.lastResponse != null && ctx.lastResponse.trim().length > 0;

  log.debug('Running report phase', {
    step: step.name,
    hasSession: currentSessionId !== undefined,
    hasLastResponse,
  });

  const reportFiles = getReportFiles(step.outputContracts);
  if (reportFiles.length === 0) {
    log.debug('No report files configured, skipping report phase');
    return;
  }

  for (const fileName of reportFiles) {
    if (!fileName) {
      throw new Error(`Invalid report file name: ${fileName}`);
    }

    if (!currentSessionId && !hasLastResponse) {
      throw new Error(`Report phase requires a session to resume, but no sessionId found for persona "${sessionKey}" in step "${step.name}"`);
    }

    log.debug('Generating report file', { step: step.name, fileName });

    const firstAttemptInstruction = new ReportInstructionBuilder(step, {
      cwd: ctx.cwd,
      reportDir: ctx.reportDir,
      stepIteration,
      language: ctx.language,
      targetFile: fileName,
      lastResponse: currentSessionId ? undefined : ctx.lastResponse,
    }).build();
    const firstAttemptOptions = currentSessionId
      ? ctx.buildResumeOptions(step, currentSessionId, {
        maxTurns: 3,
      })
      : buildNewSessionRetryOptions(step, ctx);

    const firstAttempt = await runSingleReportAttempt(
      step,
      firstAttemptInstruction,
      firstAttemptOptions,
      ctx,
    );
    if (firstAttempt.kind === 'blocked') {
      return { blocked: true, response: firstAttempt.response };
    }
    if (firstAttempt.kind === 'success') {
      writeReportFile(ctx.reportDir, fileName, firstAttempt.content);
      if (firstAttempt.response.sessionId) {
        currentSessionId = firstAttempt.response.sessionId;
        ctx.updatePersonaSession(sessionKey, currentSessionId);
      }
      log.debug('Report file generated', { step: step.name, fileName });
      continue;
    }

    if (!currentSessionId || !hasLastResponse || firstAttempt.errorKind === 'rate_limit') {
      throw new Error(`Report phase failed for ${fileName}: ${firstAttempt.errorMessage}`);
    }

    log.info('Report phase failed, retrying with new session', {
      step: step.name,
      fileName,
      reason: firstAttempt.errorMessage,
    });

    const retryInstruction = new ReportInstructionBuilder(step, {
      cwd: ctx.cwd,
      reportDir: ctx.reportDir,
      stepIteration,
      language: ctx.language,
      targetFile: fileName,
      lastResponse: ctx.lastResponse,
    }).build();
    const retryOptions = buildNewSessionRetryOptions(step, ctx);

    const retryAttempt = await runSingleReportAttempt(step, retryInstruction, retryOptions, ctx);
    if (retryAttempt.kind === 'blocked') {
      return { blocked: true, response: retryAttempt.response };
    }
    if (retryAttempt.kind === 'retryable_failure') {
      throw new Error(`Report phase failed for ${fileName}: ${retryAttempt.errorMessage}`);
    }

    writeReportFile(ctx.reportDir, fileName, retryAttempt.content);
    if (retryAttempt.response.sessionId) {
      currentSessionId = retryAttempt.response.sessionId;
      ctx.updatePersonaSession(sessionKey, currentSessionId);
    }
    log.debug('Report file generated', { step: step.name, fileName });
  }

  log.debug('Report phase complete', { step: step.name, filesGenerated: reportFiles.length });
}

function buildNewSessionRetryOptions(step: WorkflowStep, ctx: PhaseRunnerContext): RunAgentOptions {
  return ctx.buildNewSessionReportOptions(step, {
    allowedTools: [],
    maxTurns: 3,
  });
}

type ReportAttemptResult =
  | { kind: 'success'; content: string; response: AgentResponse }
  | { kind: 'blocked'; response: AgentResponse }
  | { kind: 'retryable_failure'; errorMessage: string; errorKind?: AgentResponse['errorKind'] };

async function runSingleReportAttempt(
  step: WorkflowStep,
  instruction: string,
  options: RunAgentOptions,
  ctx: PhaseRunnerContext,
): Promise<ReportAttemptResult> {
  let didEmitPhaseStart = false;
  const callOptions: RunAgentOptions = {
    ...options,
    onPromptResolved: (promptParts) => {
      ctx.onPhaseStart?.(step, 2, 'report', instruction, promptParts, undefined, ctx.iteration);
      didEmitPhaseStart = true;
    },
  };

  let response: AgentResponse;
  try {
    response = await executeAgent(step.persona, instruction, callOptions);
    if (!didEmitPhaseStart) {
      throw new Error(`Missing prompt parts for phase start: ${step.name}:2`);
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    if (didEmitPhaseStart) {
      ctx.onPhaseComplete?.(step, 2, 'report', '', 'error', errorMsg, undefined, ctx.iteration);
    }
    throw error;
  }

  if (response.status === 'blocked') {
    ctx.onPhaseComplete?.(step, 2, 'report', response.content, response.status, undefined, undefined, ctx.iteration);
    return { kind: 'blocked', response };
  }

  if (response.status !== 'done') {
    const fallbackMessage = response.error || response.content || 'Unknown error';
    const errorMessage = resolveAgentErrorMessage(response.errorKind, fallbackMessage);
    ctx.onPhaseComplete?.(step, 2, 'report', response.content, response.status, errorMessage, undefined, ctx.iteration);
    return { kind: 'retryable_failure', errorMessage, errorKind: response.errorKind };
  }

  const trimmedContent = response.content.trim();
  if (trimmedContent.length === 0) {
    const errorMessage = 'Report output is empty';
    ctx.onPhaseComplete?.(step, 2, 'report', response.content, 'error', errorMessage, undefined, ctx.iteration);
    return { kind: 'retryable_failure', errorMessage };
  }

  ctx.onPhaseComplete?.(step, 2, 'report', response.content, response.status, undefined, undefined, ctx.iteration);
  return { kind: 'success', content: trimmedContent, response };
}
