/**
 * Phase execution logic extracted from engine.ts.
 *
 * Handles Phase 2 (report output) and Phase 3 (status judgment)
 * as session-resume operations.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, parse, resolve, sep } from 'node:path';
import type { PieceMovement, Language, AgentResponse } from '../models/types.js';
import type { PhaseName } from './types.js';
import { runAgent, type RunAgentOptions } from '../../agents/runner.js';
import { ReportInstructionBuilder } from './instruction/ReportInstructionBuilder.js';
import { hasTagBasedRules, getReportFiles } from './evaluation/rule-utils.js';
import { JudgmentStrategyFactory, type JudgmentContext } from './judgment/index.js';
import { createLogger } from '../../shared/utils/index.js';
import { buildSessionKey } from './session-key.js';

const log = createLogger('phase-runner');

/** Result when Phase 2 encounters a blocked status */
export type ReportPhaseBlockedResult = { blocked: true; response: AgentResponse };

export interface PhaseRunnerContext {
  /** Working directory (agent work dir, may be a clone) */
  cwd: string;
  /** Report directory path */
  reportDir: string;
  /** Language for instructions */
  language?: Language;
  /** Whether interactive-only rules are enabled */
  interactive?: boolean;
  /** Last response from Phase 1 */
  lastResponse?: string;
  /** Get persona session ID */
  getSessionId: (persona: string) => string | undefined;
  /** Build resume options for a movement */
  buildResumeOptions: (step: PieceMovement, sessionId: string, overrides: Pick<RunAgentOptions, 'allowedTools' | 'maxTurns'>) => RunAgentOptions;
  /** Build options for report phase retry in a new session */
  buildNewSessionReportOptions: (step: PieceMovement, overrides: Pick<RunAgentOptions, 'allowedTools' | 'maxTurns'>) => RunAgentOptions;
  /** Update persona session after a phase run */
  updatePersonaSession: (persona: string, sessionId: string | undefined) => void;
  /** Callback for phase lifecycle logging */
  onPhaseStart?: (step: PieceMovement, phase: 1 | 2 | 3, phaseName: PhaseName, instruction: string) => void;
  /** Callback for phase completion logging */
  onPhaseComplete?: (step: PieceMovement, phase: 1 | 2 | 3, phaseName: PhaseName, content: string, status: string, error?: string) => void;
}

/**
 * Check if a movement needs Phase 3 (status judgment).
 * Returns true when at least one rule requires tag-based detection.
 */
export function needsStatusJudgmentPhase(step: PieceMovement): boolean {
  return hasTagBasedRules(step);
}

function formatHistoryTimestamp(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hour = String(date.getUTCHours()).padStart(2, '0');
  const minute = String(date.getUTCMinutes()).padStart(2, '0');
  const second = String(date.getUTCSeconds()).padStart(2, '0');
  return `${year}${month}${day}T${hour}${minute}${second}Z`;
}

function buildHistoryFileName(fileName: string, timestamp: string, sequence: number): string {
  const parsed = parse(fileName);
  const duplicateSuffix = sequence === 0 ? '' : `.${sequence}`;
  return `${parsed.name}.${timestamp}${duplicateSuffix}${parsed.ext}`;
}

function backupExistingReport(reportDir: string, fileName: string, targetPath: string): void {
  if (!existsSync(targetPath)) {
    return;
  }

  const currentContent = readFileSync(targetPath, 'utf-8');
  const historyDir = resolve(reportDir, '..', 'logs', 'reports-history');
  mkdirSync(historyDir, { recursive: true });

  const timestamp = formatHistoryTimestamp(new Date());
  let sequence = 0;
  let historyPath = resolve(historyDir, buildHistoryFileName(fileName, timestamp, sequence));
  while (existsSync(historyPath)) {
    sequence += 1;
    historyPath = resolve(historyDir, buildHistoryFileName(fileName, timestamp, sequence));
  }

  writeFileSync(historyPath, currentContent);
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
  step: PieceMovement,
  movementIteration: number,
  ctx: PhaseRunnerContext,
): Promise<ReportPhaseBlockedResult | void> {
  const sessionKey = buildSessionKey(step);
  let currentSessionId = ctx.getSessionId(sessionKey);
  if (!currentSessionId) {
    throw new Error(`Report phase requires a session to resume, but no sessionId found for persona "${sessionKey}" in movement "${step.name}"`);
  }

  log.debug('Running report phase', { movement: step.name, sessionId: currentSessionId });

  const reportFiles = getReportFiles(step.outputContracts);
  if (reportFiles.length === 0) {
    log.debug('No report files configured, skipping report phase');
    return;
  }

  for (const fileName of reportFiles) {
    if (!fileName) {
      throw new Error(`Invalid report file name: ${fileName}`);
    }

    log.debug('Generating report file', { movement: step.name, fileName });

    const reportInstruction = new ReportInstructionBuilder(step, {
      cwd: ctx.cwd,
      reportDir: ctx.reportDir,
      movementIteration: movementIteration,
      language: ctx.language,
      targetFile: fileName,
    }).build();

    const reportOptions = ctx.buildResumeOptions(step, currentSessionId, {
      allowedTools: [],
      maxTurns: 3,
    });
    const firstAttempt = await runSingleReportAttempt(step, reportInstruction, reportOptions, ctx);
    if (firstAttempt.kind === 'blocked') {
      return { blocked: true, response: firstAttempt.response };
    }
    if (firstAttempt.kind === 'success') {
      writeReportFile(ctx.reportDir, fileName, firstAttempt.content);
      if (firstAttempt.response.sessionId) {
        currentSessionId = firstAttempt.response.sessionId;
        ctx.updatePersonaSession(sessionKey, currentSessionId);
      }
      log.debug('Report file generated', { movement: step.name, fileName });
      continue;
    }

    log.info('Report phase failed, retrying with new session', {
      movement: step.name,
      fileName,
      reason: firstAttempt.errorMessage,
    });

    const retryInstruction = new ReportInstructionBuilder(step, {
      cwd: ctx.cwd,
      reportDir: ctx.reportDir,
      movementIteration: movementIteration,
      language: ctx.language,
      targetFile: fileName,
      lastResponse: ctx.lastResponse,
    }).build();
    const retryOptions = ctx.buildNewSessionReportOptions(step, {
      allowedTools: [],
      maxTurns: 3,
    });

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
    log.debug('Report file generated', { movement: step.name, fileName });
  }

  log.debug('Report phase complete', { movement: step.name, filesGenerated: reportFiles.length });
}

