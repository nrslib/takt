import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runReportPhase, type ReportPhaseRunnerContext } from '../core/workflow/phase-runner.js';
import type { AgentResponse, WorkflowStep } from '../core/models/types.js';

type CapturedProviderInfo = {
  provider?: string;
  model?: string;
  providerSource?: string;
  modelSource?: string;
};

const { capturedProviderInfo, capturedOutcomes } = vi.hoisted(() => ({
  capturedProviderInfo: [] as CapturedProviderInfo[],
  capturedOutcomes: [] as unknown[],
}));

vi.mock('../core/workflow/observability/workflowSpans.js', () => ({
  runWithPhaseSpan: vi.fn(async (
    params: { providerInfo?: CapturedProviderInfo },
    execute: () => Promise<AgentResponse>,
    getOutcome: (response: AgentResponse) => unknown,
  ) => {
    capturedProviderInfo.push(params.providerInfo ?? {});
    const response = await execute();
    capturedOutcomes.push(getOutcome(response));
    return response;
  }),
}));

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

import { runAgent } from '../agents/runner.js';

function createStep(fileName: string): WorkflowStep {
  return {
    name: 'review',
    persona: 'reviewer',
    personaDisplayName: 'Reviewer',
    instruction: 'Review task',
    passPreviousResponse: false,
    outputContracts: [{ name: fileName }],
  };
}

