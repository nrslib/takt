/**
 * Tests for session log incremental writes and pointer management
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createSessionLog,
  updateLatestPointer,
  initNdjsonLog,
  appendNdjsonLine,
  loadNdjsonLog,
  loadSessionLog,
  type LatestLogPointer,
  type SessionLog,
  type NdjsonRecord,
  type NdjsonStepComplete,
  type NdjsonWorkflowComplete,
  type NdjsonWorkflowAbort,
} from '../utils/session.js';

/** Create a temp project directory with .takt/logs structure */
function createTempProject(): string {
  const dir = join(tmpdir(), `takt-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('updateLatestPointer', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = createTempProject();
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('should create latest.json with pointer data', () => {
    const log = createSessionLog('my task', projectDir, 'default');
    const sessionId = 'abc-123';

    updateLatestPointer(log, sessionId, projectDir);

    const latestPath = join(projectDir, '.takt', 'logs', 'latest.json');
    expect(existsSync(latestPath)).toBe(true);

    const pointer = JSON.parse(readFileSync(latestPath, 'utf-8')) as LatestLogPointer;
    expect(pointer.sessionId).toBe('abc-123');
    expect(pointer.logFile).toBe('abc-123.jsonl');
    expect(pointer.task).toBe('my task');
    expect(pointer.workflowName).toBe('default');
    expect(pointer.status).toBe('running');
    expect(pointer.iterations).toBe(0);
    expect(pointer.startTime).toBeDefined();
    expect(pointer.updatedAt).toBeDefined();
  });

  it('should not create previous.json when copyToPrevious is false', () => {
    const log = createSessionLog('task', projectDir, 'wf');
    updateLatestPointer(log, 'sid-1', projectDir);

    const previousPath = join(projectDir, '.takt', 'logs', 'previous.json');
    expect(existsSync(previousPath)).toBe(false);
  });

  it('should not create previous.json when copyToPrevious is true but latest.json does not exist', () => {
    const log = createSessionLog('task', projectDir, 'wf');
    updateLatestPointer(log, 'sid-1', projectDir, { copyToPrevious: true });

    const previousPath = join(projectDir, '.takt', 'logs', 'previous.json');
    // latest.json didn't exist before this call, so previous.json should not be created
    expect(existsSync(previousPath)).toBe(false);
  });

  it('should copy latest.json to previous.json when copyToPrevious is true and latest exists', () => {
    const log1 = createSessionLog('first task', projectDir, 'wf1');
    updateLatestPointer(log1, 'sid-first', projectDir);

    // Simulate a second workflow starting
    const log2 = createSessionLog('second task', projectDir, 'wf2');
    updateLatestPointer(log2, 'sid-second', projectDir, { copyToPrevious: true });

    const logsDir = join(projectDir, '.takt', 'logs');
    const latest = JSON.parse(readFileSync(join(logsDir, 'latest.json'), 'utf-8')) as LatestLogPointer;
    const previous = JSON.parse(readFileSync(join(logsDir, 'previous.json'), 'utf-8')) as LatestLogPointer;

    // latest should point to second session
    expect(latest.sessionId).toBe('sid-second');
    expect(latest.task).toBe('second task');

    // previous should point to first session
    expect(previous.sessionId).toBe('sid-first');
    expect(previous.task).toBe('first task');
  });

  it('should not update previous.json on step-complete calls (no copyToPrevious)', () => {
    // Workflow 1 creates latest
    const log1 = createSessionLog('first', projectDir, 'wf');
    updateLatestPointer(log1, 'sid-1', projectDir);

    // Workflow 2 starts → copies latest to previous
    const log2 = createSessionLog('second', projectDir, 'wf');
    updateLatestPointer(log2, 'sid-2', projectDir, { copyToPrevious: true });

    // Step completes → updates only latest (no copyToPrevious)
    log2.iterations = 1;
    updateLatestPointer(log2, 'sid-2', projectDir);

    const logsDir = join(projectDir, '.takt', 'logs');
    const previous = JSON.parse(readFileSync(join(logsDir, 'previous.json'), 'utf-8')) as LatestLogPointer;

    // previous should still point to first session
    expect(previous.sessionId).toBe('sid-1');
  });

  it('should update iterations and status in latest.json on subsequent calls', () => {
    const log = createSessionLog('task', projectDir, 'wf');
    updateLatestPointer(log, 'sid-1', projectDir, { copyToPrevious: true });

    // Simulate step completion
    log.iterations = 2;
    updateLatestPointer(log, 'sid-1', projectDir);

    // Simulate workflow completion
    log.status = 'completed';
    log.iterations = 3;
    updateLatestPointer(log, 'sid-1', projectDir);

    const latestPath = join(projectDir, '.takt', 'logs', 'latest.json');
    const pointer = JSON.parse(readFileSync(latestPath, 'utf-8')) as LatestLogPointer;
    expect(pointer.status).toBe('completed');
    expect(pointer.iterations).toBe(3);
  });
});

describe('NDJSON log', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = createTempProject();
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  describe('initNdjsonLog', () => {
    it('should create a .jsonl file with workflow_start record', () => {
      const filepath = initNdjsonLog('sess-001', 'my task', 'default', projectDir);

      expect(filepath).toContain('sess-001.jsonl');
      expect(existsSync(filepath)).toBe(true);

      const content = readFileSync(filepath, 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(1);

      const record = JSON.parse(lines[0]!) as NdjsonRecord;
      expect(record.type).toBe('workflow_start');
      if (record.type === 'workflow_start') {
        expect(record.task).toBe('my task');
        expect(record.workflowName).toBe('default');
        expect(record.startTime).toBeDefined();
      }
    });
  });

  describe('appendNdjsonLine', () => {
    it('should append records as individual lines', () => {
      const filepath = initNdjsonLog('sess-002', 'task', 'wf', projectDir);

      const stepStart: NdjsonRecord = {
        type: 'step_start',
        step: 'plan',
        agent: 'planner',
        iteration: 1,
        timestamp: new Date().toISOString(),
      };
      appendNdjsonLine(filepath, stepStart);

      const streamRecord: NdjsonRecord = {
        type: 'stream',
        step: 'plan',
        event: { type: 'text', data: { text: 'hello' } },
        timestamp: new Date().toISOString(),
      };
      appendNdjsonLine(filepath, streamRecord);

      const content = readFileSync(filepath, 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(3); // workflow_start + step_start + stream

      const parsed0 = JSON.parse(lines[0]!) as NdjsonRecord;
      expect(parsed0.type).toBe('workflow_start');

      const parsed1 = JSON.parse(lines[1]!) as NdjsonRecord;
      expect(parsed1.type).toBe('step_start');
      if (parsed1.type === 'step_start') {
        expect(parsed1.step).toBe('plan');
        expect(parsed1.agent).toBe('planner');
        expect(parsed1.iteration).toBe(1);
      }

      const parsed2 = JSON.parse(lines[2]!) as NdjsonRecord;
      expect(parsed2.type).toBe('stream');
      if (parsed2.type === 'stream') {
        expect(parsed2.event.type).toBe('text');
      }
    });
  });

  describe('loadNdjsonLog', () => {
    it('should reconstruct SessionLog from NDJSON file', () => {
      const filepath = initNdjsonLog('sess-003', 'build app', 'default', projectDir);

      // Add step_start + step_complete
      appendNdjsonLine(filepath, {
        type: 'step_start',
        step: 'plan',
        agent: 'planner',
        iteration: 1,
        timestamp: '2025-01-01T00:00:01.000Z',
      });

      const stepComplete: NdjsonStepComplete = {
        type: 'step_complete',
        step: 'plan',
        agent: 'planner',
        status: 'done',
        content: 'Plan completed',
        instruction: 'Create a plan',
        matchedRuleIndex: 0,
        matchedRuleMethod: 'phase3_tag',
        timestamp: '2025-01-01T00:00:02.000Z',
      };
      appendNdjsonLine(filepath, stepComplete);

      const complete: NdjsonWorkflowComplete = {
        type: 'workflow_complete',
        iterations: 1,
        endTime: '2025-01-01T00:00:03.000Z',
      };
      appendNdjsonLine(filepath, complete);

      const log = loadNdjsonLog(filepath);
      expect(log).not.toBeNull();
      expect(log!.task).toBe('build app');
      expect(log!.workflowName).toBe('default');
      expect(log!.status).toBe('completed');
      expect(log!.iterations).toBe(1);
      expect(log!.endTime).toBe('2025-01-01T00:00:03.000Z');
      expect(log!.history).toHaveLength(1);
      expect(log!.history[0]!.step).toBe('plan');
      expect(log!.history[0]!.content).toBe('Plan completed');
      expect(log!.history[0]!.matchedRuleIndex).toBe(0);
      expect(log!.history[0]!.matchedRuleMethod).toBe('phase3_tag');
    });

    it('should handle aborted workflow', () => {
      const filepath = initNdjsonLog('sess-004', 'failing task', 'wf', projectDir);

      appendNdjsonLine(filepath, {
        type: 'step_start',
        step: 'impl',
        agent: 'coder',
        iteration: 1,
        timestamp: '2025-01-01T00:00:01.000Z',
      });

      appendNdjsonLine(filepath, {
        type: 'step_complete',
        step: 'impl',
        agent: 'coder',
        status: 'error',
        content: 'Failed',
        instruction: 'Do the thing',
        error: 'compile error',
        timestamp: '2025-01-01T00:00:02.000Z',
      } satisfies NdjsonStepComplete);

      const abort: NdjsonWorkflowAbort = {
        type: 'workflow_abort',
        iterations: 1,
        reason: 'Max iterations reached',
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

    it('should skip stream and step_start records when reconstructing SessionLog', () => {
      const filepath = initNdjsonLog('sess-005', 'task', 'wf', projectDir);

      // Add various records
      appendNdjsonLine(filepath, {
        type: 'step_start',
        step: 'plan',
        agent: 'planner',
        iteration: 1,
        timestamp: '2025-01-01T00:00:01.000Z',
      });

      appendNdjsonLine(filepath, {
        type: 'stream',
        step: 'plan',
        event: { type: 'text', data: { text: 'working...' } },
        timestamp: '2025-01-01T00:00:01.500Z',
      });

      appendNdjsonLine(filepath, {
        type: 'step_complete',
        step: 'plan',
        agent: 'planner',
        status: 'done',
        content: 'Done',
        instruction: 'Plan it',
        timestamp: '2025-01-01T00:00:02.000Z',
      } satisfies NdjsonStepComplete);

      appendNdjsonLine(filepath, {
        type: 'workflow_complete',
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
      const filepath = initNdjsonLog('sess-006', 'jsonl task', 'wf', projectDir);

      appendNdjsonLine(filepath, {
        type: 'step_complete',
        step: 'plan',
        agent: 'planner',
        status: 'done',
        content: 'Plan done',
        instruction: 'Plan',
        timestamp: '2025-01-01T00:00:02.000Z',
      } satisfies NdjsonStepComplete);

      appendNdjsonLine(filepath, {
        type: 'workflow_complete',
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
        workflowName: 'wf',
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
      const filepath = initNdjsonLog('sess-007', 'task', 'wf', projectDir);

      // Read after init
      const after1 = readFileSync(filepath, 'utf-8').trim().split('\n');
      expect(after1).toHaveLength(1);

      // Append more records
      appendNdjsonLine(filepath, {
        type: 'stream',
        step: 'plan',
        event: { type: 'text', data: { text: 'chunk1' } },
        timestamp: '2025-01-01T00:00:01.000Z',
      });

      const after2 = readFileSync(filepath, 'utf-8').trim().split('\n');
      expect(after2).toHaveLength(2);
      // First line should still be workflow_start
      expect(JSON.parse(after2[0]!).type).toBe('workflow_start');
    });

    it('should produce valid JSON on each line', () => {
      const filepath = initNdjsonLog('sess-008', 'task', 'wf', projectDir);

      for (let i = 0; i < 5; i++) {
        appendNdjsonLine(filepath, {
          type: 'stream',
          step: 'plan',
          event: { type: 'text', data: { text: `chunk-${i}` } },
          timestamp: new Date().toISOString(),
        });
      }

      const content = readFileSync(filepath, 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(6); // 1 init + 5 stream

      // Every line should be valid JSON
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    });
  });
});
