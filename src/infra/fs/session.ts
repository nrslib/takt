/**
 * Session management utilities
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { generateReportDir as buildReportDir } from '../../shared/utils/index.js';
import type {
  SessionLog,
  NdjsonRecord,
  NdjsonCompanionReviewMode,
  NdjsonWorkflowStackEntry,
  NdjsonWorkflowStart,
} from '../../shared/utils/index.js';
import {
  appendPrivateFile,
  ensurePrivateDirectory,
  repairPrivateDirectory,
} from '../../shared/utils/private-file.js';
import {
  parseCanonicalWorkflowResumeFrame,
} from '../../shared/types/workflow-resume.js';
import { isAgentFailureCategory } from '../../shared/types/agent-failure.js';
import { parseNdjsonParallelMetadata } from '../../shared/utils/parallelMetadata.js';

export type {
  SessionLog,
  NdjsonWorkflowStart,
  NdjsonWorkflowCallStart,
  NdjsonWorkflowCallComplete,
  NdjsonStepStart,
  NdjsonStepComplete,
  NdjsonWorkflowComplete,
  NdjsonWorkflowAbort,
  NdjsonPhaseStart,
  NdjsonPhaseComplete,
  NdjsonPhaseJudgeStage,
  NdjsonInteractiveStart,
  NdjsonInteractiveEnd,
  NdjsonCompanionReviewRound,
  NdjsonCompanionQueueCoalesced,
  NdjsonCompanionCall,
  NdjsonCompanionReviewSkipped,
  NdjsonCompanionReviewMode,
  NdjsonCompanionReviewTrigger,
  NdjsonParallelMetadata,
  NdjsonRecord,
} from '../../shared/utils/index.js';

/** Failure information extracted from session log */
export interface FailureInfo {
  /** Last step that completed successfully */
  lastCompletedStep: string | null;
  /** Step that was in progress when failure occurred */
  failedStep: string | null;
  /** Total iterations consumed */
  iterations: number;
  /** Error message from workflow_abort record */
  errorMessage: string | null;
  /** Session ID extracted from log file name */
  sessionId: string | null;
}

/**
 * Manages session lifecycle: ID generation, NDJSON logging,
 * and session log creation/loading.
 */
export class SessionManager {
  /** Append a single NDJSON line to a log file */
  appendNdjsonLine(filepath: string, record: NdjsonRecord): void {
    const line = JSON.stringify(record) + '\n';
    try {
      appendPrivateFile(filepath, line);
      if (existsSync(filepath)) {
        return;
      }
    } catch (error: unknown) {
      const logsDir = dirname(filepath);
      if (existsSync(logsDir)) {
        throw error;
      }
    }

    const logsDir = dirname(filepath);
    ensurePrivateDirectory(logsDir);
    repairPrivateDirectory(logsDir);
    process.stderr.write(
      `[takt] Log directory disappeared during execution and was recreated: ${logsDir}. Previous log entries may have been lost.\n`,
    );
    appendPrivateFile(filepath, line);
  }


  /** Initialize an NDJSON log file with the workflow_start record */
  initNdjsonLog(
    sessionId: string,
    task: string,
    workflowName: string,
    options: { logsDir: string; startTime?: string },
  ): string {
    const { logsDir } = options;
    ensurePrivateDirectory(logsDir);
    repairPrivateDirectory(logsDir);

    const filepath = join(logsDir, `${sessionId}.jsonl`);
    const record: NdjsonWorkflowStart = {
      type: 'workflow_start',
      task,
      workflowName,
      startTime: options.startTime ?? new Date().toISOString(),
    };
    this.appendNdjsonLine(filepath, record);
    return filepath;
  }


