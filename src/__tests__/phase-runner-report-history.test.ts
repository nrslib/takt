import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runReportPhase, type PhaseRunnerContext } from '../core/piece/phase-runner.js';
import type { PieceMovement } from '../core/models/types.js';

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

import { runAgent } from '../agents/runner.js';

function createStep(fileName: string): PieceMovement {
  return {
    name: 'reviewers',
    personaDisplayName: 'Reviewers',
    instructionTemplate: 'review',
    passPreviousResponse: false,
    outputContracts: [{ name: fileName }],
  };
}

function createContext(reportDir: string): PhaseRunnerContext {
  let currentSessionId = 'session-1';
  return {
    cwd: reportDir,
    reportDir,
    getSessionId: (_persona: string) => currentSessionId,
    buildResumeOptions: (
      _step,
      _sessionId,
      _overrides,
    ) => ({ cwd: reportDir }),
    updatePersonaSession: (_persona, sessionId) => {
      if (sessionId) {
        currentSessionId = sessionId;
      }
    },
  };
}

describe('runReportPhase report history behavior', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'takt-report-history-'));
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (existsSync(tmpRoot)) {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('should overwrite report file and archive previous content to reports-history', async () => {
    // Given
    const reportDir = join(tmpRoot, '.takt', 'runs', 'sample-run', 'reports');
    const step = createStep('05-architect-review.md');
    const ctx = createContext(reportDir);
    const runAgentMock = vi.mocked(runAgent);
    runAgentMock
      .mockResolvedValueOnce({
        persona: 'reviewers',
        status: 'done',
        content: 'First review result',
        timestamp: new Date('2026-02-10T06:11:43Z'),
        sessionId: 'session-2',
      })
      .mockResolvedValueOnce({
        persona: 'reviewers',
        status: 'done',
        content: 'Second review result',
        timestamp: new Date('2026-02-10T06:14:37Z'),
        sessionId: 'session-3',
      });

    // When
    await runReportPhase(step, 1, ctx);
    await runReportPhase(step, 2, ctx);

    // Then
    const latestPath = join(reportDir, '05-architect-review.md');
    const latestContent = readFileSync(latestPath, 'utf-8');
    expect(latestContent).toBe('Second review result');

    const historyDir = join(tmpRoot, '.takt', 'runs', 'sample-run', 'logs', 'reports-history');
    const historyFiles = readdirSync(historyDir);
    expect(historyFiles).toHaveLength(1);
    expect(historyFiles[0]).toMatch(/^05-architect-review\.\d{8}T\d{6}Z\.md$/);

    const archivedContent = readFileSync(join(historyDir, historyFiles[0]!), 'utf-8');
    expect(archivedContent).toBe('First review result');
  });

  it('should add sequence suffix when history file name collides in the same second', async () => {
    // Given
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-10T06:11:43Z'));

    const reportDir = join(tmpRoot, '.takt', 'runs', 'sample-run', 'reports');
    const step = createStep('06-qa-review.md');
    const ctx = createContext(reportDir);
    const runAgentMock = vi.mocked(runAgent);
    runAgentMock
      .mockResolvedValueOnce({
        persona: 'reviewers',
        status: 'done',
        content: 'v1',
        timestamp: new Date('2026-02-10T06:11:43Z'),
        sessionId: 'session-2',
      })
      .mockResolvedValueOnce({
        persona: 'reviewers',
        status: 'done',
        content: 'v2',
        timestamp: new Date('2026-02-10T06:11:43Z'),
        sessionId: 'session-3',
      })
      .mockResolvedValueOnce({
        persona: 'reviewers',
        status: 'done',
        content: 'v3',
        timestamp: new Date('2026-02-10T06:11:43Z'),
        sessionId: 'session-4',
      });

    // When
    await runReportPhase(step, 1, ctx);
    await runReportPhase(step, 2, ctx);
    await runReportPhase(step, 3, ctx);

    // Then
    const historyDir = join(tmpRoot, '.takt', 'runs', 'sample-run', 'logs', 'reports-history');
    const historyFiles = readdirSync(historyDir).sort();
    expect(historyFiles).toEqual([
      '06-qa-review.20260210T061143Z.1.md',
      '06-qa-review.20260210T061143Z.md',
    ]);
  });
});
