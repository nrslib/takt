/**
 * Tests for runSessionReader
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('../infra/fs/session.js', () => ({
  loadNdjsonLog: vi.fn(),
}));

import { loadNdjsonLog } from '../infra/fs/session.js';
import {
  listRecentRuns,
  findRunForTask,
  loadRunSessionContext,
  formatRunSessionForPrompt,
  type RunSessionContext,
} from '../features/interactive/runSessionReader.js';

const mockLoadNdjsonLog = vi.mocked(loadNdjsonLog);

function createTmpDir(): string {
  const dir = join(tmpdir(), `takt-test-runSessionReader-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function createRunDir(
  cwd: string,
  slug: string,
  meta: Record<string, unknown>,
): string {
  const runDir = join(cwd, '.takt', 'runs', slug);
  mkdirSync(join(runDir, 'logs'), { recursive: true });
  mkdirSync(join(runDir, 'reports'), { recursive: true });
  writeFileSync(join(runDir, 'meta.json'), JSON.stringify(meta), 'utf-8');
  return runDir;
}

describe('listRecentRuns', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir();
    vi.clearAllMocks();
  });

  it('should return empty array when .takt/runs does not exist', () => {
    const result = listRecentRuns(tmpDir);
    expect(result).toEqual([]);
  });

  it('should return empty array when no runs have meta.json', () => {
    mkdirSync(join(tmpDir, '.takt', 'runs', 'empty-run'), { recursive: true });
    const result = listRecentRuns(tmpDir);
    expect(result).toEqual([]);
  });

  it('should return runs sorted by startTime descending', () => {
    createRunDir(tmpDir, 'run-old', {
      task: 'Old task',
      piece: 'default',
      status: 'completed',
      startTime: '2026-01-01T00:00:00.000Z',
      logsDirectory: '.takt/runs/run-old/logs',
      reportDirectory: '.takt/runs/run-old/reports',
      runSlug: 'run-old',
    });
    createRunDir(tmpDir, 'run-new', {
      task: 'New task',
      piece: 'custom',
      status: 'running',
      startTime: '2026-02-01T00:00:00.000Z',
      logsDirectory: '.takt/runs/run-new/logs',
      reportDirectory: '.takt/runs/run-new/reports',
      runSlug: 'run-new',
    });

    const result = listRecentRuns(tmpDir);
    expect(result).toHaveLength(2);
    expect(result[0].slug).toBe('run-new');
    expect(result[1].slug).toBe('run-old');
  });

  it('should limit results to 10', () => {
    for (let i = 0; i < 12; i++) {
      const slug = `run-${String(i).padStart(2, '0')}`;
      createRunDir(tmpDir, slug, {
        task: `Task ${i}`,
        piece: 'default',
        status: 'completed',
        startTime: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
        logsDirectory: `.takt/runs/${slug}/logs`,
        reportDirectory: `.takt/runs/${slug}/reports`,
        runSlug: slug,
      });
    }

    const result = listRecentRuns(tmpDir);
    expect(result).toHaveLength(10);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('findRunForTask', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir();
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should return null when no runs exist', () => {
    const result = findRunForTask(tmpDir, 'Some task');
    expect(result).toBeNull();
  });

  it('should return null when no runs match the task content', () => {
    createRunDir(tmpDir, 'run-other', {
      task: 'Different task',
      piece: 'default',
      status: 'completed',
      startTime: '2026-02-01T00:00:00.000Z',
      logsDirectory: '.takt/runs/run-other/logs',
      reportDirectory: '.takt/runs/run-other/reports',
      runSlug: 'run-other',
    });

    const result = findRunForTask(tmpDir, 'My specific task');
    expect(result).toBeNull();
  });

  it('should return the matching run slug', () => {
    createRunDir(tmpDir, 'run-match', {
      task: 'Build login page',
      piece: 'default',
      status: 'failed',
      startTime: '2026-02-01T00:00:00.000Z',
      logsDirectory: '.takt/runs/run-match/logs',
      reportDirectory: '.takt/runs/run-match/reports',
      runSlug: 'run-match',
    });

    const result = findRunForTask(tmpDir, 'Build login page');
    expect(result).toBe('run-match');
  });

  it('should return the most recent matching run when multiple exist', () => {
    createRunDir(tmpDir, 'run-old', {
      task: 'Build login page',
      piece: 'default',
      status: 'failed',
      startTime: '2026-01-01T00:00:00.000Z',
      logsDirectory: '.takt/runs/run-old/logs',
      reportDirectory: '.takt/runs/run-old/reports',
      runSlug: 'run-old',
    });
    createRunDir(tmpDir, 'run-new', {
      task: 'Build login page',
      piece: 'default',
      status: 'failed',
      startTime: '2026-02-01T00:00:00.000Z',
      logsDirectory: '.takt/runs/run-new/logs',
      reportDirectory: '.takt/runs/run-new/reports',
      runSlug: 'run-new',
    });

    const result = findRunForTask(tmpDir, 'Build login page');
    expect(result).toBe('run-new');
  });
});

describe('loadRunSessionContext', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir();
    vi.clearAllMocks();
  });

  it('should throw when run does not exist', () => {
    expect(() => loadRunSessionContext(tmpDir, 'nonexistent')).toThrow('Run not found: nonexistent');
  });

  it('should load context with movement logs and reports', () => {
    const slug = 'test-run';
    const runDir = createRunDir(tmpDir, slug, {
      task: 'Test task',
      piece: 'default',
      status: 'completed',
      startTime: '2026-02-01T00:00:00.000Z',
      logsDirectory: `.takt/runs/${slug}/logs`,
      reportDirectory: `.takt/runs/${slug}/reports`,
      runSlug: slug,
    });

    // Create a log file
    writeFileSync(join(runDir, 'logs', 'session-001.jsonl'), '{}', 'utf-8');

    // Create a report file
    writeFileSync(join(runDir, 'reports', '00-plan.md'), '# Plan\nDetails here', 'utf-8');

    mockLoadNdjsonLog.mockReturnValue({
      task: 'Test task',
      projectDir: '',
      pieceName: 'default',
      iterations: 1,
      startTime: '2026-02-01T00:00:00.000Z',
      status: 'completed',
      history: [
        {
          step: 'implement',
          persona: 'coder',
          instruction: 'Implement feature',
          status: 'completed',
          timestamp: '2026-02-01T00:01:00.000Z',
          content: 'Implementation done',
        },
      ],
    });

    const context = loadRunSessionContext(tmpDir, slug);

    expect(context.task).toBe('Test task');
    expect(context.piece).toBe('default');
    expect(context.status).toBe('completed');
    expect(context.movementLogs).toHaveLength(1);
    expect(context.movementLogs[0].step).toBe('implement');
    expect(context.movementLogs[0].content).toBe('Implementation done');
    expect(context.reports).toHaveLength(1);
    expect(context.reports[0].filename).toBe('00-plan.md');
  });

  it('should truncate movement content to 500 characters', () => {
    const slug = 'truncate-run';
    const runDir = createRunDir(tmpDir, slug, {
      task: 'Truncate test',
      piece: 'default',
      status: 'completed',
      startTime: '2026-02-01T00:00:00.000Z',
      logsDirectory: `.takt/runs/${slug}/logs`,
      reportDirectory: `.takt/runs/${slug}/reports`,
      runSlug: slug,
    });

    writeFileSync(join(runDir, 'logs', 'session-001.jsonl'), '{}', 'utf-8');

    const longContent = 'A'.repeat(600);
    mockLoadNdjsonLog.mockReturnValue({
      task: 'Truncate test',
      projectDir: '',
      pieceName: 'default',
      iterations: 1,
      startTime: '2026-02-01T00:00:00.000Z',
      status: 'completed',
      history: [
        {
          step: 'implement',
          persona: 'coder',
          instruction: 'Do it',
          status: 'completed',
          timestamp: '2026-02-01T00:01:00.000Z',
          content: longContent,
        },
      ],
    });

    const context = loadRunSessionContext(tmpDir, slug);

    expect(context.movementLogs[0].content.length).toBe(501); // 500 + '…'
    expect(context.movementLogs[0].content.endsWith('…')).toBe(true);
  });

  it('should handle missing log files gracefully', () => {
    const slug = 'no-logs-run';
    createRunDir(tmpDir, slug, {
      task: 'No logs',
      piece: 'default',
      status: 'completed',
      startTime: '2026-02-01T00:00:00.000Z',
      logsDirectory: `.takt/runs/${slug}/logs`,
      reportDirectory: `.takt/runs/${slug}/reports`,
      runSlug: slug,
    });

    const context = loadRunSessionContext(tmpDir, slug);
    expect(context.movementLogs).toEqual([]);
    expect(context.reports).toEqual([]);
  });

  it('should exclude provider-events log files', () => {
    const slug = 'provider-events-run';
    const runDir = createRunDir(tmpDir, slug, {
      task: 'Provider events test',
      piece: 'default',
      status: 'completed',
      startTime: '2026-02-01T00:00:00.000Z',
      logsDirectory: `.takt/runs/${slug}/logs`,
      reportDirectory: `.takt/runs/${slug}/reports`,
      runSlug: slug,
    });

    // Only provider-events log file
    writeFileSync(join(runDir, 'logs', 'session-001-provider-events.jsonl'), '{}', 'utf-8');

    const context = loadRunSessionContext(tmpDir, slug);
    expect(mockLoadNdjsonLog).not.toHaveBeenCalled();
    expect(context.movementLogs).toEqual([]);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('formatRunSessionForPrompt', () => {
  it('should format context into prompt variables', () => {
    const ctx: RunSessionContext = {
      task: 'Implement feature X',
      piece: 'default',
      status: 'completed',
      movementLogs: [
        { step: 'plan', persona: 'architect', status: 'completed', content: 'Plan content' },
        { step: 'implement', persona: 'coder', status: 'completed', content: 'Code content' },
      ],
      reports: [
        { filename: '00-plan.md', content: '# Plan\nDetails' },
      ],
    };

    const result = formatRunSessionForPrompt(ctx);

    expect(result.runTask).toBe('Implement feature X');
    expect(result.runPiece).toBe('default');
    expect(result.runStatus).toBe('completed');
    expect(result.runMovementLogs).toContain('plan');
    expect(result.runMovementLogs).toContain('architect');
    expect(result.runMovementLogs).toContain('Plan content');
    expect(result.runMovementLogs).toContain('implement');
    expect(result.runMovementLogs).toContain('Code content');
    expect(result.runReports).toContain('00-plan.md');
    expect(result.runReports).toContain('# Plan\nDetails');
  });

  it('should handle empty logs and reports', () => {
    const ctx: RunSessionContext = {
      task: 'Empty task',
      piece: 'default',
      status: 'aborted',
      movementLogs: [],
      reports: [],
    };

    const result = formatRunSessionForPrompt(ctx);

    expect(result.runTask).toBe('Empty task');
    expect(result.runMovementLogs).toBe('');
    expect(result.runReports).toBe('');
  });
});