  /**
   * Load an NDJSON log file and convert it to a SessionLog.
   *
   * @param filepath - Path to the NDJSON session log file
   * @returns The parsed session log, or null if the file is missing, empty, or contains no workflow_start record
   * @throws Error if the file cannot be read or contains an invalid NDJSON record
   */
  loadNdjsonLog(filepath: string): SessionLog | null {
    if (!existsSync(filepath)) {
      return null;
    }

    const content = readFileSync(filepath, 'utf-8');
    const lines = content.trim().split('\n').filter((line) => line.length > 0);
    if (lines.length === 0) return null;

    let sessionLog: SessionLog | null = null;

    for (const line of lines) {
      const record = parseNdjsonRecordWithPath(line, filepath);

      switch (record.type) {
        case 'workflow_start':
          sessionLog = {
            task: record.task,
            projectDir: '',
            workflowName: record.workflowName,
            iterations: 0,
            startTime: record.startTime,
            status: 'running',
            history: [],
          };
          break;

        case 'step_complete':
          if (sessionLog) {
            sessionLog.history.push({
              step: record.step,
              persona: record.persona,
              instruction: record.instruction,
              status: record.status,
              timestamp: record.timestamp,
              content: record.content,
              ...(record.workflow ? { workflow: record.workflow } : {}),
              ...(record.stack ? { stack: record.stack } : {}),
              ...(record.parallel ? { parallel: record.parallel } : {}),
              ...(record.error ? { error: record.error } : {}),
              ...(record.matchedRuleIndex != null ? { matchedRuleIndex: record.matchedRuleIndex } : {}),
              ...(record.matchedRuleMethod ? { matchedRuleMethod: record.matchedRuleMethod } : {}),
              ...(record.matchMethod ? { matchMethod: record.matchMethod } : {}),
              ...(record.failureCategory ? { failureCategory: record.failureCategory } : {}),
            });
            sessionLog.iterations++;
          }
          break;

        case 'workflow_complete':
          if (sessionLog) {
            sessionLog.status = 'completed';
            sessionLog.endTime = record.endTime;
          }
          break;

        case 'workflow_abort':
          if (sessionLog) {
            sessionLog.status = 'aborted';
            sessionLog.endTime = record.endTime;
          }
          break;

        default:
          break;
      }
    }

    return sessionLog;
  }

  /** Generate a session ID */
  generateSessionId(): string {
    const now = new Date();
    const timestamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(
      now.getHours(),
    ).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
    const random = Math.random().toString(36).slice(2, 8);
    return `${timestamp}-${random}`;
  }

  /** Generate report directory name from task and timestamp */
  generateReportDir(task: string): string {
    return buildReportDir(task);
  }

  /** Create a new session log */
  createSessionLog(
    task: string,
    projectDir: string,
    workflowName: string,
    options?: { startTime: string },
  ): SessionLog {
    return {
      task,
      projectDir,
      workflowName,
      iterations: 0,
      startTime: options?.startTime ?? new Date().toISOString(),
      status: 'running',
      history: [],
    };
  }

  /** Create a finalized copy of a session log (immutable) */
  finalizeSessionLog(
    log: SessionLog,
    status: 'completed' | 'aborted',
  ): SessionLog {
    return {
      ...log,
      status,
      endTime: new Date().toISOString(),
    };
  }

  /** Load session log from a .jsonl file */
  loadSessionLog(filepath: string): SessionLog | null {
    return this.loadNdjsonLog(filepath);
  }

}

const defaultManager = new SessionManager();

/**
 * Append one NDJSON session record to a log file.
 *
 * @param filepath - Path to the session log file
 * @param record - NDJSON record to append
 * @throws Error if the record cannot be appended or the log directory cannot be recreated
 */
export function appendNdjsonLine(filepath: string, record: NdjsonRecord): void {
  defaultManager.appendNdjsonLine(filepath, record);
}

/**
 * Initialize an NDJSON session log with a workflow-start record.
 *
 * @param sessionId - Session identifier used for the log filename
 * @param task - Task associated with the session
 * @param workflowName - Workflow associated with the session
 * @param options - Log directory and optional workflow start time
 * @returns Path to the initialized session log
 * @throws Error if the log directory or initial record cannot be written
 */
export function initNdjsonLog(
  sessionId: string,
  task: string,
  workflowName: string,
  options: { logsDir: string; startTime?: string },
): string {
  return defaultManager.initNdjsonLog(sessionId, task, workflowName, options);
}


/**
 * Load an NDJSON log file and convert it to a session log.
 *
 * @param filepath - Path to the NDJSON session log file
 * @returns The parsed session log, or null if the file is missing, empty, or contains no workflow_start record
 * @throws Error if the file cannot be read or contains an invalid NDJSON record
 */
