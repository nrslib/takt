import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runReportPhase, type PhaseRunnerContext } from '../core/piece/phase-runner.js';
import type { PieceMovement } from '../core/models/types.js';

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

import { runAgent } from '../agents/runner.js';
import type { AgentResponse } from '../core/models/types.js';

function createStep(fileName: string): PieceMovement {
  return {
    name: 'implement',
    persona: 'coder',
    personaDisplayName: 'Coder',
    instructionTemplate: 'Implement task',
    passPreviousResponse: false,
    outputContracts: [{ name: fileName }],
  };
}

function createContext(reportDir: string, lastResponse = 'Phase 1 result'): PhaseRunnerContext {
  let currentSessionId = 'session-resume-1';

  return {
    cwd: reportDir,
    reportDir,
    language: 'en',
    lastResponse,
    getSessionId: (_persona: string) => currentSessionId,
    buildResumeOptions: (_step, sessionId, overrides) => ({
      cwd: reportDir,
      sessionId,
      allowedTools: overrides.allowedTools,
      maxTurns: overrides.maxTurns,
    }),
    buildNewSessionReportOptions: (_step, overrides) => ({
      cwd: reportDir,
      allowedTools: overrides.allowedTools,
      maxTurns: overrides.maxTurns,
    }),
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

describe('runReportPhase retry with new session', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'takt-report-retry-'));
    vi.resetAllMocks();
  });

  afterEach(() => {
    if (existsSync(tmpRoot)) {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('should retry with new session when first attempt returns empty content', async () => {
    // Given
    const reportDir = join(tmpRoot, '.takt', 'runs', 'sample-run', 'reports');
    const step = createStep('02-coder.md');
    const ctx = createContext(reportDir, 'Implemented feature X');
    queueRunAgentResponses([
      {
        persona: 'coder',
        status: 'done',
        content: '   ',
        timestamp: new Date('2026-02-11T00:00:00Z'),
        sessionId: 'session-resume-2',
      },
      {
        persona: 'coder',
        status: 'done',
        content: '# Report\nRecovered output',
        timestamp: new Date('2026-02-11T00:00:01Z'),
        sessionId: 'session-fresh-1',
      },
    ]);
    const runAgentMock = vi.mocked(runAgent);

    // When
    await runReportPhase(step, 1, ctx);

    // Then
    const reportPath = join(reportDir, '02-coder.md');
    expect(readFileSync(reportPath, 'utf-8')).toBe('# Report\nRecovered output');
    expect(runAgentMock).toHaveBeenCalledTimes(2);

    const secondCallOptions = runAgentMock.mock.calls[1]?.[2] as { sessionId?: string };
    expect(secondCallOptions.sessionId).toBeUndefined();

    const secondInstruction = runAgentMock.mock.calls[1]?.[1] as string;
    expect(secondInstruction).toContain('## Previous Work Context');
    expect(secondInstruction).toContain('Implemented feature X');
  });

  it('should retry with new session when first attempt status is error', async () => {
    // Given
    const reportDir = join(tmpRoot, '.takt', 'runs', 'sample-run', 'reports');
    const step = createStep('03-review.md');
    const ctx = createContext(reportDir);
    queueRunAgentResponses([
      {
        persona: 'coder',
        status: 'error',
        content: 'Tool use is not allowed in this phase',
        timestamp: new Date('2026-02-11T00:01:00Z'),
        error: 'Tool use is not allowed in this phase',
      },
      {
        persona: 'coder',
        status: 'done',
        content: 'Recovered report',
        timestamp: new Date('2026-02-11T00:01:01Z'),
      },
    ]);
    const runAgentMock = vi.mocked(runAgent);

    // When
    await runReportPhase(step, 1, ctx);

    // Then
    const reportPath = join(reportDir, '03-review.md');
    expect(readFileSync(reportPath, 'utf-8')).toBe('Recovered report');
    expect(runAgentMock).toHaveBeenCalledTimes(2);
  });

  it('should throw when both attempts return empty output', async () => {
    // Given
    const reportDir = join(tmpRoot, '.takt', 'runs', 'sample-run', 'reports');
    const step = createStep('04-qa.md');
    const ctx = createContext(reportDir);
    queueRunAgentResponses([
      {
        persona: 'coder',
        status: 'done',
        content: ' ',
        timestamp: new Date('2026-02-11T00:02:00Z'),
      },
      {
        persona: 'coder',
        status: 'done',
        content: '\n\n',
        timestamp: new Date('2026-02-11T00:02:01Z'),
      },
    ]);
    const runAgentMock = vi.mocked(runAgent);

    // When / Then
    await expect(runReportPhase(step, 1, ctx)).rejects.toThrow('Report phase failed for 04-qa.md: Report output is empty');
    expect(runAgentMock).toHaveBeenCalledTimes(2);
  });

  it('should not retry when first attempt succeeds', async () => {
    // Given
    const reportDir = join(tmpRoot, '.takt', 'runs', 'sample-run', 'reports');
    const step = createStep('05-ok.md');
    const ctx = createContext(reportDir);
    queueRunAgentResponses([{
      persona: 'coder',
      status: 'done',
      content: 'Single-pass success',
      timestamp: new Date('2026-02-11T00:03:00Z'),
      sessionId: 'session-resume-2',
    }]);
    const runAgentMock = vi.mocked(runAgent);

    // When
    await runReportPhase(step, 1, ctx);

    // Then
    expect(runAgentMock).toHaveBeenCalledTimes(1);
    const reportPath = join(reportDir, '05-ok.md');
    expect(readFileSync(reportPath, 'utf-8')).toBe('Single-pass success');
  });

  it('should return blocked result without retry', async () => {
    // Given
    const reportDir = join(tmpRoot, '.takt', 'runs', 'sample-run', 'reports');
    const step = createStep('06-blocked.md');
    const ctx = createContext(reportDir);
    queueRunAgentResponses([{
      persona: 'coder',
      status: 'blocked',
      content: 'Need permission',
      timestamp: new Date('2026-02-11T00:04:00Z'),
    }]);
    const runAgentMock = vi.mocked(runAgent);

    // When
    const result = await runReportPhase(step, 1, ctx);

    // Then
    expect(result).toEqual({
      blocked: true,
      response: {
        persona: 'coder',
        status: 'blocked',
        content: 'Need permission',
        timestamp: new Date('2026-02-11T00:04:00Z'),
      },
    });
    expect(runAgentMock).toHaveBeenCalledTimes(1);
  });
});
