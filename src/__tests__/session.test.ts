/**
 * Tests for session log incremental writes and pointer management
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  initNdjsonLog,
  appendNdjsonLine,
  loadNdjsonLog,
  loadSessionLog,
  extractFailureInfo,
  type SessionLog,
  type NdjsonRecord,
  type NdjsonStepComplete,
  type NdjsonPieceComplete,
  type NdjsonPieceAbort,
  type NdjsonPhaseStart,
  type NdjsonPhaseComplete,
  type NdjsonInteractiveStart,
  type NdjsonInteractiveEnd,
} from '../infra/fs/session.js';

/** Create a temp project directory for each test */
function createTempProject(): string {
  const dir = join(tmpdir(), `takt-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function initTestNdjsonLog(sessionId: string, task: string, pieceName: string, projectDir: string): string {
  const logsDir = join(projectDir, '.takt', 'runs', 'test-run', 'logs');
  mkdirSync(logsDir, { recursive: true });
  return initNdjsonLog(sessionId, task, pieceName, { logsDir });
}

describe('NDJSON log', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = createTempProject();
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  describe('initNdjsonLog', () => {
    it('should create a .jsonl file with piece_start record', () => {
      const filepath = initTestNdjsonLog('sess-001', 'my task', 'default', projectDir);

      expect(filepath).toContain('sess-001.jsonl');
      expect(existsSync(filepath)).toBe(true);

      const content = readFileSync(filepath, 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(1);

      const record = JSON.parse(lines[0]!) as NdjsonRecord;
      expect(record.type).toBe('piece_start');
      if (record.type === 'piece_start') {
        expect(record.task).toBe('my task');
        expect(record.pieceName).toBe('default');
        expect(record.startTime).toBeDefined();
      }
    });
  });

  describe('appendNdjsonLine', () => {
    it('should append records as individual lines', () => {
      const filepath = initTestNdjsonLog('sess-002', 'task', 'wf', projectDir);

      const stepStart: NdjsonRecord = {
        type: 'step_start',
        step: 'plan',
        persona: 'planner',
        iteration: 1,
        timestamp: new Date().toISOString(),
      };
      appendNdjsonLine(filepath, stepStart);

      const stepComplete: NdjsonStepComplete = {
        type: 'step_complete',
        step: 'plan',
        persona: 'planner',
        status: 'done',
        content: 'Plan completed',
        instruction: 'Create a plan',
        timestamp: new Date().toISOString(),
      };
      appendNdjsonLine(filepath, stepComplete);

      const content = readFileSync(filepath, 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(3); // piece_start + step_start + step_complete

      const parsed0 = JSON.parse(lines[0]!) as NdjsonRecord;
      expect(parsed0.type).toBe('piece_start');

      const parsed1 = JSON.parse(lines[1]!) as NdjsonRecord;
      expect(parsed1.type).toBe('step_start');
      if (parsed1.type === 'step_start') {
        expect(parsed1.step).toBe('plan');
        expect(parsed1.persona).toBe('planner');
        expect(parsed1.iteration).toBe(1);
      }

      const parsed2 = JSON.parse(lines[2]!) as NdjsonRecord;
      expect(parsed2.type).toBe('step_complete');
      if (parsed2.type === 'step_complete') {
        expect(parsed2.step).toBe('plan');
        expect(parsed2.content).toBe('Plan completed');
      }
    });
  });

  describe('loadNdjsonLog', () => {
    it('should reconstruct SessionLog from NDJSON file', () => {
      const filepath = initTestNdjsonLog('sess-003', 'build app', 'default', projectDir);

      // Add step_start + step_complete
      appendNdjsonLine(filepath, {
        type: 'step_start',
        step: 'plan',
        persona: 'planner',
        iteration: 1,
        timestamp: '2025-01-01T00:00:01.000Z',
      });

      const stepComplete: NdjsonStepComplete = {
        type: 'step_complete',
        step: 'plan',
        persona: 'planner',
        status: 'done',
        content: 'Plan completed',
        instruction: 'Create a plan',
        matchedRuleIndex: 0,
        matchedRuleMethod: 'phase3_tag',
        timestamp: '2025-01-01T00:00:02.000Z',
      };
      appendNdjsonLine(filepath, stepComplete);

      const complete: NdjsonPieceComplete = {
        type: 'piece_complete',
        iterations: 1,
        endTime: '2025-01-01T00:00:03.000Z',
      };
      appendNdjsonLine(filepath, complete);

      const log = loadNdjsonLog(filepath);
      expect(log).not.toBeNull();
      expect(log!.task).toBe('build app');
      expect(log!.pieceName).toBe('default');
      expect(log!.status).toBe('completed');
      expect(log!.iterations).toBe(1);
      expect(log!.endTime).toBe('2025-01-01T00:00:03.000Z');
      expect(log!.history).toHaveLength(1);
      expect(log!.history[0]!.step).toBe('plan');
      expect(log!.history[0]!.content).toBe('Plan completed');
      expect(log!.history[0]!.matchedRuleIndex).toBe(0);
      expect(log!.history[0]!.matchedRuleMethod).toBe('phase3_tag');
    });

    it('should handle aborted piece', () => {
      const filepath = initTestNdjsonLog('sess-004', 'failing task', 'wf', projectDir);

      appendNdjsonLine(filepath, {
        type: 'step_start',
        step: 'impl',
        persona: 'coder',
        iteration: 1,
        timestamp: '2025-01-01T00:00:01.000Z',
      });

      appendNdjsonLine(filepath, {
        type: 'step_complete',
        step: 'impl',
        persona: 'coder',
        status: 'error',
        content: 'Failed',
        instruction: 'Do the thing',
        error: 'compile error',
        timestamp: '2025-01-01T00:00:02.000Z',
      } satisfies NdjsonStepComplete);

      const abort: NdjsonPieceAbort = {
        type: 'piece_abort',
        iterations: 1,
        reason: 'Max movements reached',
        endTime: '2025-01-01T00:00:03.000Z',
      };
      appendNdjsonLine(filepath, abort);

      const log = loadNdjsonLog(filepath);
      expect(log).not.toBeNull();
      expect(log!.status).toBe('aborted');
      expect(log!.history[0]!.error).toBe('compile error');
    });

    it('should return null for non-existent file', () => {
      const result = loadNdjsonLog('/nonexistent/path.jsonl');
      expect(result).toBeNull();
    });

    it('should return null for empty file', () => {
      const logsDir = join(projectDir, '.takt', 'logs');
      mkdirSync(logsDir, { recursive: true });
      const filepath = join(logsDir, 'empty.jsonl');
      writeFileSync(filepath, '', 'utf-8');

      const result = loadNdjsonLog(filepath);
      expect(result).toBeNull();
    });

    it('should skip step_start records when reconstructing SessionLog', () => {
      const filepath = initTestNdjsonLog('sess-005', 'task', 'wf', projectDir);

      // Add various records
      appendNdjsonLine(filepath, {
        type: 'step_start',
        step: 'plan',
        persona: 'planner',
        iteration: 1,
        timestamp: '2025-01-01T00:00:01.000Z',
      });

      appendNdjsonLine(filepath, {
        type: 'step_complete',
        step: 'plan',
        persona: 'planner',
        status: 'done',
        content: 'Done',
        instruction: 'Plan it',
        timestamp: '2025-01-01T00:00:02.000Z',
      } satisfies NdjsonStepComplete);

      appendNdjsonLine(filepath, {
        type: 'piece_complete',
        iterations: 1,
        endTime: '2025-01-01T00:00:03.000Z',
      });

      const log = loadNdjsonLog(filepath);
      expect(log).not.toBeNull();
      // Only step_complete adds to history
      expect(log!.history).toHaveLength(1);
      expect(log!.iterations).toBe(1);
    });
  });

  describe('loadSessionLog with .jsonl extension', () => {
    it('should delegate to loadNdjsonLog for .jsonl files', () => {
      const filepath = initTestNdjsonLog('sess-006', 'jsonl task', 'wf', projectDir);

      appendNdjsonLine(filepath, {
        type: 'step_complete',
        step: 'plan',
        persona: 'planner',
        status: 'done',
        content: 'Plan done',
        instruction: 'Plan',
        timestamp: '2025-01-01T00:00:02.000Z',
      } satisfies NdjsonStepComplete);

      appendNdjsonLine(filepath, {
        type: 'piece_complete',
        iterations: 1,
        endTime: '2025-01-01T00:00:03.000Z',
      });

      // loadSessionLog should handle .jsonl
      const log = loadSessionLog(filepath);
      expect(log).not.toBeNull();
      expect(log!.task).toBe('jsonl task');
      expect(log!.status).toBe('completed');
    });

    it('should still load legacy .json files', () => {
      const logsDir = join(projectDir, '.takt', 'logs');
      mkdirSync(logsDir, { recursive: true });
      const legacyPath = join(logsDir, 'legacy-001.json');
      const legacyLog: SessionLog = {
        task: 'legacy task',
        projectDir,
        pieceName: 'wf',
        iterations: 0,
        startTime: new Date().toISOString(),
        status: 'running',
        history: [],
      };
      writeFileSync(legacyPath, JSON.stringify(legacyLog, null, 2), 'utf-8');

      const log = loadSessionLog(legacyPath);
      expect(log).not.toBeNull();
      expect(log!.task).toBe('legacy task');
    });
  });

  describe('appendNdjsonLine real-time characteristics', () => {
    it('should append without overwriting previous content', () => {
      const filepath = initTestNdjsonLog('sess-007', 'task', 'wf', projectDir);

      // Read after init
      const after1 = readFileSync(filepath, 'utf-8').trim().split('\n');
      expect(after1).toHaveLength(1);

      // Append more records
      appendNdjsonLine(filepath, {
        type: 'step_start',
        step: 'plan',
        persona: 'planner',
        iteration: 1,
        timestamp: '2025-01-01T00:00:01.000Z',
      });

      const after2 = readFileSync(filepath, 'utf-8').trim().split('\n');
      expect(after2).toHaveLength(2);
      // First line should still be piece_start
      expect(JSON.parse(after2[0]!).type).toBe('piece_start');
    });

    it('should produce valid JSON on each line', () => {
      const filepath = initTestNdjsonLog('sess-008', 'task', 'wf', projectDir);

      for (let i = 0; i < 5; i++) {
        appendNdjsonLine(filepath, {
          type: 'step_start',
          step: `step-${i}`,
          persona: 'planner',
          iteration: i + 1,
          timestamp: new Date().toISOString(),
        });
      }

      const content = readFileSync(filepath, 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(6); // 1 init + 5 step_start

      // Every line should be valid JSON
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    });
  });

  describe('phase NDJSON records', () => {
    it('should serialize and append phase_start records', () => {
      const filepath = initTestNdjsonLog('sess-phase-001', 'task', 'wf', projectDir);

      const record: NdjsonPhaseStart = {
        type: 'phase_start',
        step: 'plan',
        phase: 1,
        phaseName: 'execute',
        timestamp: '2025-01-01T00:00:01.000Z',
        instruction: 'Do the planning',
      };
      appendNdjsonLine(filepath, record);

      const content = readFileSync(filepath, 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(2); // piece_start + phase_start

      const parsed = JSON.parse(lines[1]!) as NdjsonRecord;
      expect(parsed.type).toBe('phase_start');
      if (parsed.type === 'phase_start') {
        expect(parsed.step).toBe('plan');
        expect(parsed.phase).toBe(1);
        expect(parsed.phaseName).toBe('execute');
        expect(parsed.instruction).toBe('Do the planning');
      }
    });

    it('should serialize and append phase_complete records', () => {
      const filepath = initTestNdjsonLog('sess-phase-002', 'task', 'wf', projectDir);

      const record: NdjsonPhaseComplete = {
        type: 'phase_complete',
        step: 'plan',
        phase: 2,
        phaseName: 'report',
        status: 'done',
        content: 'Report output',
        timestamp: '2025-01-01T00:00:02.000Z',
      };
      appendNdjsonLine(filepath, record);

      const content = readFileSync(filepath, 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(2);

      const parsed = JSON.parse(lines[1]!) as NdjsonRecord;
      expect(parsed.type).toBe('phase_complete');
      if (parsed.type === 'phase_complete') {
        expect(parsed.step).toBe('plan');
        expect(parsed.phase).toBe(2);
        expect(parsed.phaseName).toBe('report');
        expect(parsed.status).toBe('done');
        expect(parsed.content).toBe('Report output');
      }
    });

    it('should serialize phase_complete with error', () => {
      const filepath = initTestNdjsonLog('sess-phase-003', 'task', 'wf', projectDir);

      const record: NdjsonPhaseComplete = {
        type: 'phase_complete',
        step: 'impl',
        phase: 3,
        phaseName: 'judge',
        status: 'error',
        timestamp: '2025-01-01T00:00:03.000Z',
        error: 'Status judgment phase failed',
      };
      appendNdjsonLine(filepath, record);

      const content = readFileSync(filepath, 'utf-8');
      const lines = content.trim().split('\n');
      const parsed = JSON.parse(lines[1]!) as NdjsonRecord;
      expect(parsed.type).toBe('phase_complete');
      if (parsed.type === 'phase_complete') {
        expect(parsed.error).toBe('Status judgment phase failed');
        expect(parsed.phase).toBe(3);
        expect(parsed.phaseName).toBe('judge');
      }
    });

    it('should be skipped by loadNdjsonLog (default case)', () => {
      const filepath = initTestNdjsonLog('sess-phase-004', 'task', 'wf', projectDir);

      // Add phase records
      appendNdjsonLine(filepath, {
        type: 'phase_start',
        step: 'plan',
        phase: 1,
        phaseName: 'execute',
        timestamp: '2025-01-01T00:00:01.000Z',
        instruction: 'Plan it',
      } satisfies NdjsonPhaseStart);

      appendNdjsonLine(filepath, {
        type: 'phase_complete',
        step: 'plan',
        phase: 1,
        phaseName: 'execute',
        status: 'done',
        content: 'Planned',
        timestamp: '2025-01-01T00:00:02.000Z',
      } satisfies NdjsonPhaseComplete);

      // Add a step_complete so we can verify history
      appendNdjsonLine(filepath, {
        type: 'step_complete',
        step: 'plan',
        persona: 'planner',
        status: 'done',
        content: 'Plan completed',
        instruction: 'Plan it',
        timestamp: '2025-01-01T00:00:03.000Z',
      } satisfies NdjsonStepComplete);

      const log = loadNdjsonLog(filepath);
      expect(log).not.toBeNull();
      // Only step_complete should contribute to history
      expect(log!.history).toHaveLength(1);
      expect(log!.iterations).toBe(1);
    });
  });

  describe('interactive NDJSON records', () => {
    it('should serialize and append interactive_start records', () => {
      const filepath = initTestNdjsonLog('sess-interactive-001', 'task', 'wf', projectDir);

      const record: NdjsonInteractiveStart = {
        type: 'interactive_start',
        timestamp: '2025-01-01T00:00:01.000Z',
      };
      appendNdjsonLine(filepath, record);

      const content = readFileSync(filepath, 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(2);

      const parsed = JSON.parse(lines[1]!) as NdjsonRecord;
      expect(parsed.type).toBe('interactive_start');
      if (parsed.type === 'interactive_start') {
        expect(parsed.timestamp).toBe('2025-01-01T00:00:01.000Z');
      }
    });

    it('should serialize and append interactive_end records', () => {
      const filepath = initTestNdjsonLog('sess-interactive-002', 'task', 'wf', projectDir);

      const record: NdjsonInteractiveEnd = {
        type: 'interactive_end',
        confirmed: true,
        task: 'Build a feature',
        timestamp: '2025-01-01T00:00:02.000Z',
      };
      appendNdjsonLine(filepath, record);

      const content = readFileSync(filepath, 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(2);

      const parsed = JSON.parse(lines[1]!) as NdjsonRecord;
      expect(parsed.type).toBe('interactive_end');
      if (parsed.type === 'interactive_end') {
        expect(parsed.confirmed).toBe(true);
        expect(parsed.task).toBe('Build a feature');
      }
    });

    it('should be skipped by loadNdjsonLog (default case)', () => {
      const filepath = initTestNdjsonLog('sess-interactive-003', 'task', 'wf', projectDir);

      appendNdjsonLine(filepath, {
        type: 'interactive_start',
        timestamp: '2025-01-01T00:00:01.000Z',
      } satisfies NdjsonInteractiveStart);

      appendNdjsonLine(filepath, {
        type: 'interactive_end',
        confirmed: true,
        task: 'Some task',
        timestamp: '2025-01-01T00:00:02.000Z',
      } satisfies NdjsonInteractiveEnd);

      const log = loadNdjsonLog(filepath);
      expect(log).not.toBeNull();
      expect(log!.history).toHaveLength(0);
    });
  });

  describe('extractFailureInfo', () => {
    it('should return null for non-existent file', () => {
      const result = extractFailureInfo('/nonexistent/path.jsonl');
      expect(result).toBeNull();
    });

    it('should extract failure info from aborted piece log', () => {
      const filepath = initTestNdjsonLog('20260205-120000-abc123', 'failing task', 'wf', projectDir);

      // Add step_start for plan
      appendNdjsonLine(filepath, {
        type: 'step_start',
        step: 'plan',
        persona: 'planner',
        iteration: 1,
        timestamp: '2025-01-01T00:00:01.000Z',
      });

      // Add step_complete for plan
      appendNdjsonLine(filepath, {
        type: 'step_complete',
        step: 'plan',
        persona: 'planner',
        status: 'done',
        content: 'Plan done',
        instruction: 'Plan it',
        timestamp: '2025-01-01T00:00:02.000Z',
      } satisfies NdjsonStepComplete);

      // Add step_start for implement (fails before completing)
      appendNdjsonLine(filepath, {
        type: 'step_start',
        step: 'implement',
        persona: 'coder',
        iteration: 2,
        timestamp: '2025-01-01T00:00:03.000Z',
      });

      // Add piece_abort
      appendNdjsonLine(filepath, {
        type: 'piece_abort',
        iterations: 1,
        reason: 'spawn node ENOENT',
        endTime: '2025-01-01T00:00:04.000Z',
      } satisfies NdjsonPieceAbort);

      const result = extractFailureInfo(filepath);
      expect(result).not.toBeNull();
      expect(result!.lastCompletedMovement).toBe('plan');
      expect(result!.failedMovement).toBe('implement');
      expect(result!.iterations).toBe(1);
      expect(result!.errorMessage).toBe('spawn node ENOENT');
      expect(result!.sessionId).toBe('20260205-120000-abc123');
    });

    it('should handle log with only completed movements (no abort)', () => {
      const filepath = initTestNdjsonLog('sess-success-001', 'task', 'wf', projectDir);

      appendNdjsonLine(filepath, {
        type: 'step_start',
        step: 'plan',
        persona: 'planner',
        iteration: 1,
        timestamp: '2025-01-01T00:00:01.000Z',
      });

      appendNdjsonLine(filepath, {
        type: 'step_complete',
        step: 'plan',
        persona: 'planner',
        status: 'done',
        content: 'Plan done',
        instruction: 'Plan it',
        timestamp: '2025-01-01T00:00:02.000Z',
      } satisfies NdjsonStepComplete);

      appendNdjsonLine(filepath, {
        type: 'piece_complete',
        iterations: 1,
        endTime: '2025-01-01T00:00:03.000Z',
      });

      const result = extractFailureInfo(filepath);
      expect(result).not.toBeNull();
      expect(result!.lastCompletedMovement).toBe('plan');
      expect(result!.failedMovement).toBeNull();
      expect(result!.iterations).toBe(1);
      expect(result!.errorMessage).toBeNull();
    });

    it('should handle log with no step_complete records', () => {
      const filepath = initTestNdjsonLog('sess-fail-early-001', 'task', 'wf', projectDir);

      appendNdjsonLine(filepath, {
        type: 'step_start',
        step: 'plan',
        persona: 'planner',
        iteration: 1,
        timestamp: '2025-01-01T00:00:01.000Z',
      });

      appendNdjsonLine(filepath, {
        type: 'piece_abort',
        iterations: 0,
        reason: 'API error',
        endTime: '2025-01-01T00:00:02.000Z',
      } satisfies NdjsonPieceAbort);

      const result = extractFailureInfo(filepath);
      expect(result).not.toBeNull();
      expect(result!.lastCompletedMovement).toBeNull();
      expect(result!.failedMovement).toBe('plan');
      expect(result!.iterations).toBe(0);
      expect(result!.errorMessage).toBe('API error');
    });

    it('should return null for empty file', () => {
      const logsDir = join(projectDir, '.takt', 'logs');
      mkdirSync(logsDir, { recursive: true });
      const filepath = join(logsDir, 'empty.jsonl');
      writeFileSync(filepath, '', 'utf-8');

      const result = extractFailureInfo(filepath);
      expect(result).toBeNull();
    });
  });
});