function createContext(reportDir: string): ReportPhaseRunnerContext {
  return {
    cwd: reportDir,
    reportDir,
    workflowName: 'test-workflow',
    observabilityEnabled: true,
    lastResponse: 'Phase 1 output',
    resolveSessionKey: (step) => step.persona ?? step.name,
    getSessionId: () => 'session-resume-1',
    buildResumeOptions: (_step, sessionId, overrides) => ({
      cwd: reportDir,
      resolvedProvider: 'opencode',
      resolvedModel: 'qwen3-coder-next',
      sessionId,
      maxTurns: overrides.maxTurns,
    }),
    buildNewSessionReportOptions: (_step, overrides) => ({
      cwd: reportDir,
      resolvedProvider: 'opencode',
      resolvedModel: 'qwen3-coder-next',
      allowedTools: overrides.allowedTools,
      maxTurns: overrides.maxTurns,
    }),
    buildFallbackReportOptions: (_step, _failedPrimaryOptions, overrides) => ({
      cwd: reportDir,
      resolvedProvider: 'codex',
      resolvedModel: 'gpt-5.1-mini',
      allowedTools: overrides.allowedTools,
      maxTurns: overrides.maxTurns,
    }),
    resolveReportFallbackProviderModel: () => ({
      provider: 'codex',
      model: 'gpt-5.1-mini',
    }),
    updatePersonaSession: () => {},
    resolveStepProviderModel: () => ({
      provider: 'opencode',
      model: 'qwen3-coder-next',
      providerSource: 'step',
      modelSource: 'step',
    }),
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

describe('runReportPhase provider info', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'takt-report-provider-info-'));
    capturedProviderInfo.length = 0;
    capturedOutcomes.length = 0;
    vi.resetAllMocks();
  });

  afterEach(() => {
    if (existsSync(tmpRoot)) {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('preserves provider and model source attributes for normal report attempts', async () => {
    const reportDir = join(tmpRoot, '.takt', 'runs', 'sample-run', 'reports');
    const step = createStep('review.md');
    const ctx = createContext(reportDir);
    queueRunAgentResponses([{
      persona: 'reviewer',
      status: 'done',
      content: '# Report\nOK',
      timestamp: new Date('2026-06-28T00:00:00Z'),
      sessionId: 'session-resume-2',
    }]);

    await runReportPhase(step, 1, ctx);

    expect(readFileSync(join(reportDir, 'review.md'), 'utf-8')).toBe('# Report\nOK');
    expect(capturedProviderInfo[0]).toEqual({
      provider: 'opencode',
      model: 'qwen3-coder-next',
      providerSource: 'step',
      modelSource: 'step',
    });
  });

  it('records the configured fallback provider for fallback attempts', async () => {
    const reportDir = join(tmpRoot, '.takt', 'runs', 'sample-run', 'reports');
    const step = createStep('fallback.md');
    const ctx = createContext(reportDir);
    queueRunAgentResponses([
      {
        persona: 'reviewer',
        status: 'done',
        content: ' ',
        timestamp: new Date('2026-06-28T00:00:00Z'),
      },
      {
        persona: 'reviewer',
        status: 'done',
        content: '\n',
        timestamp: new Date('2026-06-28T00:00:01Z'),
      },
      {
        persona: 'reviewer',
        status: 'done',
        content: '# Report\nFallback OK',
        timestamp: new Date('2026-06-28T00:00:02Z'),
      },
    ]);

    await runReportPhase(step, 1, ctx);

    expect(readFileSync(join(reportDir, 'fallback.md'), 'utf-8')).toBe('# Report\nFallback OK');
    expect(capturedProviderInfo[2]).toEqual({
      provider: 'codex',
      model: 'gpt-5.1-mini',
    });
  });

  it('records empty report output as an error outcome before fallback succeeds', async () => {
    const reportDir = join(tmpRoot, '.takt', 'runs', 'sample-run', 'reports');
    const step = createStep('fallback-empty-outcome.md');
    const ctx = createContext(reportDir);
    queueRunAgentResponses([
      {
        persona: 'reviewer',
        status: 'done',
        content: '',
        timestamp: new Date('2026-06-28T00:00:00Z'),
      },
      {
        persona: 'reviewer',
        status: 'done',
        content: '# Report\nFallback OK',
        timestamp: new Date('2026-06-28T00:00:01Z'),
      },
    ]);

    await runReportPhase(step, 1, ctx);

    expect(readFileSync(join(reportDir, 'fallback-empty-outcome.md'), 'utf-8')).toBe('# Report\nFallback OK');
    expect(capturedOutcomes[0]).toMatchObject({
      status: 'error',
      content: '',
      error: 'Report output is empty',
    });
  });

  it('does not attach raw retry failure content to observability outcomes before fallback succeeds', async () => {
    const reportDir = join(tmpRoot, '.takt', 'runs', 'sample-run', 'reports');
    const step = createStep('fallback-redacted.md');
    const ctx = createContext(reportDir);
    queueRunAgentResponses([
      {
        persona: 'reviewer',
        status: 'done',
        content: ' ',
        timestamp: new Date('2026-06-28T00:00:00Z'),
      },
      {
        persona: 'reviewer',
        status: 'error',
        content: 'SECRET_TOKEN=retry-content',
        error: 'SECRET_TOKEN=retry-error',
        timestamp: new Date('2026-06-28T00:00:01Z'),
      },
      {
        persona: 'reviewer',
        status: 'done',
        content: '# Report\nFallback OK',
        timestamp: new Date('2026-06-28T00:00:02Z'),
      },
    ]);

    await runReportPhase(step, 1, ctx);

    expect(readFileSync(join(reportDir, 'fallback-redacted.md'), 'utf-8')).toBe('# Report\nFallback OK');
    expect(JSON.stringify(capturedOutcomes)).not.toContain('SECRET_TOKEN');
    expect(capturedOutcomes[1]).toMatchObject({
      status: 'error',
      content: '',
      error: 'Report phase provider returned status "error"',
    });
  });

  it('keeps normal report source attributes when the step provider matches the configured fallback provider', async () => {
    const reportDir = join(tmpRoot, '.takt', 'runs', 'sample-run', 'reports');
    const step = createStep('same-provider.md');
    const ctx = createContext(reportDir);
    ctx.buildResumeOptions = (_step, sessionId, overrides) => ({
      cwd: reportDir,
      resolvedProvider: 'claude',
      resolvedModel: 'claude-opus-4',
      sessionId,
      maxTurns: overrides.maxTurns,
    });
    ctx.resolveStepProviderModel = () => ({
      provider: 'claude',
      model: 'claude-opus-4',
      providerSource: 'step',
      modelSource: 'step',
    });
    queueRunAgentResponses([{
      persona: 'reviewer',
      status: 'done',
      content: '# Report\nSame provider OK',
      timestamp: new Date('2026-06-28T00:00:00Z'),
    }]);

    await runReportPhase(step, 1, ctx);

    expect(readFileSync(join(reportDir, 'same-provider.md'), 'utf-8')).toBe('# Report\nSame provider OK');
    expect(capturedProviderInfo[0]).toEqual({
      provider: 'claude',
      model: 'claude-opus-4',
      providerSource: 'step',
      modelSource: 'step',
    });
  });
});
