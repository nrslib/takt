import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectMetricPoints, metricPoint } from './observability-metrics-test-helpers.js';

describe('workflow metrics helpers', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('Given a phase span with token usage, When recording token metrics, Then emits token and estimated cost counters with run labels', async () => {
    const estimateTokenCostUsd = vi.fn(() => 0.00042);

    const points = await collectMetricPoints(async () => {
      const { recordTokenUsageMetricsFromSpan } = await import('../core/workflow/observability/workflowMetrics.js');

      recordTokenUsageMetricsFromSpan({
        name: 'phase.implement.execute',
        attributes: {
          'takt.run.id': 'run-1',
          'takt.provider.name': 'codex',
          'takt.model.name': 'gpt-5',
          'takt.step.name': 'implement',
          'gen_ai.usage.input_tokens': 11,
          'gen_ai.usage.output_tokens': 7,
          'gen_ai.usage.total_tokens': 18,
          'gen_ai.usage.cached_input_tokens': 3,
          'gen_ai.usage.cache_creation_input_tokens': 2,
          'gen_ai.usage.cache_read_input_tokens': 1,
        },
      }, estimateTokenCostUsd);
    });

    const requiredAttributes = {
      'takt.run.id': 'run-1',
      'takt.provider.name': 'codex',
      'takt.model.name': 'gpt-5',
      'takt.step.name': 'implement',
    };
    expect(metricPoint(points, 'takt.token.input_tokens', requiredAttributes)?.value).toBe(11);
    expect(metricPoint(points, 'takt.token.output_tokens', requiredAttributes)?.value).toBe(7);
    expect(metricPoint(points, 'takt.token.cached_input_tokens', requiredAttributes)?.value).toBe(3);
    expect(metricPoint(points, 'takt.token.estimated_cost_usd', requiredAttributes)?.value).toBe(0.00042);
    expect(estimateTokenCostUsd).toHaveBeenCalledWith('codex', 'gpt-5', expect.objectContaining({
      totalTokens: 18,
      cachedInputTokens: 3,
      cacheCreationInputTokens: 2,
      cacheReadInputTokens: 1,
    }));
  });

  it('Given usage without total tokens, When recording token metrics, Then derives total tokens for cost estimation', async () => {
    const estimateTokenCostUsd = vi.fn(() => 0.00021);

    const points = await collectMetricPoints(async () => {
      const { recordTokenUsageMetricsFromSpan } = await import('../core/workflow/observability/workflowMetrics.js');

      recordTokenUsageMetricsFromSpan({
        name: 'phase.implement.execute',
        attributes: {
          'takt.run.id': 'run-1',
          'takt.provider.name': 'codex',
          'takt.model.name': 'gpt-5',
          'takt.step.name': 'implement',
          'gen_ai.usage.input_tokens': 11,
          'gen_ai.usage.output_tokens': 7,
        },
      }, estimateTokenCostUsd);
    });

    const attributes = {
      'takt.run.id': 'run-1',
      'takt.provider.name': 'codex',
      'takt.model.name': 'gpt-5',
      'takt.step.name': 'implement',
    };
    expect(metricPoint(points, 'takt.token.input_tokens', attributes)?.value).toBe(11);
    expect(metricPoint(points, 'takt.token.output_tokens', attributes)?.value).toBe(7);
    expect(estimateTokenCostUsd).toHaveBeenCalledWith('codex', 'gpt-5', expect.objectContaining({
      totalTokens: 18,
    }));
  });

  it('Given usage without model, When recording token metrics, Then emits token counters with the default model label and without cost estimation', async () => {
    const estimateTokenCostUsd = vi.fn(() => 0.00021);

    const points = await collectMetricPoints(async () => {
      const { recordTokenUsageMetricsFromSpan } = await import('../core/workflow/observability/workflowMetrics.js');

      recordTokenUsageMetricsFromSpan({
        name: 'phase.implement.execute',
        attributes: {
          'takt.run.id': 'run-1',
          'takt.provider.name': 'codex',
          'takt.step.name': 'implement',
          'gen_ai.usage.input_tokens': 11,
          'gen_ai.usage.output_tokens': 7,
        },
      }, estimateTokenCostUsd);
    });

    const attributes = {
      'takt.run.id': 'run-1',
      'takt.provider.name': 'codex',
      'takt.model.name': '(default)',
      'takt.step.name': 'implement',
    };
    expect(metricPoint(points, 'takt.token.input_tokens', attributes)?.value).toBe(11);
    expect(metricPoint(points, 'takt.token.output_tokens', attributes)?.value).toBe(7);
    expect(points.filter((point) => point.name === 'takt.token.estimated_cost_usd')).toEqual([]);
    expect(estimateTokenCostUsd).not.toHaveBeenCalled();
  });

  it('Given an unsupported span or incomplete usage, When recording token metrics, Then emits no token counters', async () => {
    const estimateTokenCostUsd = vi.fn(() => 0.00021);

    const points = await collectMetricPoints(async () => {
      const { recordTokenUsageMetricsFromSpan } = await import('../core/workflow/observability/workflowMetrics.js');

      recordTokenUsageMetricsFromSpan({
        name: 'workflow.test-workflow',
        attributes: {
          'takt.run.id': 'run-1',
          'takt.provider.name': 'codex',
          'takt.model.name': 'gpt-5',
          'takt.step.name': 'implement',
          'gen_ai.usage.input_tokens': 11,
        },
      }, estimateTokenCostUsd);
      recordTokenUsageMetricsFromSpan({
        name: 'phase.implement.execute',
        attributes: {
          'takt.run.id': 'run-1',
          'takt.provider.name': 'codex',
          'takt.model.name': 'gpt-5',
          'takt.step.name': 'implement',
          'gen_ai.usage.input_tokens': 11,
        },
      }, estimateTokenCostUsd);
    });

    expect(points.filter((point) => point.name.startsWith('takt.token.'))).toEqual([]);
    expect(estimateTokenCostUsd).not.toHaveBeenCalled();
  });

  it('Given cost estimation returns undefined for inconsistent cache tokens, When recording token metrics, Then emits no cost counter', async () => {
    const estimateTokenCostUsd = vi.fn(() => undefined);

    const points = await collectMetricPoints(async () => {
      const { recordTokenUsageMetricsFromSpan } = await import('../core/workflow/observability/workflowMetrics.js');

      recordTokenUsageMetricsFromSpan({
        name: 'phase.implement.execute',
        attributes: {
          'takt.run.id': 'run-1',
          'takt.provider.name': 'claude',
          'takt.model.name': 'claude-opus-4-5-20251101',
          'takt.step.name': 'implement',
          'gen_ai.usage.input_tokens': 1_000,
          'gen_ai.usage.output_tokens': 500,
          'gen_ai.usage.cached_input_tokens': 12_000,
          'gen_ai.usage.cache_creation_input_tokens': 2_000,
          'gen_ai.usage.cache_read_input_tokens': 9_999,
        },
      }, estimateTokenCostUsd);
    });

    expect(metricPoint(points, 'takt.token.input_tokens', {
      'takt.run.id': 'run-1',
      'takt.provider.name': 'claude',
      'takt.model.name': 'claude-opus-4-5-20251101',
      'takt.step.name': 'implement',
    })?.value).toBe(1_000);
    expect(points.filter((point) => point.name === 'takt.token.estimated_cost_usd')).toEqual([]);
    expect(estimateTokenCostUsd).toHaveBeenCalledWith('claude', 'claude-opus-4-5-20251101', expect.objectContaining({
      cachedInputTokens: 12_000,
      cacheCreationInputTokens: 2_000,
      cacheReadInputTokens: 9_999,
    }));
  });

  it('Given provider failures and retries, When recording provider error metrics, Then classifies each error type separately', async () => {
    const points = await collectMetricPoints(async () => {
      const { recordProviderErrorMetric } = await import('../core/workflow/observability/workflowMetrics.js');

      recordProviderErrorMetric({
        runId: 'run-1',
        provider: 'codex',
        model: 'gpt-5',
        errorType: 'rate_limit',
        count: 1,
      });
      recordProviderErrorMetric({
        runId: 'run-1',
        provider: 'codex',
        model: 'gpt-5',
        errorType: 'retry',
        count: 2,
      });
    });

    expect(metricPoint(points, 'takt.provider.errors', {
      'takt.run.id': 'run-1',
      'takt.provider.name': 'codex',
      'takt.model.name': 'gpt-5',
      'takt.provider.error_type': 'rate_limit',
    })?.value).toBe(1);
    expect(metricPoint(points, 'takt.provider.errors', {
      'takt.run.id': 'run-1',
      'takt.provider.name': 'codex',
      'takt.model.name': 'gpt-5',
      'takt.provider.error_type': 'retry',
    })?.value).toBe(2);
  });

  it('Given a provider failure without a resolved model, When recording provider error metrics, Then emits the default model label', async () => {
    const points = await collectMetricPoints(async () => {
      const { recordProviderErrorMetric } = await import('../core/workflow/observability/workflowMetrics.js');

      recordProviderErrorMetric({
        runId: 'run-1',
        provider: 'codex',
        errorType: 'rate_limit',
      });
    });

    expect(metricPoint(points, 'takt.provider.errors', {
      'takt.run.id': 'run-1',
      'takt.provider.name': 'codex',
      'takt.model.name': '(default)',
      'takt.provider.error_type': 'rate_limit',
    })?.value).toBe(1);
  });

  it('Given quality gate and workflow loop events, When recording workflow metrics, Then emits counters with workflow and step labels', async () => {
    const points = await collectMetricPoints(async () => {
      const {
        recordQualityGateResultMetric,
        recordWorkflowCycleDetectedMetric,
        recordWorkflowLoopDetectedMetric,
      } = await import('../core/workflow/observability/workflowMetrics.js');

      recordQualityGateResultMetric({
        runId: 'run-1',
        workflowName: 'default',
        stepName: 'implement',
        gateName: 'lint',
        result: 'pass',
      });
      recordWorkflowLoopDetectedMetric({
        runId: 'run-1',
        workflowName: 'default',
        stepName: 'implement',
      });
      recordWorkflowCycleDetectedMetric({
        runId: 'run-1',
        workflowName: 'default',
        stepName: 'fix',
      });
    });

    expect(metricPoint(points, 'takt.quality_gate.results', {
      'takt.run.id': 'run-1',
      'takt.workflow.name': 'default',
      'takt.step.name': 'implement',
      'takt.quality_gate.name': 'lint',
      'takt.quality_gate.result': 'pass',
    })?.value).toBe(1);
    expect(metricPoint(points, 'takt.workflow.loops_detected', {
      'takt.run.id': 'run-1',
      'takt.workflow.name': 'default',
      'takt.step.name': 'implement',
    })?.value).toBe(1);
    expect(metricPoint(points, 'takt.workflow.cycles_detected', {
      'takt.run.id': 'run-1',
      'takt.workflow.name': 'default',
      'takt.step.name': 'fix',
    })?.value).toBe(1);
  });
});
