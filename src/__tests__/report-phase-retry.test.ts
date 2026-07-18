import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { infoSpy } = vi.hoisted(() => ({
  infoSpy: vi.fn(),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: infoSpy,
    error: vi.fn(),
    trace: vi.fn(),
    enter: vi.fn(),
    exit: vi.fn(),
  })),
}));

import { runReportPhase, type ReportPhaseRunnerContext } from '../core/workflow/phase-runner.js';
import type { WorkflowStep } from '../core/models/types.js';
import type { StreamEvent } from '../shared/types/provider.js';

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
  providers: {
    primaryProvider?: 'claude' | 'codex' | 'opencode' | 'mock';
    fallbackProvider?: 'claude' | 'codex' | 'opencode' | 'mock';
    fallbackModel?: string;
  } = {},
): ReportPhaseRunnerContext {
  const currentLastResponse = arguments.length >= 2 ? lastResponse : 'Phase 1 result';
  let currentSessionId = arguments.length >= 3 ? initialSessionId : 'session-resume-1';
  const primaryProvider = providers.primaryProvider ?? 'opencode';
  const fallbackProvider = providers.fallbackProvider ?? 'claude';

  const context = {
    cwd: reportDir,
    reportDir,
    language: 'en',
    lastResponse: currentLastResponse,
    resolveSessionKey: (step) => step.persona ?? step.name,
    getSessionId: (_persona: string) => currentSessionId,
    buildResumeOptions: (_step, sessionId, overrides) => ({
      cwd: reportDir,
      resolvedProvider: primaryProvider,
      sessionId,
      allowedTools: overrides.allowedTools,
      maxTurns: overrides.maxTurns,
    }),
    buildNewSessionReportOptions: (_step, overrides) => ({
      cwd: reportDir,
      resolvedProvider: primaryProvider,
      allowedTools: overrides.allowedTools,
      maxTurns: overrides.maxTurns,
    }),
    buildFallbackReportOptions: (_step, failedPrimaryOptions, overrides) => {
      if (failedPrimaryOptions.resolvedProvider !== 'opencode' || fallbackProvider === failedPrimaryOptions.resolvedProvider) {
        return undefined;
      }

      return {
        cwd: reportDir,
        permissionMode: 'readonly',
        resolvedProvider: fallbackProvider,
        resolvedModel: providers.fallbackModel,
        sessionId: undefined,
        allowedTools: overrides.allowedTools,
        maxTurns: overrides.maxTurns,
      };
    },
    updatePersonaSession: (_persona, sessionId) => {
      if (sessionId === undefined) {
        currentSessionId = undefined;
      } else {
        currentSessionId = sessionId;
      }
    },
    resolveReportFallbackProviderModel: () => ({
      provider: fallbackProvider,
      model: providers.fallbackModel,
    }),
    resolveStepProviderModel: (_step) => ({
      provider: primaryProvider,
    }),
  };
  return context;
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

function queueRunAgentAttempts(
  attempts: Array<{ response: AgentResponse; streamEvents?: StreamEvent[] }>,
): void {
  const runAgentMock = vi.mocked(runAgent);
  for (const attempt of attempts) {
    runAgentMock.mockImplementationOnce(async (persona, task, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: task,
      });
      for (const event of attempt.streamEvents ?? []) {
        options?.onStream?.(event);
      }
      return attempt.response;
    });
  }
}

