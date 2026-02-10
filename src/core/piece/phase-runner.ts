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

    ctx.onPhaseStart?.(step, 2, 'report', reportInstruction);

    const reportOptions = ctx.buildResumeOptions(step, currentSessionId, {
      allowedTools: [],
      maxTurns: 3,
    });

    let reportResponse;
    try {
      reportResponse = await runAgent(step.persona, reportInstruction, reportOptions);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      ctx.onPhaseComplete?.(step, 2, 'report', '', 'error', errorMsg);
      throw error;
    }

    if (reportResponse.status === 'blocked') {
      ctx.onPhaseComplete?.(step, 2, 'report', reportResponse.content, reportResponse.status);
      return { blocked: true, response: reportResponse };
    }

    if (reportResponse.status !== 'done') {
      const errorMsg = reportResponse.error || reportResponse.content || 'Unknown error';
      ctx.onPhaseComplete?.(step, 2, 'report', reportResponse.content, reportResponse.status, errorMsg);
      throw new Error(`Report phase failed for ${fileName}: ${errorMsg}`);
    }

    const content = reportResponse.content.trim();
    if (content.length === 0) {
      throw new Error(`Report output is empty for file: ${fileName}`);
    }

    writeReportFile(ctx.reportDir, fileName, content);

    if (reportResponse.sessionId) {
      currentSessionId = reportResponse.sessionId;
      ctx.updatePersonaSession(sessionKey, currentSessionId);
    }

    ctx.onPhaseComplete?.(step, 2, 'report', reportResponse.content, reportResponse.status);
    log.debug('Report file generated', { movement: step.name, fileName });
  }

  log.debug('Report phase complete', { movement: step.name, filesGenerated: reportFiles.length });
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

  // フォールバック戦略を順次試行（AutoSelectStrategy含む）
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

  // 全戦略失敗
  const errorMsg = 'All judgment strategies failed';
  ctx.onPhaseComplete?.(step, 3, 'judge', '', 'error', errorMsg);
  throw new Error(errorMsg);
}
