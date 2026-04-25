/**
 * Session management utilities
 */

import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir } from '../config/index.js';
import { generateReportDir as buildReportDir } from '../../shared/utils/index.js';
import type {
  SessionLog,
  NdjsonRecord,
  NdjsonWorkflowStart,
} from '../../shared/utils/index.js';

export type {
  SessionLog,
  NdjsonWorkflowStart,
  NdjsonStepStart,
  NdjsonStepComplete,
  NdjsonWorkflowComplete,
  NdjsonWorkflowAbort,
  NdjsonPhaseStart,
  NdjsonPhaseComplete,
  NdjsonPhaseJudgeStage,
  NdjsonInteractiveStart,
  NdjsonInteractiveEnd,
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
    appendFileSync(filepath, JSON.stringify(record) + '\n', 'utf-8');
  }


  /** Initialize an NDJSON log file with the workflow_start record */
  initNdjsonLog(
    sessionId: string,
    task: string,
    workflowName: string,
    options: { logsDir: string },
  ): string {
    const { logsDir } = options;
    ensureDir(logsDir);

    const filepath = join(logsDir, `${sessionId}.jsonl`);
    const record: NdjsonWorkflowStart = {
      type: 'workflow_start',
      task,
      workflowName,
      startTime: new Date().toISOString(),
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
      const record = JSON.parse(line) as NdjsonRecord;

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
  ): SessionLog {
    return {
      task,
      projectDir,
      workflowName,
      iterations: 0,
      startTime: new Date().toISOString(),
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
  options: { logsDir: string },
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
): SessionLog {
  return defaultManager.createSessionLog(task, projectDir, workflowName);
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
    try {
      const record = JSON.parse(line) as NdjsonRecord;

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
    } catch {
      // Skip malformed JSON lines
      continue;
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