describe('runReportPhase retry with new session', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'takt-report-retry-'));
    vi.resetAllMocks();
    infoSpy.mockClear();
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
    ctx.onProviderAttempt = vi.fn();
    const failedUsage = { inputTokens: 3, outputTokens: 1, totalTokens: 4, usageMissing: false };
    const successfulUsage = { inputTokens: 5, outputTokens: 2, totalTokens: 7, usageMissing: false };
    queueRunAgentResponses([
      {
        persona: 'coder',
        status: 'done',
        content: '   ',
        timestamp: new Date('2026-02-11T00:00:00Z'),
        sessionId: 'session-resume-2',
        providerUsage: failedUsage,
      },
      {
        persona: 'coder',
        status: 'done',
        content: '# Report\nRecovered output',
        timestamp: new Date('2026-02-11T00:00:01Z'),
        sessionId: 'session-fresh-1',
        providerUsage: successfulUsage,
      },
    ]);
    const runAgentMock = vi.mocked(runAgent);

    // When
    await runReportPhase(step, 1, ctx);

    // Then
    const reportPath = join(reportDir, '02-coder.md');
    expect(readFileSync(reportPath, 'utf-8')).toBe('# Report\nRecovered output');
    expect(runAgentMock).toHaveBeenCalledTimes(2);
    expect(ctx.onProviderAttempt).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ provider: 'opencode' }),
      false,
      failedUsage,
    );
    expect(ctx.onProviderAttempt).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ provider: 'opencode' }),
      true,
      successfulUsage,
    );

    const secondCallOptions = runAgentMock.mock.calls[1]?.[2] as { sessionId?: string };
    expect(secondCallOptions.sessionId).toBeUndefined();

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

    const firstCallOptions = runAgentMock.mock.calls[0]?.[2] as { sessionId?: string };
    expect(firstCallOptions.sessionId).toBeUndefined();
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

  it('should retry with new session when qwen3-coder-next emits a run tool call during report phase', async () => {
    // Given
    const reportDir = join(tmpRoot, '.takt', 'runs', 'sample-run', 'reports');
    const step = createStep('03-opencode.md');
    const onStream = vi.fn();
    const ctx = createContext(reportDir, 'Implemented feature X', 'session-resume-1');
    ctx.onStream = onStream;
    queueRunAgentAttempts([
      {
        streamEvents: [{
          type: 'tool_use',
          data: { tool: 'run', input: { command: 'echo report' }, id: 'tool-run-1' },
        }],
        response: {
          persona: 'coder',
          status: 'done',
          content: '# Report\nThis content must not be written',
          timestamp: new Date('2026-02-11T00:01:10Z'),
          sessionId: 'session-resume-2',
        },
      },
      {
        response: {
          persona: 'coder',
          status: 'done',
          content: '# Report\nRecovered without tools',
          timestamp: new Date('2026-02-11T00:01:11Z'),
          sessionId: 'session-fresh-1',
        },
      },
    ]);
    const runAgentMock = vi.mocked(runAgent);

    // When
    await runReportPhase(step, 1, ctx);

    // Then
    expect(readFileSync(join(reportDir, '03-opencode.md'), 'utf-8')).toBe('# Report\nRecovered without tools');
    expect(runAgentMock).toHaveBeenCalledTimes(2);
    expect(onStream).not.toHaveBeenCalled();

    const retryOptions = runAgentMock.mock.calls[1]?.[2] as { sessionId?: string };
    expect(retryOptions.sessionId).toBeUndefined();
  });

  it('should clear the old resume session when a new-session retry succeeds without returning a sessionId', async () => {
    // Given
    const reportDir = join(tmpRoot, '.takt', 'runs', 'sample-run', 'reports');
    const step: WorkflowStep = {
      ...createStep('03-retry-clear-first.md'),
      outputContracts: [{ name: '03-retry-clear-first.md' }, { name: '03-retry-clear-second.md' }],
    };
    const ctx = createContext(reportDir, 'Implemented feature X', 'session-resume-1');
    const sessionUpdates: Array<{ key: string; sessionId: string | undefined }> = [];
    const freshAttempts: string[] = [];
    let savedSessionId: string | undefined = 'session-resume-1';
    const originalBuildNewSessionReportOptions = ctx.buildNewSessionReportOptions;
    ctx.updatePersonaSession = (key, sessionId) => {
      sessionUpdates.push({ key, sessionId });
      savedSessionId = sessionId;
    };
    ctx.getSessionId = () => savedSessionId;
    ctx.buildNewSessionReportOptions = (currentStep, overrides) => {
      freshAttempts.push(currentStep.name);
      return originalBuildNewSessionReportOptions(currentStep, overrides);
    };
    queueRunAgentAttempts([
      {
        streamEvents: [{
          type: 'tool_use',
          data: { tool: 'run', input: {}, id: 'tool-run-1' },
        }],
        response: {
          persona: 'coder',
          status: 'done',
          content: '# Report\nFirst attempt with tool call',
          timestamp: new Date('2026-02-11T00:01:20Z'),
          sessionId: 'session-resume-2',
        },
      },
      {
        response: {
          persona: 'coder',
          status: 'done',
          content: '# Report\nRetry report without session id',
          timestamp: new Date('2026-02-11T00:01:21Z'),
        },
      },
      {
        response: {
          persona: 'coder',
          status: 'done',
          content: '# Report\nSecond report from fresh session',
          timestamp: new Date('2026-02-11T00:01:22Z'),
        },
      },
    ]);
    const runAgentMock = vi.mocked(runAgent);

    // When
    await runReportPhase(step, 1, ctx);

    // Then
    expect(sessionUpdates).toEqual([{ key: 'coder', sessionId: undefined }]);
    expect(freshAttempts).toEqual(['implement', 'implement']);
    expect(readFileSync(join(reportDir, '03-retry-clear-first.md'), 'utf-8')).toBe('# Report\nRetry report without session id');
    expect(readFileSync(join(reportDir, '03-retry-clear-second.md'), 'utf-8')).toBe('# Report\nSecond report from fresh session');

    const secondFileOptions = runAgentMock.mock.calls[2]?.[2] as { sessionId?: string };
    expect(secondFileOptions.sessionId).toBeUndefined();
  });

  it('should fall back to Claude when report phase retry also emits a tool call', async () => {
    // Given
    const reportDir = join(tmpRoot, '.takt', 'runs', 'sample-run', 'reports');
    const step = createStep('03-opencode-loop.md');
    const ctx = createContext(reportDir, 'Implemented feature X', 'session-resume-1');
    const sessionUpdates: Array<{ key: string; sessionId: string | undefined }> = [];
    ctx.updatePersonaSession = (key, sessionId) => {
      sessionUpdates.push({ key, sessionId });
    };
    queueRunAgentAttempts([
      {
        streamEvents: [{
          type: 'tool_use',
          data: { tool: 'run', input: {}, id: 'tool-run-1' },
        }],
        response: {
          persona: 'coder',
          status: 'done',
          content: '# Report\nFirst loop output',
          timestamp: new Date('2026-02-11T00:01:20Z'),
        },
      },
      {
        streamEvents: [{
          type: 'tool_use',
          data: { tool: 'run', input: {}, id: 'tool-run-2' },
        }],
        response: {
          persona: 'coder',
          status: 'done',
          content: '# Report\nRetry loop output',
          timestamp: new Date('2026-02-11T00:01:21Z'),
        },
      },
      {
        response: {
          persona: 'coder',
          status: 'done',
          content: '# Report\nRecovered by Claude fallback',
          timestamp: new Date('2026-02-11T00:01:22Z'),
          sessionId: 'claude-fallback-session',
        },
      },
    ]);
    const runAgentMock = vi.mocked(runAgent);

    // When
    const result = await runReportPhase(step, 1, ctx);

    // Then
    expect(result).toBeUndefined();
    expect(readFileSync(join(reportDir, '03-opencode-loop.md'), 'utf-8')).toBe('# Report\nRecovered by Claude fallback');
    expect(runAgentMock).toHaveBeenCalledTimes(3);
    expect(sessionUpdates).toEqual([]);

    const fallbackInstruction = runAgentMock.mock.calls[2]?.[1] as string;
    expect(fallbackInstruction).toContain('Implemented feature X');

    const fallbackOptions = runAgentMock.mock.calls[2]?.[2] as {
      allowedTools?: string[];
      maxTurns?: number;
      permissionMode?: string;
      resolvedProvider?: string;
      resolvedModel?: string;
      sessionId?: string;
    };
    expect(fallbackOptions).toMatchObject({
      allowedTools: [],
      maxTurns: 3,
      permissionMode: 'readonly',
      resolvedProvider: 'claude',
      sessionId: undefined,
    });
    expect(fallbackOptions.resolvedModel).toBeUndefined();
  });

  it('should resume the next report file with the primary session after a fallback report succeeds', async () => {
    // Given
    const reportDir = join(tmpRoot, '.takt', 'runs', 'sample-run', 'reports');
    const step: WorkflowStep = {
      ...createStep('03-first.md'),
      outputContracts: [{ name: '03-first.md' }, { name: '03-second.md' }],
    };
    const ctx = createContext(reportDir, 'Implemented feature X', 'session-resume-1');
    const sessionUpdates: Array<{ key: string; sessionId: string | undefined }> = [];
    ctx.updatePersonaSession = (key, sessionId) => {
      sessionUpdates.push({ key, sessionId });
    };
    queueRunAgentAttempts([
      {
        streamEvents: [{
          type: 'tool_use',
          data: { tool: 'run', input: {}, id: 'tool-run-1' },
        }],
        response: {
          persona: 'coder',
          status: 'done',
          content: '# Report\nFirst attempt must not be written',
          timestamp: new Date('2026-02-11T00:01:22Z'),
        },
      },
      {
        streamEvents: [{
          type: 'tool_use',
          data: { tool: 'run', input: {}, id: 'tool-run-2' },
        }],
        response: {
          persona: 'coder',
          status: 'done',
          content: '# Report\nRetry attempt must not be written',
          timestamp: new Date('2026-02-11T00:01:23Z'),
        },
      },
      {
        response: {
          persona: 'coder',
          status: 'done',
          content: '# Report\nRecovered by Claude fallback',
          timestamp: new Date('2026-02-11T00:01:24Z'),
          sessionId: 'claude-fallback-session',
        },
      },
      {
        response: {
          persona: 'coder',
          status: 'done',
          content: '# Report\nSecond file from primary session',
          timestamp: new Date('2026-02-11T00:01:25Z'),
          sessionId: 'opencode-session-after-second-file',
        },
      },
    ]);
    const runAgentMock = vi.mocked(runAgent);

    // When
    await runReportPhase(step, 1, ctx);

    // Then
    expect(readFileSync(join(reportDir, '03-first.md'), 'utf-8')).toBe('# Report\nRecovered by Claude fallback');
    expect(readFileSync(join(reportDir, '03-second.md'), 'utf-8')).toBe('# Report\nSecond file from primary session');
    expect(runAgentMock).toHaveBeenCalledTimes(4);
    expect(sessionUpdates).toEqual([
      { key: 'coder', sessionId: 'opencode-session-after-second-file' },
    ]);

    const fallbackOptions = runAgentMock.mock.calls[2]?.[2] as { resolvedProvider?: string; sessionId?: string };
    expect(fallbackOptions.resolvedProvider).toBe('claude');
    expect(fallbackOptions.sessionId).toBeUndefined();

    const secondFileOptions = runAgentMock.mock.calls[3]?.[2] as { resolvedProvider?: string; sessionId?: string };
    expect(secondFileOptions.resolvedProvider).toBe('opencode');
    expect(secondFileOptions.sessionId).toBe('session-resume-1');
  });

  it('should log only classified retry failure reasons when fallback succeeds', async () => {
    // Given
    const reportDir = join(tmpRoot, '.takt', 'runs', 'sample-run', 'reports');
    const step = createStep('03-redacted-fallback-log.md');
    const ctx = createContext(reportDir, 'Implemented feature X', 'session-resume-1');
    const phaseComplete = vi.fn();
    ctx.onPhaseComplete = phaseComplete;
    queueRunAgentResponses([
      {
        persona: 'coder',
        status: 'done',
        content: '   ',
        timestamp: new Date('2026-02-11T00:01:23Z'),
      },
      {
        persona: 'coder',
        status: 'error',
        content: 'SECRET_TOKEN=abc123 from retry content',
        timestamp: new Date('2026-02-11T00:01:24Z'),
        error: 'SECRET_TOKEN=abc123 from retry error',
      },
      {
        persona: 'coder',
        status: 'done',
        content: '# Report\nRecovered by fallback',
        timestamp: new Date('2026-02-11T00:01:25Z'),
      },
    ]);

    // When
    await runReportPhase(step, 1, ctx);

    // Then
    const infoPayload = JSON.stringify(infoSpy.mock.calls);
    expect(infoPayload).not.toContain('SECRET_TOKEN');
    const phaseCompletePayload = JSON.stringify(phaseComplete.mock.calls);
    expect(phaseCompletePayload).not.toContain('SECRET_TOKEN');
    expect(phaseComplete).toHaveBeenNthCalledWith(
      2,
      step,
      2,
      'report',
      '',
      'error',
      'Report phase provider returned status "error"',
      undefined,
      undefined,
    );
    expect(infoSpy).toHaveBeenCalledWith(
      'Report phase failed, retrying with new session',
      expect.objectContaining({ reason: 'empty_output' }),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      'Report phase failed, falling back to report provider',
      expect.objectContaining({ reason: 'provider_error' }),
    );
  });

  it('should throw the fallback error when Claude fallback also fails', async () => {
    // Given
    const reportDir = join(tmpRoot, '.takt', 'runs', 'sample-run', 'reports');
    const step = createStep('03-fallback-failed.md');
    const ctx = createContext(reportDir, 'Implemented feature X', 'session-resume-1');
    queueRunAgentResponses([
      {
        persona: 'coder',
        status: 'done',
        content: '   ',
        timestamp: new Date('2026-02-11T00:01:23Z'),
      },
      {
        persona: 'coder',
        status: 'error',
        content: 'Tool use is not allowed in this phase',
        timestamp: new Date('2026-02-11T00:01:24Z'),
        error: 'Tool use is not allowed in this phase',
      },
      {
        persona: 'coder',
        status: 'done',
        content: '\n\n',
        timestamp: new Date('2026-02-11T00:01:25Z'),
      },
    ]);
    const runAgentMock = vi.mocked(runAgent);

    // When / Then
    await expect(runReportPhase(step, 1, ctx)).rejects.toThrow(
      'Report phase failed for 03-fallback-failed.md: Report output is empty',
    );
    expect(runAgentMock).toHaveBeenCalledTimes(3);
    expect(existsSync(join(reportDir, '03-fallback-failed.md'))).toBe(false);
  });

  it('should return blocked when Claude fallback is blocked', async () => {
    // Given
    const reportDir = join(tmpRoot, '.takt', 'runs', 'sample-run', 'reports');
    const step = createStep('03-fallback-blocked.md');
    const ctx = createContext(reportDir, 'Implemented feature X', 'session-resume-1');
    const sessionUpdates: Array<{ key: string; sessionId: string | undefined }> = [];
    ctx.updatePersonaSession = (key, sessionId) => {
      sessionUpdates.push({ key, sessionId });
    };
    const blockedResponse: AgentResponse = {
      persona: 'coder',
      status: 'blocked',
      content: 'Need permission',
      timestamp: new Date('2026-02-11T00:01:26Z'),
    };
    queueRunAgentResponses([
      {
        persona: 'coder',
        status: 'done',
        content: '   ',
        timestamp: new Date('2026-02-11T00:01:23Z'),
      },
      {
        persona: 'coder',
        status: 'error',
        content: 'Tool use is not allowed in this phase',
        timestamp: new Date('2026-02-11T00:01:24Z'),
        error: 'Tool use is not allowed in this phase',
      },
      blockedResponse,
    ]);
    const runAgentMock = vi.mocked(runAgent);

    // When
    const result = await runReportPhase(step, 1, ctx);

    // Then
    expect(result).toEqual({ blocked: true, response: blockedResponse });
    expect(runAgentMock).toHaveBeenCalledTimes(3);
    expect(existsSync(join(reportDir, '03-fallback-blocked.md'))).toBe(false);
    expect(sessionUpdates).toEqual([]);
    expect(runAgentMock.mock.calls[2]?.[2]).toEqual(expect.objectContaining({
      resolvedProvider: 'claude',
      permissionMode: 'readonly',
      allowedTools: [],
      sessionId: undefined,
    }));
  });

  it('should return rate_limited when Claude fallback is rate limited', async () => {
    // Given
    const reportDir = join(tmpRoot, '.takt', 'runs', 'sample-run', 'reports');
    const step = createStep('03-fallback-rate-limited.md');
    const ctx = createContext(reportDir, 'Implemented feature X', 'session-resume-1');
    const sessionUpdates: Array<{ key: string; sessionId: string | undefined }> = [];
    ctx.updatePersonaSession = (key, sessionId) => {
      sessionUpdates.push({ key, sessionId });
    };
    const rateLimitedResponse: AgentResponse = {
      persona: 'coder',
      status: 'rate_limited',
      content: '',
      timestamp: new Date('2026-02-11T00:01:29Z'),
      error: RATE_LIMIT_MESSAGE,
      errorKind: 'rate_limit',
    };
    queueRunAgentResponses([
      {
        persona: 'coder',
        status: 'done',
        content: '   ',
        timestamp: new Date('2026-02-11T00:01:27Z'),
      },
      {
        persona: 'coder',
        status: 'error',
        content: 'Tool use is not allowed in this phase',
        timestamp: new Date('2026-02-11T00:01:28Z'),
        error: 'Tool use is not allowed in this phase',
      },
      rateLimitedResponse,
    ]);
    const runAgentMock = vi.mocked(runAgent);

    // When
    const result = await runReportPhase(step, 1, ctx);

    // Then
    expect(result).toEqual({ rateLimited: true, response: rateLimitedResponse });
    expect(runAgentMock).toHaveBeenCalledTimes(3);
    expect(existsSync(join(reportDir, '03-fallback-rate-limited.md'))).toBe(false);
    expect(sessionUpdates).toEqual([]);
    expect(runAgentMock.mock.calls[2]?.[2]).toEqual(expect.objectContaining({
      resolvedProvider: 'claude',
      permissionMode: 'readonly',
      allowedTools: [],
      sessionId: undefined,
    }));
  });

  it('should fail report phase attempt when provider emits an unavailable tool result', async () => {
    // Given
    const reportDir = join(tmpRoot, '.takt', 'runs', 'sample-run', 'reports');
    const step = createStep('03-unavailable-tool.md');
    const ctx = createContext(reportDir, 'Implemented feature X', undefined);
    const onStream = vi.fn();
    ctx.onStream = onStream;
    const rawToolResult = "Model tried to call unavailable tool 'invalid'. Available tools: glob, grep, read.";
    queueRunAgentAttempts([
      {
        streamEvents: [{
          type: 'tool_result',
          data: {
            content: rawToolResult,
            isError: true,
          },
        }],
        response: {
          persona: 'coder',
          status: 'done',
          content: '# Report\nShould not be written',
          timestamp: new Date('2026-02-11T00:01:30Z'),
        },
      },
      {
        streamEvents: [{
          type: 'tool_result',
          data: {
            content: rawToolResult,
            isError: true,
          },
        }],
        response: {
          persona: 'coder',
          status: 'done',
          content: '# Report\nFallback should not be written',
          timestamp: new Date('2026-02-11T00:01:31Z'),
        },
      },
    ]);
    const runAgentMock = vi.mocked(runAgent);

    // When
    let thrownError: unknown;
    try {
      await runReportPhase(step, 1, ctx);
    } catch (error) {
      thrownError = error;
    }

    // Then
    expect(thrownError).toBeInstanceOf(Error);
    const errorMessage = (thrownError as Error).message;
    expect(errorMessage).toBe('Report phase failed for 03-unavailable-tool.md: Report phase does not allow tool results.');
    expect(errorMessage).not.toContain(rawToolResult);
    expect(onStream).not.toHaveBeenCalled();
    expect(runAgentMock).toHaveBeenCalledTimes(2);
    expect(existsSync(join(reportDir, '03-unavailable-tool.md'))).toBe(false);
  });

  it('should not forward forbidden report phase tool results to run-agent stream callback', async () => {
    // Given
    const reportDir = join(tmpRoot, '.takt', 'runs', 'sample-run', 'reports');
    const step = createStep('03-stream-callback-tool-result.md');
    const ctx = createContext(reportDir, 'Implemented feature X', undefined);
    const runAgentStream = vi.fn();
    const originalBuildNewSessionReportOptions = ctx.buildNewSessionReportOptions;
    ctx.buildNewSessionReportOptions = (currentStep, overrides) => ({
      ...originalBuildNewSessionReportOptions(currentStep, overrides),
      onStream: runAgentStream,
    });
    const rawToolResult = 'SECRET_TOKEN=abc123 from forbidden tool result';
    queueRunAgentAttempts([
      {
        streamEvents: [{
          type: 'tool_result',
          data: {
            content: rawToolResult,
            isError: true,
          },
        }],
        response: {
          persona: 'coder',
          status: 'done',
          content: '# Report\nShould not be written',
          timestamp: new Date('2026-02-11T00:01:32Z'),
        },
      },
      {
        streamEvents: [{
          type: 'tool_result',
          data: {
            content: rawToolResult,
            isError: true,
          },
        }],
        response: {
          persona: 'coder',
          status: 'done',
          content: '# Report\nFallback should not be written',
          timestamp: new Date('2026-02-11T00:01:33Z'),
        },
      },
    ]);

    // When / Then
    await expect(runReportPhase(step, 1, ctx)).rejects.toThrow(
      'Report phase failed for 03-stream-callback-tool-result.md: Report phase does not allow tool results.',
    );
    expect(runAgentStream).not.toHaveBeenCalled();
    expect(existsSync(join(reportDir, '03-stream-callback-tool-result.md'))).toBe(false);
  });

  it('should keep raw response content out of phase complete when provider catches forbidden stream errors', async () => {
    // Given
    const reportDir = join(tmpRoot, '.takt', 'runs', 'sample-run', 'reports');
    const step = createStep('03-caught-tool-result.md');
    const ctx = createContext(reportDir, 'Implemented feature X', undefined);
    const onStream = vi.fn();
    const onPhaseComplete = vi.fn();
    const sanitizeObservabilityText = vi.fn((text: string) => text);
    ctx.onStream = onStream;
    ctx.onPhaseComplete = onPhaseComplete;
    ctx.observabilityEnabled = true;
    ctx.workflowName = 'test-workflow';
    ctx.iteration = 1;
    ctx.sanitizeObservabilityText = sanitizeObservabilityText;
    const rawToolResult = 'SECRET_TOKEN=abc123 from forbidden tool result';
    const rawResponseContent = '# Report\nSECRET_TOKEN=abc123 from caught provider response';
    const caughtErrors: string[] = [];
    vi.mocked(runAgent).mockImplementationOnce(async (persona, task, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: task,
      });
      for (const event of [
        {
          type: 'tool_result',
          data: {
            content: rawToolResult,
            isError: true,
          },
        },
        {
          type: 'text',
          data: {
            text: rawResponseContent,
          },
        },
      ] satisfies StreamEvent[]) {
        try {
          options?.onStream?.(event);
        } catch (error) {
          caughtErrors.push(error instanceof Error ? error.message : String(error));
        }
      }
      return {
        persona: 'coder',
        status: 'done',
        content: rawResponseContent,
        timestamp: new Date('2026-02-11T00:01:33Z'),
      };
    });
    vi.mocked(runAgent).mockImplementationOnce(async (persona, task, options) => {
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: task,
      });
      options?.onStream?.({
        type: 'tool_result',
        data: {
          content: rawToolResult,
          isError: true,
        },
      });
      return {
        persona: 'coder',
        status: 'done',
        content: rawResponseContent,
        timestamp: new Date('2026-02-11T00:01:34Z'),
      };
    });

    // When / Then
    await expect(runReportPhase(step, 1, ctx)).rejects.toThrow(
      'Report phase failed for 03-caught-tool-result.md: Report phase does not allow tool results.',
    );
    expect(caughtErrors).toEqual([
      'Report phase does not allow tool results.',
      'Report phase does not allow tool results.',
    ]);
    expect(onStream).not.toHaveBeenCalled();
    expect(onPhaseComplete).toHaveBeenCalledWith(
      step,
      2,
      'report',
      '',
      'error',
      'Report phase does not allow tool results.',
      'implement:1:2:1',
      1,
    );
    expect(onPhaseComplete).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.stringContaining('SECRET_TOKEN'),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(sanitizeObservabilityText).not.toHaveBeenCalledWith(rawToolResult);
    expect(sanitizeObservabilityText).not.toHaveBeenCalledWith(rawResponseContent);
    expect(existsSync(join(reportDir, '03-caught-tool-result.md'))).toBe(false);
  });

  it('should retry with new session when resumed report phase emits an invalid tool result', async () => {
    // Given
    const reportDir = join(tmpRoot, '.takt', 'runs', 'sample-run', 'reports');
    const step = createStep('03-invalid-tool-retry.md');
    const ctx = createContext(reportDir, 'Implemented feature X', 'session-resume-1');
    queueRunAgentAttempts([
      {
        streamEvents: [{
          type: 'tool_result',
          data: {
            content: "Model tried to call invalid tool 'run'. Available tools: glob, grep, read.",
            isError: true,
          },
        }],
        response: {
          persona: 'coder',
          status: 'done',
          content: '# Report\nThis content must not be written',
          timestamp: new Date('2026-02-11T00:01:35Z'),
          sessionId: 'session-resume-2',
        },
      },
      {
        response: {
          persona: 'coder',
          status: 'done',
          content: '# Report\nRecovered after invalid tool result',
          timestamp: new Date('2026-02-11T00:01:36Z'),
          sessionId: 'session-fresh-1',
        },
      },
    ]);
    const runAgentMock = vi.mocked(runAgent);

    // When
    await runReportPhase(step, 1, ctx);

    // Then
    expect(readFileSync(join(reportDir, '03-invalid-tool-retry.md'), 'utf-8')).toBe(
      '# Report\nRecovered after invalid tool result',
    );
    expect(runAgentMock).toHaveBeenCalledTimes(2);

    const firstAttemptOptions = runAgentMock.mock.calls[0]?.[2] as { sessionId?: string };
    expect(firstAttemptOptions.sessionId).toBe('session-resume-1');

    const retryOptions = runAgentMock.mock.calls[1]?.[2] as { sessionId?: string };
    expect(retryOptions.sessionId).toBeUndefined();
  });

  it('should retry with new session when resumed report phase emits an unavailable tool result', async () => {
    // Given
    const reportDir = join(tmpRoot, '.takt', 'runs', 'sample-run', 'reports');
    const step = createStep('03-unavailable-tool-retry.md');
    const ctx = createContext(reportDir, 'Implemented feature X', 'session-resume-1');
    queueRunAgentAttempts([
      {
        streamEvents: [{
          type: 'tool_result',
          data: {
            content: "Model tried to call unavailable tool 'invalid'. Available tools: glob, grep, read.",
            isError: true,
          },
        }],
        response: {
          persona: 'coder',
          status: 'done',
          content: '# Report\nThis content must not be written',
          timestamp: new Date('2026-02-11T00:01:40Z'),
          sessionId: 'session-resume-2',
        },
      },
      {
        response: {
          persona: 'coder',
          status: 'done',
          content: '# Report\nRecovered after unavailable tool result',
          timestamp: new Date('2026-02-11T00:01:41Z'),
          sessionId: 'session-fresh-1',
        },
      },
    ]);
    const runAgentMock = vi.mocked(runAgent);

    // When
    await runReportPhase(step, 1, ctx);

    // Then
    expect(readFileSync(join(reportDir, '03-unavailable-tool-retry.md'), 'utf-8')).toBe(
      '# Report\nRecovered after unavailable tool result',
    );
    expect(runAgentMock).toHaveBeenCalledTimes(2);

    const firstAttemptOptions = runAgentMock.mock.calls[0]?.[2] as { sessionId?: string };
    expect(firstAttemptOptions.sessionId).toBe('session-resume-1');

    const retryOptions = runAgentMock.mock.calls[1]?.[2] as { sessionId?: string };
    expect(retryOptions.sessionId).toBeUndefined();
  });

  it('should fall back to Claude when both primary report attempts return empty output', async () => {
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
      {
        persona: 'coder',
        status: 'done',
        content: 'Recovered report from fallback',
        timestamp: new Date('2026-02-11T00:02:02Z'),
      },
    ]);
    const runAgentMock = vi.mocked(runAgent);

    // When
    const result = await runReportPhase(step, 1, ctx);

    // Then
    expect(result).toBeUndefined();
    expect(readFileSync(join(reportDir, '04-qa.md'), 'utf-8')).toBe('Recovered report from fallback');
    expect(runAgentMock).toHaveBeenCalledTimes(3);
    const fallbackOptions = runAgentMock.mock.calls[2]?.[2];
    expect(fallbackOptions).toEqual(expect.objectContaining({
      resolvedProvider: 'claude',
      allowedTools: [],
      sessionId: undefined,
    }));
  });

  it('should not fall back when the retry provider is not OpenCode', async () => {
    // Given
    const reportDir = join(tmpRoot, '.takt', 'runs', 'sample-run', 'reports');
    const step = createStep('04-non-opencode.md');
    const ctx = createContext(reportDir, 'Sensitive Phase 1 output', 'session-resume-1', {
      primaryProvider: 'codex',
      fallbackProvider: 'claude',
    });
    queueRunAgentResponses([
      {
        persona: 'coder',
        status: 'done',
        content: ' ',
        timestamp: new Date('2026-02-11T00:02:03Z'),
      },
      {
        persona: 'coder',
        status: 'done',
        content: '\n\n',
        timestamp: new Date('2026-02-11T00:02:04Z'),
      },
    ]);
    const runAgentMock = vi.mocked(runAgent);

    // When / Then
    await expect(runReportPhase(step, 1, ctx)).rejects.toThrow(
      'Report phase failed for 04-non-opencode.md: Report output is empty',
    );
    expect(runAgentMock).toHaveBeenCalledTimes(2);
    expect(existsSync(join(reportDir, '04-non-opencode.md'))).toBe(false);
  });

  it('should not fall back when the fallback provider matches OpenCode primary provider', async () => {
    // Given
    const reportDir = join(tmpRoot, '.takt', 'runs', 'sample-run', 'reports');
    const step = createStep('04-same-provider.md');
    const ctx = createContext(reportDir, 'Implemented feature X', 'session-resume-1', {
      primaryProvider: 'opencode',
      fallbackProvider: 'opencode',
    });
    queueRunAgentResponses([
      {
        persona: 'coder',
        status: 'done',
        content: ' ',
        timestamp: new Date('2026-02-11T00:02:05Z'),
      },
      {
        persona: 'coder',
        status: 'done',
        content: '\n\n',
        timestamp: new Date('2026-02-11T00:02:06Z'),
      },
    ]);
    const runAgentMock = vi.mocked(runAgent);

    // When / Then
    await expect(runReportPhase(step, 1, ctx)).rejects.toThrow(
      'Report phase failed for 04-same-provider.md: Report output is empty',
    );
    expect(runAgentMock).toHaveBeenCalledTimes(2);
    expect(existsSync(join(reportDir, '04-same-provider.md'))).toBe(false);
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

  it('should return rate_limited without retry when resumed session hits the rate limit', async () => {
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

    // When
    const result = await runReportPhase(step, 1, ctx);

    // Then
    expect(result).toMatchObject({
      rateLimited: true,
      response: {
        status: 'rate_limited',
        content: '',
        error: RATE_LIMIT_MESSAGE,
        errorKind: 'rate_limit',
      },
    });
    expect(runAgentMock).toHaveBeenCalledTimes(1);

    const firstCallOptions = runAgentMock.mock.calls[0]?.[2] as { sessionId?: string };
    expect(firstCallOptions.sessionId).toBe('session-resume-1');
  });

  it('should preserve provider-specific error text when rate limit is classified', async () => {
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

    // When
    const result = await runReportPhase(step, 1, ctx);

    // Then
    expect(result).toMatchObject({
      rateLimited: true,
      response: {
        status: 'rate_limited',
        content: '',
        error: 'Claude Code process exited with code 1',
        errorKind: 'rate_limit',
      },
    });
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

  it('should fall back to Claude when no-session first attempt returns empty output', async () => {
    // Given
    const reportDir = join(tmpRoot, '.takt', 'runs', 'sample-run', 'reports');
    const step = createStep('04-qa.md');
    const ctx = createContext(reportDir, 'Aggregated team leader output', undefined);
    queueRunAgentResponses([{
      persona: 'coder',
      status: 'done',
      content: '   ',
      timestamp: new Date('2026-02-11T00:02:45Z'),
    }, {
      persona: 'coder',
      status: 'done',
      content: 'Recovered report without resumed session',
      timestamp: new Date('2026-02-11T00:02:46Z'),
    }]);
    const runAgentMock = vi.mocked(runAgent);

    // When
    await runReportPhase(step, 1, ctx);

    // Then
    expect(runAgentMock).toHaveBeenCalledTimes(2);
    expect(readFileSync(join(reportDir, '04-qa.md'), 'utf-8')).toBe('Recovered report without resumed session');
    const fallbackOptions = runAgentMock.mock.calls[1]?.[2];
    expect(fallbackOptions).toEqual(expect.objectContaining({
      resolvedProvider: 'claude',
      permissionMode: 'readonly',
      allowedTools: [],
      sessionId: undefined,
    }));
  });

  it('should throw fallback error when no-session first attempt and fallback both fail', async () => {
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
    }, {
      persona: 'coder',
      status: 'done',
      content: ' ',
      timestamp: new Date('2026-02-11T00:02:51Z'),
    }]);
    const runAgentMock = vi.mocked(runAgent);

    // When / Then
    await expect(runReportPhase(step, 1, ctx)).rejects.toThrow(
      'Report phase failed for 04-qa.md: Report output is empty',
    );
    expect(runAgentMock).toHaveBeenCalledTimes(2);
    expect(existsSync(join(reportDir, '04-qa.md'))).toBe(false);
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

  it('should return rate_limited result without retry', async () => {
    // Given
    const reportDir = join(tmpRoot, '.takt', 'runs', 'sample-run', 'reports');
    const step = createStep('07-rate-limited.md');
    const ctx = createContext(reportDir);
    const response: AgentResponse = {
      persona: 'coder',
      status: 'rate_limited',
      content: '',
      timestamp: new Date('2026-02-11T00:05:00Z'),
      error: RATE_LIMIT_MESSAGE,
      errorKind: 'rate_limit',
      rateLimitInfo: {
        provider: 'claude',
        detectedAt: new Date('2026-02-11T00:05:00Z'),
        source: 'sdk_error',
      },
    };
    queueRunAgentResponses([response]);
    const runAgentMock = vi.mocked(runAgent);

    // When
    const result = await runReportPhase(step, 1, ctx);

    // Then
    expect(result).toEqual({
      rateLimited: true,
      response,
    });
    expect(runAgentMock).toHaveBeenCalledTimes(1);
  });

  it('should use the runtime-aware session key supplied by the engine context', async () => {
    // Given
    const reportDir = join(tmpRoot, '.takt', 'runs', 'sample-run', 'reports');
    const step = createStep('08-provider-aware.md');
    const sessions = new Map<string, string>([
      ['coder', 'claude-session'],
      ['coder:codex', 'codex-session'],
    ]);
    const updates: Array<{ key: string; sessionId: string | undefined }> = [];
    const resumedSessionIds: string[] = [];
    const ctx: ReportPhaseRunnerContext = {
      cwd: reportDir,
      reportDir,
      language: 'en',
      lastResponse: 'Fallback Phase 1 result',
      resolveSessionKey: () => 'coder:codex',
      getSessionId: (key) => sessions.get(key),
      buildResumeOptions: (_step, sessionId, overrides) => {
        resumedSessionIds.push(sessionId);
        return {
          cwd: reportDir,
          sessionId,
          allowedTools: [],
          maxTurns: overrides.maxTurns,
        };
      },
      buildNewSessionReportOptions: (_step, overrides) => ({
        cwd: reportDir,
        allowedTools: overrides.allowedTools,
        maxTurns: overrides.maxTurns,
      }),
      buildFallbackReportOptions: (_step, _failedPrimaryOptions, overrides) => ({
        cwd: reportDir,
        permissionMode: 'readonly',
        resolvedProvider: 'claude',
        sessionId: undefined,
        allowedTools: overrides.allowedTools,
        maxTurns: overrides.maxTurns,
      }),
      updatePersonaSession: (key, sessionId) => {
        updates.push({ key, sessionId });
        if (sessionId) {
          sessions.set(key, sessionId);
        }
      },
      resolveReportFallbackProviderModel: () => ({
        provider: 'claude',
      }),
      resolveStepProviderModel: (_step) => ({
        provider: 'opencode',
      }),
    };
    queueRunAgentResponses([{
      persona: 'coder',
      status: 'done',
      content: 'fallback provider report',
      timestamp: new Date('2026-02-11T00:05:30Z'),
      sessionId: 'codex-report-session',
    }]);

    // When
    await runReportPhase(step, 1, ctx);

    // Then
    expect(resumedSessionIds).toEqual(['codex-session']);
    expect(updates).toEqual([{ key: 'coder:codex', sessionId: 'codex-report-session' }]);
    expect(sessions.get('coder')).toBe('claude-session');
    expect(readFileSync(join(reportDir, '08-provider-aware.md'), 'utf-8')).toBe('fallback provider report');
  });
});
