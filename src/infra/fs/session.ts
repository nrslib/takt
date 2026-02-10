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
  NdjsonPieceStart,
} from '../../shared/utils/index.js';

export type {
  SessionLog,
  NdjsonPieceStart,
  NdjsonStepStart,
  NdjsonStepComplete,
  NdjsonPieceComplete,
  NdjsonPieceAbort,
  NdjsonPhaseStart,
  NdjsonPhaseComplete,
  NdjsonInteractiveStart,
  NdjsonInteractiveEnd,
  NdjsonRecord,
} from '../../shared/utils/index.js';

/** Failure information extracted from session log */
export interface FailureInfo {
  /** Last movement that completed successfully */
  lastCompletedMovement: string | null;
  /** Movement that was in progress when failure occurred */
  failedMovement: string | null;
  /** Total iterations consumed */
  iterations: number;
  /** Error message from piece_abort record */
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


  /** Initialize an NDJSON log file with the piece_start record */
  initNdjsonLog(
    sessionId: string,
    task: string,
    pieceName: string,
    options: { logsDir: string },
  ): string {
    const { logsDir } = options;
    ensureDir(logsDir);

    const filepath = join(logsDir, `${sessionId}.jsonl`);
    const record: NdjsonPieceStart = {
      type: 'piece_start',
      task,
      pieceName,
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
        case 'piece_start':
          sessionLog = {
            task: record.task,
            projectDir: '',
            pieceName: record.pieceName,
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
              ...(record.error ? { error: record.error } : {}),
              ...(record.matchedRuleIndex != null ? { matchedRuleIndex: record.matchedRuleIndex } : {}),
              ...(record.matchedRuleMethod ? { matchedRuleMethod: record.matchedRuleMethod } : {}),
            });
            sessionLog.iterations++;
          }
          break;

        case 'piece_complete':
          if (sessionLog) {
            sessionLog.status = 'completed';
            sessionLog.endTime = record.endTime;
          }
          break;

        case 'piece_abort':
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
    pieceName: string,
  ): SessionLog {
    return {
      task,
      projectDir,
      pieceName,
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

  /** Load session log from file (supports both .json and .jsonl formats) */
  loadSessionLog(filepath: string): SessionLog | null {
    if (filepath.endsWith('.jsonl')) {
      return this.loadNdjsonLog(filepath);
    }

    if (!existsSync(filepath)) {
      return null;
    }
    const content = readFileSync(filepath, 'utf-8');
    return JSON.parse(content) as SessionLog;
  }

  /** Load project context (CLAUDE.md files) */
  loadProjectContext(projectDir: string): string {
    const contextParts: string[] = [];

    const rootClaudeMd = join(projectDir, 'CLAUDE.md');
    if (existsSync(rootClaudeMd)) {
      contextParts.push(readFileSync(rootClaudeMd, 'utf-8'));
    }

    const dotClaudeMd = join(projectDir, '.claude', 'CLAUDE.md');
    if (existsSync(dotClaudeMd)) {
      contextParts.push(readFileSync(dotClaudeMd, 'utf-8'));
    }

    return contextParts.join('\n\n---\n\n');
  }

}

const defaultManager = new SessionManager();

export function appendNdjsonLine(filepath: string, record: NdjsonRecord): void {
  defaultManager.appendNdjsonLine(filepath, record);
}

export function initNdjsonLog(
  sessionId: string,
  task: string,
  pieceName: string,
  options: { logsDir: string },
): string {
  return defaultManager.initNdjsonLog(sessionId, task, pieceName, options);
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
  pieceName: string,
): SessionLog {
  return defaultManager.createSessionLog(task, projectDir, pieceName);
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

export function loadProjectContext(projectDir: string): string {
  return defaultManager.loadProjectContext(projectDir);
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

  let lastCompletedMovement: string | null = null;
  let failedMovement: string | null = null;
  let iterations = 0;
  let errorMessage: string | null = null;
  let lastStepStartMovement: string | null = null;

  // Extract sessionId from filename (e.g., "20260205-120000-abc123.jsonl" -> "20260205-120000-abc123")
  const filename = filepath.split('/').pop();
  const sessionId = filename?.replace(/\.jsonl$/, '') ?? null;

  for (const line of lines) {
    try {
      const record = JSON.parse(line) as NdjsonRecord;

      switch (record.type) {
        case 'step_start':
          // Track the movement that started (may fail before completing)
          lastStepStartMovement = record.step;
          break;

        case 'step_complete':
          // Track the last successfully completed movement
          lastCompletedMovement = record.step;
          iterations++;
          // Reset lastStepStartMovement since this movement completed
          lastStepStartMovement = null;
          break;

        case 'piece_abort':
          // If there was a step_start without a step_complete, that's the failed movement
          failedMovement = lastStepStartMovement;
          errorMessage = record.reason;
          break;
      }
    } catch {
      // Skip malformed JSON lines
      continue;
    }
  }

  return {
    lastCompletedMovement,
    failedMovement,
    iterations,
    errorMessage,
    sessionId,
  };
}
