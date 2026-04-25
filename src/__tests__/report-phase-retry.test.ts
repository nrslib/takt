import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runReportPhase, type PhaseRunnerContext } from '../core/workflow/phase-runner.js';
import type { WorkflowStep } from '../core/models/types.js';

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

import { runAgent } from '../agents/runner.js';
import type { AgentResponse } from '../core/models/types.js';

const RATE_LIMIT_MESSAGE = 'Rate limit exceeded. Please try again later.';

function createStep(fileName: string): WorkflowStep {
  return {
    name: 'implement',
    persona: 'coder',
    personaDisplayName: 'Coder',
    instruction: 'Implement task',
    passPreviousResponse: false,
    outputContracts: [{ name: fileName }],
  };
}

function createContext(
  reportDir: string,
  lastResponse?: string,
  initialSessionId?: string,
): PhaseRunnerContext {
  const currentLastResponse = arguments.length >= 2 ? lastResponse : 'Phase 1 result';
  let currentSessionId = arguments.length >= 3 ? initialSessionId : 'session-resume-1';

  return {
    cwd: reportDir,
    reportDir,
    language: 'en',
    lastResponse: currentLastResponse,
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

  it('should start report phase with a new session when no existing session is available', async () => {
    // Given
    const reportDir = join(tmpRoot, '.takt', 'runs', 'sample-run', 'reports');
    const step = createStep('01-team-leader.md');
    const ctx = createContext(reportDir, 'Aggregated team leader output', undefined);
    queueRunAgentResponses([{
      persona: 'coder',
      status: 'done',
      content: '# Report\nFresh session output',
      timestamp: new Date('2026-02-11T00:00:30Z'),
      sessionId: 'session-fresh-1',
    }]);
    const runAgentMock = vi.mocked(runAgent);

    // When
    await runReportPhase(step, 1, ctx);

    // Then
    const reportPath = join(reportDir, '01-team-leader.md');
    expect(readFileSync(reportPath, 'utf-8')).toBe('# Report\nFresh session output');
    expect(runAgentMock).toHaveBeenCalledTimes(1);

    const firstCallInstruction = runAgentMock.mock.calls[0]?.[1] as string;
    const firstCallOptions = runAgentMock.mock.calls[0]?.[2] as { sessionId?: string };
    expect(firstCallOptions.sessionId).toBeUndefined();
    expect(firstCallInstruction).toContain('## Previous Work Context');
    expect(firstCallInstruction).toContain('Aggregated team leader output');
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

  it('should fail immediately without retry when resumed session errors and lastResponse is unavailable', async () => {
    // Given
    const reportDir = join(tmpRoot, '.takt', 'runs', 'sample-run', 'reports');
    const step = createStep('04-qa.md');
    const ctx = createContext(reportDir, undefined, 'session-resume-1');
    queueRunAgentResponses([{
      persona: 'coder',
      status: 'error',
      content: 'Tool use is not allowed in this phase',
      timestamp: new Date('2026-02-11T00:02:30Z'),
      error: 'Tool use is not allowed in this phase',
    }]);
    const runAgentMock = vi.mocked(runAgent);

    // When / Then
    await expect(runReportPhase(step, 1, ctx)).rejects.toThrow(
      'Report phase failed for 04-qa.md: Tool use is not allowed in this phase',
    );
    expect(runAgentMock).toHaveBeenCalledTimes(1);
  });

  it('should fail immediately without retry when resumed session hits the rate limit', async () => {
    // Given
    const reportDir = join(tmpRoot, '.takt', 'runs', 'sample-run', 'reports');
    const step = createStep('04-qa.md');
    const ctx = createContext(reportDir, 'Aggregated reviewer output', 'session-resume-1');
    queueRunAgentResponses([{
      persona: 'coder',
      status: 'error',
      content: RATE_LIMIT_MESSAGE,
      timestamp: new Date('2026-02-11T00:02:32Z'),
      error: RATE_LIMIT_MESSAGE,
      errorKind: 'rate_limit',
    }]);
    const runAgentMock = vi.mocked(runAgent);

    // When / Then
    await expect(runReportPhase(step, 1, ctx)).rejects.toThrow(
      `Report phase failed for 04-qa.md: ${RATE_LIMIT_MESSAGE}`,
    );
    expect(runAgentMock).toHaveBeenCalledTimes(1);

    const firstCallOptions = runAgentMock.mock.calls[0]?.[2] as { sessionId?: string };
    expect(firstCallOptions.sessionId).toBe('session-resume-1');
  });

  it('should not depend on provider-specific error text when rate limit is classified', async () => {
    // Given
    const reportDir = join(tmpRoot, '.takt', 'runs', 'sample-run', 'reports');
    const step = createStep('04-qa.md');
    const ctx = createContext(reportDir, 'Aggregated reviewer output', 'session-resume-1');
    queueRunAgentResponses([{
      persona: 'coder',
      status: 'error',
      content: 'Claude Code process exited with code 1',
      timestamp: new Date('2026-02-11T00:02:33Z'),
      error: 'Claude Code process exited with code 1',
      errorKind: 'rate_limit',
    }]);
    const runAgentMock = vi.mocked(runAgent);

    // When / Then
    await expect(runReportPhase(step, 1, ctx)).rejects.toThrow(
      `Report phase failed for 04-qa.md: ${RATE_LIMIT_MESSAGE}`,
    );
    expect(runAgentMock).toHaveBeenCalledTimes(1);
  });

  it('should fail immediately without retry when resumed session returns empty output and lastResponse is unavailable', async () => {
    // Given
    const reportDir = join(tmpRoot, '.takt', 'runs', 'sample-run', 'reports');
    const step = createStep('04-qa.md');
    const ctx = createContext(reportDir, undefined, 'session-resume-1');
    queueRunAgentResponses([{
      persona: 'coder',
      status: 'done',
      content: '   ',
      timestamp: new Date('2026-02-11T00:02:35Z'),
    }]);
    const runAgentMock = vi.mocked(runAgent);

    // When / Then
    await expect(runReportPhase(step, 1, ctx)).rejects.toThrow(
      'Report phase failed for 04-qa.md: Report output is empty',
    );
    expect(runAgentMock).toHaveBeenCalledTimes(1);
  });

  it('should throw when no existing session and no lastResponse are available', async () => {
    // Given
    const reportDir = join(tmpRoot, '.takt', 'runs', 'sample-run', 'reports');
    const step = createStep('04-qa.md');
    const ctx = createContext(reportDir, undefined, undefined);
    const runAgentMock = vi.mocked(runAgent);

    // When / Then
    await expect(runReportPhase(step, 1, ctx)).rejects.toThrow(
      'Report phase requires a session to resume, but no sessionId found for persona "coder" in step "implement"',
    );
    expect(runAgentMock).not.toHaveBeenCalled();
  });

  it('should fail immediately without retry when new-session first attempt returns empty output', async () => {
    // Given
    const reportDir = join(tmpRoot, '.takt', 'runs', 'sample-run', 'reports');
    const step = createStep('04-qa.md');
    const ctx = createContext(reportDir, 'Aggregated team leader output', undefined);
    queueRunAgentResponses([{
      persona: 'coder',
      status: 'done',
      content: '   ',
      timestamp: new Date('2026-02-11T00:02:45Z'),
    }]);
    const runAgentMock = vi.mocked(runAgent);

    // When / Then
    await expect(runReportPhase(step, 1, ctx)).rejects.toThrow(
      'Report phase failed for 04-qa.md: Report output is empty',
    );
    expect(runAgentMock).toHaveBeenCalledTimes(1);
  });

  it('should fail immediately without retry when new-session first attempt status is error', async () => {
    // Given
    const reportDir = join(tmpRoot, '.takt', 'runs', 'sample-run', 'reports');
    const step = createStep('04-qa.md');
    const ctx = createContext(reportDir, 'Aggregated team leader output', undefined);
    queueRunAgentResponses([{
      persona: 'coder',
      status: 'error',
      content: 'Tool use is not allowed in this phase',
      timestamp: new Date('2026-02-11T00:02:50Z'),
      error: 'Tool use is not allowed in this phase',
    }]);
    const runAgentMock = vi.mocked(runAgent);

    // When / Then
    await expect(runReportPhase(step, 1, ctx)).rejects.toThrow(
      'Report phase failed for 04-qa.md: Tool use is not allowed in this phase',
    );
    expect(runAgentMock).toHaveBeenCalledTimes(1);
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

  it('should resume the next report file with the session returned by the first new-session report', async () => {
    // Given
    const reportDir = join(tmpRoot, '.takt', 'runs', 'sample-run', 'reports');
    const step: WorkflowStep = {
      name: 'implement',
      persona: 'coder',
      personaDisplayName: 'Coder',
      instruction: 'Implement task',
      passPreviousResponse: false,
      outputContracts: [{ name: 'first.md' }, { name: 'second.md' }],
    };
    const resumedSessionIds: string[] = [];
    const ctx = createContext(reportDir, 'Aggregated output from team leader', undefined);
    const originalBuildResumeOptions = ctx.buildResumeOptions;
    ctx.buildResumeOptions = (currentStep, sessionId, overrides) => {
      resumedSessionIds.push(sessionId);
      return originalBuildResumeOptions(currentStep, sessionId, overrides);
    };
    queueRunAgentResponses([
      {
        persona: 'coder',
        status: 'done',
        content: 'first report',
        timestamp: new Date('2026-02-11T00:03:30Z'),
        sessionId: 'session-fresh-1',
      },
      {
        persona: 'coder',
        status: 'done',
        content: 'second report',
        timestamp: new Date('2026-02-11T00:03:31Z'),
        sessionId: 'session-fresh-2',
      },
    ]);
    const runAgentMock = vi.mocked(runAgent);

    // When
    await runReportPhase(step, 1, ctx);

    // Then
    expect(resumedSessionIds).toEqual(['session-fresh-1']);
    expect(readFileSync(join(reportDir, 'first.md'), 'utf-8')).toBe('first report');
    expect(readFileSync(join(reportDir, 'second.md'), 'utf-8')).toBe('second report');

    const secondCallOptions = runAgentMock.mock.calls[1]?.[2] as { sessionId?: string };
    expect(secondCallOptions.sessionId).toBe('session-fresh-1');
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