export function loadNdjsonLog(filepath: string): SessionLog | null {
  return defaultManager.loadNdjsonLog(filepath);
}


/**
 * Generate a timestamped random session identifier.
 *
 * @returns A session identifier suitable for an NDJSON log filename
 */
export function generateSessionId(): string {
  return defaultManager.generateSessionId();
}

/**
 * Generate a report directory name from a task.
 *
 * @param task - Task used to derive the report directory name
 * @returns The generated report directory name
 */
export function generateReportDir(task: string): string {
  return defaultManager.generateReportDir(task);
}

/**
 * Create an empty running session log.
 *
 * @param task - Task associated with the session
 * @param projectDir - Project directory associated with the session
 * @param workflowName - Workflow associated with the session
 * @param options - Optional session start time
 * @returns A running session log with zero iterations and an empty history
 */
export function createSessionLog(
  task: string,
  projectDir: string,
  workflowName: string,
  options?: { startTime: string },
): SessionLog {
  return defaultManager.createSessionLog(
    task,
    projectDir,
    workflowName,
    options,
  );
}

/**
 * Finalize a session log without mutating the input.
 *
 * @param log - Session log to finalize
 * @param status - Terminal status to assign
 * @returns A finalized copy with the supplied status and an end time
 */
export function finalizeSessionLog(
  log: SessionLog,
  status: 'completed' | 'aborted',
): SessionLog {
  return defaultManager.finalizeSessionLog(log, status);
}

/**
 * Load a session log from an NDJSON `.jsonl` file.
 *
 * @param filepath - Path to the NDJSON session log file
 * @returns The parsed session log, or null if the file is missing, empty, or contains no workflow_start record
 * @throws Error if the file cannot be read or contains an invalid NDJSON record; parse errors include the filepath
 */
export function loadSessionLog(filepath: string): SessionLog | null {
  return defaultManager.loadSessionLog(filepath);
}

/**
 * Extract failure information from an NDJSON session log file.
 *
 * @param filepath - Path to the .jsonl session log file
 * @returns FailureInfo or null if file doesn't exist or is empty
 * @throws Error if the file cannot be read or a record cannot be parsed; parse errors include the filepath
 */
export function extractFailureInfo(filepath: string): FailureInfo | null {
  if (!existsSync(filepath)) {
    return null;
  }

  const content = readFileSync(filepath, 'utf-8');
  const lines = content.trim().split('\n').filter((line) => line.length > 0);
  if (lines.length === 0) return null;

  let lastCompletedStep: string | null = null;
  let failedStep: string | null = null;
  let iterations = 0;
  let errorMessage: string | null = null;
  let lastStartedStep: string | null = null;

  // Extract sessionId from filename (e.g., "20260205-120000-abc123.jsonl" -> "20260205-120000-abc123")
  const filename = filepath.split('/').pop();
  const sessionId = filename?.replace(/\.jsonl$/, '') ?? null;

  for (const line of lines) {
      const record = parseNdjsonRecordWithPath(line, filepath);

      switch (record.type) {
        case 'step_start':
          // Track the step that started (may fail before completing)
          lastStartedStep = record.step;
          break;

        case 'step_complete':
          // Track the last successfully completed step
          lastCompletedStep = record.step;
          iterations++;
          // Reset lastStartedStep since this step completed
          lastStartedStep = null;
          break;

        case 'workflow_abort':
          // If there was a step_start without a step_complete, that's the failed step
          failedStep = lastStartedStep;
          errorMessage = record.reason;
          break;
      }
  }

  return {
    lastCompletedStep,
    failedStep,
    iterations,
    errorMessage,
    sessionId,
  };
}

/**
 * Parse and validate one NDJSON session record while adding its source path to parse errors.
 *
 * @param line - A single NDJSON line
 * @param filepath - Path of the session log containing the line
 * @returns The validated NDJSON session record
 * @throws Error if the line is invalid JSON or does not match a supported record shape
 */
