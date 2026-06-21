import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGENT_FAILURE_CATEGORIES } from '../shared/types/agent-failure.js';
import type { AgentResponse, WorkflowStep } from '../core/models/types.js';
import { collectMetricPoints, metricPoint } from './observability-metrics-test-helpers.js';

describe('workflow span provider error metrics', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('Given a rate limited step response, When the step span completes, Then records a rate limit provider error counter', async () => {
    const points = await collectMetricPoints(async () => {
      const { runWithStepSpan } = await import('../core/workflow/observability/workflowSpans.js');

      await runWithStepSpan({
        enabled: true,
        runId: 'run-1',
        workflowName: 'default',
        step: makeStep('implement'),
        iteration: 1,
        providerInfo: {
          provider: 'codex',
          model: 'gpt-5',
        },
      }, async () => ({
        response: makeResponse({
          status: 'rate_limited',
          errorKind: 'rate_limit',
          error: 'Rate limit exceeded',
        }),
        instruction: 'Implement',
        providerInfo: {
          provider: 'codex',
          model: 'gpt-5',
        },
      }));
    });

    expect(metricPoint(points, 'takt.provider.errors', {
      'takt.run.id': 'run-1',
      'takt.provider.name': 'codex',
      'takt.model.name': 'gpt-5',
      'takt.provider.error_type': 'rate_limit',
    })?.value).toBe(1);
  });

  it('Given a successful response with retryCount, When the step span completes, Then records retry attempts as provider errors', async () => {
    const points = await collectMetricPoints(async () => {
      const { runWithStepSpan } = await import('../core/workflow/observability/workflowSpans.js');

      await runWithStepSpan({
        enabled: true,
        runId: 'run-1',
        workflowName: 'default',
        step: makeStep('implement'),
        iteration: 1,
        providerInfo: {
          provider: 'opencode',
          model: 'opencode/big-pickle',
        },
      }, async () => ({
        response: makeResponse({
          status: 'done',
          retryCount: 2,
        }),
        instruction: 'Implement',
        providerInfo: {
          provider: 'opencode',
          model: 'opencode/big-pickle',
        },
      }));
    });

    expect(metricPoint(points, 'takt.provider.errors', {
      'takt.run.id': 'run-1',
      'takt.provider.name': 'opencode',
      'takt.model.name': 'opencode/big-pickle',
      'takt.provider.error_type': 'retry',
    })?.value).toBe(2);
  });

  it('Given a provider timeout failure, When the step span completes, Then records the timeout classification', async () => {
    const points = await collectMetricPoints(async () => {
      const { runWithStepSpan } = await import('../core/workflow/observability/workflowSpans.js');

      await runWithStepSpan({
        enabled: true,
        runId: 'run-1',
        workflowName: 'default',
        step: makeStep('implement'),
        iteration: 1,
        providerInfo: {
          provider: 'codex',
          model: 'gpt-5',
        },
      }, async () => ({
        response: makeResponse({
          status: 'error',
          failureCategory: AGENT_FAILURE_CATEGORIES.STREAM_IDLE_TIMEOUT,
          error: 'stream timed out',
        }),
        instruction: 'Implement',
        providerInfo: {
          provider: 'codex',
          model: 'gpt-5',
        },
      }));
    });

    expect(metricPoint(points, 'takt.provider.errors', {
      'takt.run.id': 'run-1',
      'takt.provider.name': 'codex',
      'takt.model.name': 'gpt-5',
      'takt.provider.error_type': 'stream_idle_timeout',
    })?.value).toBe(1);
  });

  it('Given a rate limited step response without a resolved model, When the step span completes, Then records provider error and retry counters', async () => {
    const points = await collectMetricPoints(async () => {
      const { runWithStepSpan } = await import('../core/workflow/observability/workflowSpans.js');

      await runWithStepSpan({
        enabled: true,
        runId: 'run-1',
        workflowName: 'default',
        step: makeStep('implement'),
        iteration: 1,
        providerInfo: {
          provider: 'codex',
        },
      }, async () => ({
        response: makeResponse({
          status: 'rate_limited',
          errorKind: 'rate_limit',
          retryCount: 2,
          error: 'Rate limit exceeded',
        }),
        instruction: 'Implement',
        providerInfo: {
          provider: 'codex',
        },
      }));
    });

    expect(metricPoint(points, 'takt.provider.errors', {
      'takt.run.id': 'run-1',
      'takt.provider.name': 'codex',
      'takt.model.name': '(default)',
      'takt.provider.error_type': 'rate_limit',
    })?.value).toBe(1);
    expect(metricPoint(points, 'takt.provider.errors', {
      'takt.run.id': 'run-1',
      'takt.provider.name': 'codex',
      'takt.model.name': '(default)',
      'takt.provider.error_type': 'retry',
    })?.value).toBe(2);
  });

  it('Given an error step response without a failure category, When the step span completes, Then records a provider error counter', async () => {
    const points = await collectMetricPoints(async () => {
      const { runWithStepSpan } = await import('../core/workflow/observability/workflowSpans.js');

      await runWithStepSpan({
        enabled: true,
        runId: 'run-1',
        workflowName: 'default',
        step: makeStep('implement'),
        iteration: 1,
        providerInfo: {
          provider: 'codex',
          model: 'gpt-5',
        },
      }, async () => ({
        response: makeResponse({
          status: 'error',
          error: 'provider returned an error',
        }),
        instruction: 'Implement',
        providerInfo: {
          provider: 'codex',
          model: 'gpt-5',
        },
      }));
    });

    expect(metricPoint(points, 'takt.provider.errors', {
      'takt.run.id': 'run-1',
      'takt.provider.name': 'codex',
      'takt.model.name': 'gpt-5',
      'takt.provider.error_type': AGENT_FAILURE_CATEGORIES.PROVIDER_ERROR,
    })?.value).toBe(1);
  });

  it('Given a provider callback throws a non-provider error, When the step span closes, Then records no provider error counter', async () => {
    const points = await collectMetricPoints(async () => {
      const { runWithStepSpan } = await import('../core/workflow/observability/workflowSpans.js');

      await expect(runWithStepSpan({
        enabled: true,
        runId: 'run-1',
        workflowName: 'default',
        step: makeStep('implement'),
        iteration: 1,
        providerInfo: {
          provider: 'codex',
          model: 'gpt-5',
        },
      }, async () => {
        throw new Error('quality gate failed');
      })).rejects.toThrow('quality gate failed');
    });

    expect(points.filter((point) => point.name === 'takt.provider.errors')).toEqual([]);
  });
});

function makeStep(name: string): WorkflowStep {
  return {
    name,
    persona: '../agents/coder.md',
    instruction: 'Implement',
  };
}

function makeResponse(overrides: Partial<AgentResponse> & { retryCount?: number }): AgentResponse {
  return {
    persona: 'coder',
    status: 'done',
    content: 'ok',
    timestamp: new Date('2026-06-20T00:00:00.000Z'),
    ...overrides,
  } as AgentResponse;
}
