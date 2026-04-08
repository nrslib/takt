/**
 * Phase execution logic extracted from engine.ts.
 *
 * Handles Phase 2 (report output) and Phase 3 (status judgment)
 * as session-resume operations.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import type { WorkflowStep, Language, AgentResponse } from '../models/types.js';
import type { StructuredCaller } from '../../agents/structured-caller.js';
import type { PhaseName, PhasePromptParts, JudgeStageEntry, ProviderType, StepProviderInfo } from './types.js';
import type { RunAgentOptions } from '../../agents/runner.js';
import { ReportInstructionBuilder } from './instruction/ReportInstructionBuilder.js';
import { hasTagBasedRules, getReportFiles } from './evaluation/rule-utils.js';
import { executeAgent } from '../../agents/agent-usecases.js';
import { createLogger } from '../../shared/utils/index.js';
import { buildSessionKey } from './session-key.js';
export { runStatusJudgmentPhase, type StatusJudgmentPhaseResult } from './status-judgment-phase.js';

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
  /** Parent workflow iteration for sub-step phase events */
  iteration?: number;
  /** Get persona session ID */
  getSessionId: (persona: string) => string | undefined;
  /** Build resume options for a step */
  buildResumeOptions: (step: WorkflowStep, sessionId: string, overrides: Pick<RunAgentOptions, 'maxTurns'>) => RunAgentOptions;
  /** Build options for report phase retry in a new session */
  buildNewSessionReportOptions: (step: WorkflowStep, overrides: Pick<RunAgentOptions, 'allowedTools' | 'maxTurns'>) => RunAgentOptions;
  /** Update persona session after a phase run */
  updatePersonaSession: (persona: string, sessionId: string | undefined) => void;
  /** Stream callback for provider event logging (passed to judgeStatus) */
  onStream?: import('../../agents/types.js').StreamCallback;
  /** Structured caller for phase 3 status judgment */
  structuredCaller: StructuredCaller;
  /** Resolve effective provider for the current step */
  resolveProvider: (step: WorkflowStep) => ProviderType | undefined;
  resolveStepProviderModel?: (step: WorkflowStep) => StepProviderInfo;
  /** Callback for phase lifecycle logging */
  onPhaseStart?: (
    step: WorkflowStep,
    phase: 1 | 2 | 3,
    phaseName: PhaseName,
    instruction: string,
    promptParts: PhasePromptParts,
    phaseExecutionId?: string,
    iteration?: number,
  ) => void;
  /** Callback for phase completion logging */
  onPhaseComplete?: (
    step: WorkflowStep,
    phase: 1 | 2 | 3,
    phaseName: PhaseName,
    content: string,
    status: string,
    error?: string,
    phaseExecutionId?: string,
    iteration?: number,
  ) => void;
  /** Callback for Phase 3 internal stage logging */
  onJudgeStage?: (
    step: WorkflowStep,
    phase: 3,
    phaseName: 'judge',
    entry: JudgeStageEntry,
    phaseExecutionId?: string,
    iteration?: number,
  ) => void;
}

/**
 * Check if a step needs Phase 3 (status judgment).
 * Returns true when at least one rule requires tag-based detection.
 */
export function needsStatusJudgmentPhase(step: WorkflowStep): boolean {
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
  if (!currentSessionId) {
    throw new Error(`Report phase requires a session to resume, but no sessionId found for persona "${sessionKey}" in step "${step.name}"`);
  }

  log.debug('Running report phase', { step: step.name, sessionId: currentSessionId });

  const reportFiles = getReportFiles(step.outputContracts);
  if (reportFiles.length === 0) {
    log.debug('No report files configured, skipping report phase');
    return;
  }

  for (const fileName of reportFiles) {
    if (!fileName) {
      throw new Error(`Invalid report file name: ${fileName}`);
    }

    log.debug('Generating report file', { step: step.name, fileName });

    const reportInstruction = new ReportInstructionBuilder(step, {
      cwd: ctx.cwd,
      reportDir: ctx.reportDir,
      stepIteration,
      language: ctx.language,
      targetFile: fileName,
    }).build();

    const reportOptions = ctx.buildResumeOptions(step, currentSessionId, {
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
      log.debug('Report file generated', { step: step.name, fileName });
      continue;
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
    log.debug('Report file generated', { step: step.name, fileName });
  }

  log.debug('Report phase complete', { step: step.name, filesGenerated: reportFiles.length });
}

type ReportAttemptResult =
  | { kind: 'success'; content: string; response: AgentResponse }
  | { kind: 'blocked'; response: AgentResponse }
  | { kind: 'retryable_failure'; errorMessage: string };

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
    ctx.onPhaseComplete?.(step, 2, 'report', '', 'error', errorMsg, undefined, ctx.iteration);
    throw error;
  }

  if (response.status === 'blocked') {
    ctx.onPhaseComplete?.(step, 2, 'report', response.content, response.status, undefined, undefined, ctx.iteration);
    return { kind: 'blocked', response };
  }

  if (response.status !== 'done') {
    const errorMessage = response.error || response.content || 'Unknown error';
    ctx.onPhaseComplete?.(step, 2, 'report', response.content, response.status, errorMessage, undefined, ctx.iteration);
    return { kind: 'retryable_failure', errorMessage };
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