export function parseNdjsonRecordWithPath(line: string, filepath: string): NdjsonRecord {
  try {
    return parseNdjsonRecord(line);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to parse NDJSON session record in ${filepath}: ${detail}`,
      { cause: error },
    );
  }
}

/**
 * Parse and validate one NDJSON session record.
 *
 * @param line - A single NDJSON line
 * @returns The validated NDJSON session record
 * @throws Error if the line is invalid JSON or does not match a supported record shape
 */
export function parseNdjsonRecord(line: string): NdjsonRecord {
  const value = JSON.parse(line) as unknown;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('NDJSON session record must be an object');
  }
  const record = value as Record<string, unknown>;
  if (typeof record.type !== 'string' || record.type.length === 0) {
    throw new Error('NDJSON session record type is invalid');
  }
  const normalized = {
    ...record,
    ...(record.stack === undefined ? {} : { stack: parseNdjsonStack(record.stack) }),
    ...(record.parallel === undefined
      ? {}
      : { parallel: parseNdjsonParallelMetadata(record.parallel) }),
  };
  assertNdjsonRecordShape(normalized);
  return normalized as unknown as NdjsonRecord;
}

function parseNdjsonStack(value: unknown): NdjsonWorkflowStackEntry[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('NDJSON workflow stack must be a non-empty array');
  }
  return value.map((frame, index) => (
    parseCanonicalWorkflowResumeFrame(
      frame,
      `NDJSON workflow stack[${index}]`,
    )
  ));
}

function assertNdjsonRecordShape(
  record: Readonly<Record<string, unknown>>,
): void {
  switch (record.type) {
    case 'workflow_start':
      requireNdjsonString(record.task, 'task');
      requireNdjsonString(record.workflowName, 'workflowName');
      requireNdjsonString(record.startTime, 'startTime');
      return;
    case 'workflow_call_start':
      requireNdjsonWorkflowCallIdentity(record);
      return;
    case 'workflow_call_complete':
      requireNdjsonWorkflowCallIdentity(record);
      if (
        record.status !== 'completed'
        && record.status !== 'aborted'
        && record.status !== 'failed'
      ) {
        throw new Error('NDJSON workflow_call status is invalid');
      }
      requireOptionalNdjsonString(record.returnValue, 'returnValue');
      requireOptionalNdjsonString(record.abortKind, 'abortKind');
      requireOptionalNdjsonString(record.abortReason, 'abortReason');
      requireOptionalNdjsonString(record.reason, 'reason');
      if (record.status === 'failed') {
        requireNdjsonString(record.reason, 'reason');
      }
      return;
    case 'step_start':
      requireNdjsonString(record.step, 'step');
      requireNdjsonString(record.persona, 'persona');
      requireNdjsonInteger(record.iteration, 'iteration');
      requireNdjsonString(record.timestamp, 'timestamp');
      return;
    case 'step_complete':
      requireNdjsonString(record.step, 'step');
      requireNdjsonString(record.persona, 'persona');
      requireNdjsonString(record.status, 'status');
      requireNdjsonString(record.content, 'content');
      requireNdjsonString(record.instruction, 'instruction');
      requireNdjsonInteger(record.iteration, 'iteration');
      requireNdjsonString(record.timestamp, 'timestamp');
      requireOptionalAgentFailureCategory(record.failureCategory, 'failureCategory');
      return;
    case 'workflow_complete':
      requireNdjsonInteger(record.iterations, 'iterations');
      requireNdjsonString(record.endTime, 'endTime');
      return;
    case 'workflow_abort':
      requireNdjsonInteger(record.iterations, 'iterations');
      requireNdjsonString(record.reason, 'reason');
      requireNdjsonString(record.endTime, 'endTime');
      requireOptionalAgentFailureCategory(record.failureCategory, 'failureCategory');
      return;
    case 'phase_start':
    case 'phase_complete':
      requireNdjsonString(record.step, 'step');
      requireNdjsonPhase(record.phase);
      requireNdjsonPhaseName(record.phaseName);
      requireOptionalNdjsonInteger(record.iteration, 'iteration');
      requireNdjsonString(record.timestamp, 'timestamp');
      if (record.type === 'phase_complete') {
        requireNdjsonString(record.status, 'status');
      }
      return;
    case 'phase_judge_stage':
      requireNdjsonString(record.step, 'step');
      if (
        record.phase !== 3
        || record.phaseName !== 'judge'
        || (record.stage !== 1 && record.stage !== 2 && record.stage !== 3)
        || (
          record.method !== 'structured_output'
          && record.method !== 'phase3_tag'
          && record.method !== 'ai_judge'
        )
        || (
          record.status !== 'done'
          && record.status !== 'error'
          && record.status !== 'skipped'
        )
      ) {
        throw new Error('NDJSON phase_judge_stage fields are invalid');
      }
      requireOptionalNdjsonInteger(record.iteration, 'iteration');
      requireNdjsonString(record.instruction, 'instruction');
      requireNdjsonString(record.response, 'response');
      requireNdjsonString(record.timestamp, 'timestamp');
      return;
    case 'interactive_start':
      requireNdjsonString(record.timestamp, 'timestamp');
      return;
    case 'interactive_end':
      if (typeof record.confirmed !== 'boolean') {
        throw new Error('NDJSON confirmed must be a boolean');
      }
      requireNdjsonString(record.timestamp, 'timestamp');
      return;
    case 'companion_review_round':
      requireCompanionReviewRoundFields(record);
      return;
    case 'companion_queue_coalesced':
      requireCompanionQueueCoalescedFields(record);
      return;
    case 'companion_call':
      requireCompanionCallFields(record);
      return;
    case 'companion_review_skipped':
      requireCompanionReviewSkippedFields(record);
      return;
    default:
      throw new Error(`Unknown NDJSON session record type: ${String(record.type)}`);
  }
}

function requireOptionalAgentFailureCategory(value: unknown, field: string): void {
  if (value !== undefined && !isAgentFailureCategory(value)) {
    throw new Error(`NDJSON ${field} is invalid`);
  }
}

function requireCompanionReviewRoundFields(
  record: Readonly<Record<string, unknown>>,
): void {
  requireNdjsonString(record.step, 'step');
  requireCompanionReviewMode(record.reviewMode);
  requireNdjsonString(record.companion, 'companion');
  requireCompanionReviewTrigger(record.trigger);
  requireNdjsonString(record.digest, 'digest');
  requireNdjsonInteger(record.changedLines, 'changedLines');
  requireNdjsonInteger(record.findingCount, 'findingCount');
  requireCompanionAcceptedFindings(record.reviewerFindings);
  requireOptionalCompanionModeratorAudit(record.moderator);
  requireCompanionAcceptedFindings(record.acceptedFindings);
  requireOptionalCompanionZeroReason(record.zeroReason);
  requireOptionalNdjsonStringArray(record.runPathNamespace, 'runPathNamespace');
  requireNdjsonString(record.timestamp, 'timestamp');
}

function requireCompanionReviewMode(value: unknown): asserts value is NdjsonCompanionReviewMode {
  if (value !== 'completion' && value !== 'live') {
    throw new Error('NDJSON companion review mode is invalid');
  }
}

function requireCompanionQueueCoalescedFields(
  record: Readonly<Record<string, unknown>>,
): void {
  requireNdjsonString(record.step, 'step');
  requireNdjsonString(record.companion, 'companion');
  requireOptionalNdjsonStringArray(record.runPathNamespace, 'runPathNamespace');
  requireCompanionQueueRequest(record.replaced, 'replaced');
  requireCompanionQueueRequest(record.replacement, 'replacement');
  requireNdjsonString(record.timestamp, 'timestamp');
}

function requireCompanionQueueRequest(value: unknown, field: string): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`NDJSON ${field} must be an object`);
  }
  const request = value as Record<string, unknown>;
  requireCompanionReviewTrigger(request.trigger);
  requireNdjsonString(request.digest, `${field}.digest`);
  requireNdjsonInteger(request.changedLines, `${field}.changedLines`);
  requireNdjsonInteger(request.observedGeneration, `${field}.observedGeneration`);
}

function requireCompanionReviewTrigger(value: unknown): void {
  if (value !== 'quiet' && value !== 'forced' && value !== 'completion' && value !== 'commit') {
    throw new Error('NDJSON companion review trigger is invalid');
  }
}

function requireCompanionCallFields(
  record: Readonly<Record<string, unknown>>,
): void {
  requireNdjsonString(record.step, 'step');
  requireNdjsonString(record.agent, 'agent');
  if (
    record.purpose !== 'selector'
    && record.purpose !== 'reviewer'
    && record.purpose !== 'moderator'
  ) {
    throw new Error('NDJSON companion call purpose is invalid');
  }
  if (record.status !== 'completed' && record.status !== 'failed') {
    throw new Error('NDJSON companion call status is invalid');
  }
  requireNdjsonInteger(record.attempt, 'attempt');
  if (record.attempt < 1) {
    throw new Error('NDJSON companion call attempt must be positive');
  }
  requireNdjsonString(record.provider, 'provider');
  requireOptionalNdjsonString(record.model, 'model');
  requireOptionalNdjsonStringArray(record.runPathNamespace, 'runPathNamespace');
  requireNdjsonBoolean(record.sessionIdAvailable, 'sessionIdAvailable');
  requireOptionalNdjsonString(record.sessionId, 'sessionId');
  if (record.sessionIdAvailable !== (typeof record.sessionId === 'string' && record.sessionId.length > 0)) {
    throw new Error('NDJSON companion session ID availability does not match session ID');
  }
  requireNdjsonBoolean(record.promptResolved, 'promptResolved');
  if (record.promptResolved) {
    requireNdjsonString(record.systemPrompt, 'systemPrompt');
    requireNdjsonBoolean(record.systemPromptTruncated, 'systemPromptTruncated');
    requireNdjsonString(record.prompt, 'prompt');
    requireNdjsonBoolean(record.promptTruncated, 'promptTruncated');
  } else if (
    record.systemPrompt !== undefined
    || record.systemPromptTruncated !== undefined
    || record.prompt !== undefined
    || record.promptTruncated !== undefined
  ) {
    throw new Error('NDJSON unresolved companion prompt must be omitted');
  }
  requireOptionalNdjsonString(record.response, 'response');
  requireOptionalNdjsonBoolean(record.responseTruncated, 'responseTruncated');
  requireOptionalNdjsonString(record.structuredOutput, 'structuredOutput');
  requireOptionalNdjsonBoolean(record.structuredOutputTruncated, 'structuredOutputTruncated');
  requireCompanionUsage(record.usage);
  requireOptionalNdjsonString(record.error, 'error');
  requireOptionalNdjsonBoolean(record.errorTruncated, 'errorTruncated');
  requireNdjsonString(record.timestamp, 'timestamp');
}

function requireCompanionUsage(value: unknown): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('NDJSON companion usage must be an object');
  }
  const usage = value as Record<string, unknown>;
  requireNdjsonBoolean(usage.usageMissing, 'usage.usageMissing');
  for (const field of [
    'inputTokens',
    'outputTokens',
    'totalTokens',
    'cachedInputTokens',
    'cacheCreationInputTokens',
    'cacheReadInputTokens',
  ]) {
    requireOptionalNdjsonInteger(usage[field], `usage.${field}`);
  }
  requireOptionalNdjsonString(usage.reason, 'usage.reason');
}

function requireCompanionAcceptedFindings(value: unknown): void {
  if (!Array.isArray(value)) {
    throw new Error('NDJSON companion accepted findings must be an array');
  }
  value.forEach((finding, index) => {
    if (finding === null || typeof finding !== 'object' || Array.isArray(finding)) {
      throw new Error(`NDJSON companion accepted finding[${index}] must be an object`);
    }
    const item = finding as Record<string, unknown>;
    if (
      item.severity !== 'must_fix'
      && item.severity !== 'should_fix'
      && item.severity !== 'nit'
    ) {
      throw new Error(`NDJSON companion accepted finding[${index}] severity is invalid`);
    }
    requireNdjsonString(item.file, `acceptedFindings[${index}].file`);
    requireNdjsonInteger(item.line, `acceptedFindings[${index}].line`);
    requireNdjsonString(item.finding, `acceptedFindings[${index}].finding`);
  });
}

function requireOptionalCompanionModeratorAudit(value: unknown): void {
  if (value === undefined) return;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('NDJSON companion moderator must be an object');
  }
  const moderator = value as Record<string, unknown>;
  requireNdjsonString(moderator.name, 'moderator.name');
  requireNdjsonBoolean(moderator.invoked, 'moderator.invoked');
  if (moderator.reason !== undefined
    && moderator.reason !== 'reviewer_result_empty'
    && moderator.reason !== 'not_configured') {
    throw new Error('NDJSON companion moderator reason is invalid');
  }
  if (!Array.isArray(moderator.decisions)) {
    throw new Error('NDJSON companion moderator decisions must be an array');
  }
  moderator.decisions.forEach((decision, index) => {
    if (decision === null || typeof decision !== 'object' || Array.isArray(decision)) {
      throw new Error(`NDJSON companion moderator decision[${index}] must be an object`);
    }
    const item = decision as Record<string, unknown>;
    if (
      item.action !== 'accept'
      && item.action !== 'reject'
    ) {
      throw new Error(`NDJSON companion moderator decision[${index}] action is invalid`);
    }
    requireNdjsonInteger(item.sourceIndex, `moderator.decisions[${index}].sourceIndex`);
  });
}

function requireOptionalCompanionZeroReason(value: unknown): void {
  if (value === undefined) return;
  if (
    value !== 'reviewer_returned_no_findings'
    && value !== 'moderator_rejected_all_findings'
  ) {
    throw new Error('NDJSON companion zero reason is invalid');
  }
}

function requireCompanionReviewSkippedFields(
  record: Readonly<Record<string, unknown>>,
): void {
  requireNdjsonString(record.step, 'step');
  requireOptionalNdjsonString(record.companion, 'companion');
  if (
    record.phase !== 'initial'
    && record.phase !== 'live'
    && record.phase !== 'fix'
    && record.phase !== 'completion'
  ) {
    throw new Error('NDJSON companion review skipped phase is invalid');
  }
  if (
    record.reason !== 'companion_disabled'
    && record.reason !== 'companion_not_configured'
    && record.reason !== 'companion_runtime_unavailable'
    && record.reason !== 'selector_empty'
    && record.reason !== 'empty_diff'
    && record.reason !== 'unchanged_digest'
    && record.reason !== 'below_minimum_changed_lines'
  ) {
    throw new Error('NDJSON companion review skipped reason is invalid');
  }
  requireOptionalNdjsonInteger(record.fixRound, 'fixRound');
  requireOptionalNdjsonInteger(record.observedGeneration, 'observedGeneration');
  requireOptionalNdjsonStringArray(record.runPathNamespace, 'runPathNamespace');
  requireNdjsonString(record.timestamp, 'timestamp');
}

function requireNdjsonWorkflowCallIdentity(
  record: Readonly<Record<string, unknown>>,
): void {
  requireNdjsonString(record.workflow, 'workflow');
  requireNdjsonString(record.step, 'step');
  requireNdjsonString(record.childWorkflow, 'childWorkflow');
  requireNdjsonInteger(record.callInstance, 'callInstance');
  if (!Array.isArray(record.stack) || record.stack.length === 0) {
    throw new Error('NDJSON workflow_call stack must be a non-empty array');
  }
  requireNdjsonString(record.timestamp, 'timestamp');
}

function requireNdjsonString(value: unknown, field: string): void {
  if (typeof value !== 'string') {
    throw new Error(`NDJSON ${field} must be a string`);
  }
}

function requireNdjsonBoolean(value: unknown, field: string): void {
  if (typeof value !== 'boolean') {
    throw new Error(`NDJSON ${field} must be a boolean`);
  }
}

function requireOptionalNdjsonString(value: unknown, field: string): void {
  if (value !== undefined) {
    requireNdjsonString(value, field);
  }
}

function requireOptionalNdjsonStringArray(value: unknown, field: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`NDJSON ${field} must be an array of strings`);
  }
}

function requireOptionalNdjsonBoolean(value: unknown, field: string): void {
  if (value !== undefined) requireNdjsonBoolean(value, field);
}

function requireNdjsonInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`NDJSON ${field} must be a non-negative integer`);
  }
}

function requireOptionalNdjsonInteger(value: unknown, field: string): void {
  if (value !== undefined) {
    requireNdjsonInteger(value, field);
  }
}

function requireNdjsonPhase(value: unknown): void {
  if (value !== 1 && value !== 2 && value !== 3) {
    throw new Error('NDJSON phase must be 1, 2, or 3');
  }
}

function requireNdjsonPhaseName(value: unknown): void {
  if (value !== 'execute' && value !== 'report' && value !== 'judge') {
    throw new Error('NDJSON phaseName is invalid');
  }
}