type ReportAttemptResult =
  | { kind: 'success'; content: string; response: AgentResponse }
  | { kind: 'blocked'; response: AgentResponse }
  | { kind: 'retryable_failure'; errorMessage: string };

async function runSingleReportAttempt(
  step: PieceMovement,
  instruction: string,
  options: RunAgentOptions,
  ctx: PhaseRunnerContext,
): Promise<ReportAttemptResult> {
  ctx.onPhaseStart?.(step, 2, 'report', instruction);

  let response: AgentResponse;
  try {
    response = await runAgent(step.persona, instruction, options);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    ctx.onPhaseComplete?.(step, 2, 'report', '', 'error', errorMsg);
    throw error;
  }

  if (response.status === 'blocked') {
    ctx.onPhaseComplete?.(step, 2, 'report', response.content, response.status);
    return { kind: 'blocked', response };
  }

  if (response.status !== 'done') {
    const errorMessage = response.error || response.content || 'Unknown error';
    ctx.onPhaseComplete?.(step, 2, 'report', response.content, response.status, errorMessage);
    return { kind: 'retryable_failure', errorMessage };
  }

  const trimmedContent = response.content.trim();
  if (trimmedContent.length === 0) {
    const errorMessage = 'Report output is empty';
    ctx.onPhaseComplete?.(step, 2, 'report', response.content, 'error', errorMessage);
    return { kind: 'retryable_failure', errorMessage };
  }

  ctx.onPhaseComplete?.(step, 2, 'report', response.content, response.status);
  return { kind: 'success', content: trimmedContent, response };
}

/**
 * Phase 3: Status judgment.
 * Uses the 'conductor' agent in a new session to output a status tag.
 * Implements multi-stage fallback logic to ensure judgment succeeds.
 * Returns the Phase 3 response content (containing the status tag).
 */
export async function runStatusJudgmentPhase(
  step: PieceMovement,
  ctx: PhaseRunnerContext,
): Promise<string> {
  log.debug('Running status judgment phase', { movement: step.name });

  const strategies = JudgmentStrategyFactory.createStrategies();
  const sessionKey = buildSessionKey(step);
  const judgmentContext: JudgmentContext = {
    step,
    cwd: ctx.cwd,
    language: ctx.language,
    reportDir: ctx.reportDir,
    lastResponse: ctx.lastResponse,
    sessionId: ctx.getSessionId(sessionKey),
  };

  for (const strategy of strategies) {
    if (!strategy.canApply(judgmentContext)) {
      log.debug(`Strategy ${strategy.name} not applicable, skipping`);
      continue;
    }

    log.debug(`Trying strategy: ${strategy.name}`);
    ctx.onPhaseStart?.(step, 3, 'judge', `Strategy: ${strategy.name}`);

    try {
      const result = await strategy.execute(judgmentContext);
      if (result.success) {
        log.debug(`Strategy ${strategy.name} succeeded`, { tag: result.tag });
        ctx.onPhaseComplete?.(step, 3, 'judge', result.tag!, 'done');
        return result.tag!;
      }

      log.debug(`Strategy ${strategy.name} failed`, { reason: result.reason });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log.debug(`Strategy ${strategy.name} threw error`, { error: errorMsg });
    }
  }

  const errorMsg = 'All judgment strategies failed';
  ctx.onPhaseComplete?.(step, 3, 'judge', '', 'error', errorMsg);
  throw new Error(errorMsg);
}
