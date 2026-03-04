import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runReportPhase, type PhaseRunnerContext } from '../core/piece/phase-runner.js';
import type { PieceMovement } from '../core/models/types.js';
import type { RunAgentOptions } from '../agents/runner.js';

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

import { runAgent } from '../agents/runner.js';
import type { AgentResponse } from '../core/models/types.js';

function createStep(fileName: string): PieceMovement {
  return {
    name: 'reviewers',
    personaDisplayName: 'Reviewers',
    instructionTemplate: 'review',
    passPreviousResponse: false,
    outputContracts: [{ name: fileName }],
  };
}

function createContext(
  reportDir: string,
  onBuildResumeOptions?: (overrides: Pick<RunAgentOptions, 'maxTurns'>) => void,
): PhaseRunnerContext {
  let currentSessionId = 'session-1';
  return {
    cwd: reportDir,
    reportDir,
    getSessionId: (_persona: string) => currentSessionId,
    buildResumeOptions: (
      _step,
      _sessionId,
      overrides,
    ) => {
      onBuildResumeOptions?.(overrides);
      return { cwd: reportDir };
    },
    buildNewSessionReportOptions: (
      _step,
      _overrides,
    ) => ({ cwd: reportDir }),
    updatePersonaSession: (_persona, sessionId) => {
      if (sessionId) {
        currentSessionId = sessionId;
      }
    },
  };
}

function queueRunAgentResponses(responses: AgentResponse[]): void {
  const runAgentMock = vi.mocked(runAgent);
  for (const response of responses) {
    runAgentMock.mockImplementationOnce(async (persona, task, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: task,
      });
      return response;
    });
  }
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

  it('should overwrite report file and save versioned copy in the same report directory', async () => {
    // Given
    const reportDir = join(tmpRoot, '.takt', 'runs', 'sample-run', 'reports');
    const step = createStep('05-architect-review.md');
    const ctx = createContext(reportDir);
    queueRunAgentResponses([
      {
        persona: 'reviewers',
        status: 'done',
        content: 'First review result',
        timestamp: new Date('2026-02-10T06:11:43Z'),
        sessionId: 'session-2',
      },
      {
        persona: 'reviewers',
        status: 'done',
        content: 'Second review result',
        timestamp: new Date('2026-02-10T06:14:37Z'),
        sessionId: 'session-3',
      },
    ]);

    // When
    await runReportPhase(step, 1, ctx);
    await runReportPhase(step, 2, ctx);

    // Then
    const latestPath = join(reportDir, '05-architect-review.md');
    const latestContent = readFileSync(latestPath, 'utf-8');
    expect(latestContent).toBe('Second review result');

    const versionedFiles = readdirSync(reportDir).filter(f => f !== '05-architect-review.md');
    expect(versionedFiles).toHaveLength(1);
    expect(versionedFiles[0]).toMatch(/^05-architect-review\.md\.\d{8}T\d{6}Z$/);

    const archivedContent = readFileSync(join(reportDir, versionedFiles[0]!), 'utf-8');
    expect(archivedContent).toBe('First review result');
  });

  it('should add sequence suffix when history file name collides in the same second', async () => {
    // Given
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-10T06:11:43Z'));

    const reportDir = join(tmpRoot, '.takt', 'runs', 'sample-run', 'reports');
    const step = createStep('06-qa-review.md');
    const ctx = createContext(reportDir);
    queueRunAgentResponses([
      {
        persona: 'reviewers',
        status: 'done',
        content: 'v1',
        timestamp: new Date('2026-02-10T06:11:43Z'),
        sessionId: 'session-2',
      },
      {
        persona: 'reviewers',
        status: 'done',
        content: 'v2',
        timestamp: new Date('2026-02-10T06:11:43Z'),
        sessionId: 'session-3',
      },
      {
        persona: 'reviewers',
        status: 'done',
        content: 'v3',
        timestamp: new Date('2026-02-10T06:11:43Z'),
        sessionId: 'session-4',
      },
    ]);

    // When
    await runReportPhase(step, 1, ctx);
    await runReportPhase(step, 2, ctx);
    await runReportPhase(step, 3, ctx);

    // Then
    const versionedFiles = readdirSync(reportDir).filter(f => f !== '06-qa-review.md').sort();
    expect(versionedFiles).toEqual([
      '06-qa-review.md.20260210T061143Z',
      '06-qa-review.md.20260210T061143Z.1',
    ]);
  });

  it('should build report resume options with maxTurns override only', async () => {
    // Given
    const reportDir = join(tmpRoot, '.takt', 'runs', 'sample-run', 'reports');
    const step = createStep('07-permissions-check.md');
    const capturedOverrides: Array<Pick<RunAgentOptions, 'maxTurns'>> = [];
    const ctx = createContext(reportDir, (overrides) => {
      capturedOverrides.push(overrides);
    });
    queueRunAgentResponses([{
      persona: 'reviewers',
      status: 'done',
      content: 'Permission-based report execution',
      timestamp: new Date('2026-02-10T06:21:17Z'),
      sessionId: 'session-2',
    }]);

    // When
    await runReportPhase(step, 1, ctx);

    // Then
    expect(capturedOverrides).toEqual([{ maxTurns: 3 }]);
  });
});
