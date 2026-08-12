/**
 * Session management utilities
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { generateReportDir as buildReportDir } from '../../shared/utils/index.js';
import type {
  SessionLog,
  NdjsonRecord,
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
  NdjsonCompanionReviewTrigger,
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


  /** Load an NDJSON log file and convert it to a SessionLog */
  loadNdjsonLog(filepath: string): SessionLog | null {
    if (!existsSync(filepath)) {
      return null;
    }

    const content = readFileSync(filepath, 'utf-8');
    const lines = content.trim().split('\n').filter((line) => line.length > 0);
    if (lines.length === 0) return null;

    let sessionLog: SessionLog | null = null;

    for (const line of lines) {
      const record = parseNdjsonRecord(line);

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

export function appendNdjsonLine(filepath: string, record: NdjsonRecord): void {
  defaultManager.appendNdjsonLine(filepath, record);
}

export function initNdjsonLog(
  sessionId: string,
  task: string,
  workflowName: string,
  options: { logsDir: string; startTime?: string },
): string {
  return defaultManager.initNdjsonLog(sessionId, task, workflowName, options);
}


export function loadNdjsonLog(filepath: string): SessionLog | null {
  return defaultManager.loadNdjsonLog(filepath);
}


export function generateSessionId(): string {
  return defaultManager.generateSessionId();
}

export function generateReportDir(task: string): string {
  return defaultManager.generateReportDir(task);
}

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

export function finalizeSessionLog(
  log: SessionLog,
  status: 'completed' | 'aborted',
): SessionLog {
  return defaultManager.finalizeSessionLog(log, status);
}

export function loadSessionLog(filepath: string): SessionLog | null {
  return defaultManager.loadSessionLog(filepath);
}

/**
 * Extract failure information from an NDJSON session log file.
 *
 * @param filepath - Path to the .jsonl session log file
 * @returns FailureInfo or null if file doesn't exist or is invalid
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
      const record = parseNdjsonRecord(line);

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

export function parseNdjsonRecord(line: string): NdjsonRecord {
  const value = JSON.parse(line) as unknown;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('NDJSON session record must be an object');
  }
  const record = value as Record<string, unknown>;
  if (typeof record.type !== 'string' || record.type.length === 0) {
    throw new Error('NDJSON session record type is invalid');
  }
  const normalized = record.stack === undefined
    ? record
    : {
    ...record,
        stack: parseNdjsonStack(record.stack),
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
  requireNdjsonString(record.companion, 'companion');
  requireCompanionReviewTrigger(record.trigger);
  requireNdjsonString(record.digest, 'digest');
  requireNdjsonInteger(record.changedLines, 'changedLines');
  requireNdjsonInteger(record.findingCount, 'findingCount');
  requireNdjsonString(record.timestamp, 'timestamp');
}

function requireCompanionQueueCoalescedFields(
  record: Readonly<Record<string, unknown>>,
): void {
  requireNdjsonString(record.step, 'step');
  requireNdjsonString(record.companion, 'companion');
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

function requireOptionalNdjsonString(value: unknown, field: string): void {
  if (value !== undefined) {
    requireNdjsonString(value, field);
  }
}

function requireNdjsonInteger(value: unknown, field: string): void {
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
