import type { HrTime } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectMetricPoints, metricPoint } from './observability-metrics-test-helpers.js';

describe('WorkflowMetricsSpanProcessor', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('Given an ended phase span with run id and token usage, When no usage event writer is registered, Then still records token counters', async () => {
    const points = await collectMetricPoints(async () => {
      const { WorkflowMetricsSpanProcessor } = await import('../infra/observability/workflowMetricsSpanProcessor.js');
      const processor = new WorkflowMetricsSpanProcessor();

      processor.onEnd(makeReadableSpan('phase.implement.execute', {
        'takt.run.id': 'run-1',
        'takt.provider.name': 'codex',
        'takt.model.name': 'gpt-5',
        'takt.step.name': 'implement',
        'takt.step.type': 'agent',
        'takt.phase.number': 1,
        'takt.phase.name': 'execute',
        'takt.phase.status': 'done',
        'gen_ai.usage.input_tokens': 11,
        'gen_ai.usage.output_tokens': 7,
        'gen_ai.usage.total_tokens': 18,
        'gen_ai.usage.cached_input_tokens': 3,
      }));
    });

    const attributes = {
      'takt.run.id': 'run-1',
      'takt.provider.name': 'codex',
      'takt.model.name': 'gpt-5',
      'takt.step.name': 'implement',
    };
    expect(metricPoint(points, 'takt.token.input_tokens', attributes)?.value).toBe(11);
    expect(metricPoint(points, 'takt.token.output_tokens', attributes)?.value).toBe(7);
    expect(metricPoint(points, 'takt.token.cached_input_tokens', attributes)?.value).toBe(3);
  });

  it('Given an ended judge stage span with token usage, When the processor receives it, Then records token and cost counters', async () => {
    const points = await collectMetricPoints(async () => {
      const { WorkflowMetricsSpanProcessor } = await import('../infra/observability/workflowMetricsSpanProcessor.js');
      const processor = new WorkflowMetricsSpanProcessor();

      processor.onEnd(makeReadableSpan('judge_stage.implement.1.structured_output', {
        'takt.run.id': 'run-1',
        'takt.provider.name': 'codex',
        'takt.model.name': 'gpt-5.4-mini',
        'takt.step.name': 'implement',
        'gen_ai.usage.input_tokens': 100,
        'gen_ai.usage.output_tokens': 50,
        'gen_ai.usage.total_tokens': 150,
      }));
    });

    const attributes = {
      'takt.run.id': 'run-1',
      'takt.provider.name': 'codex',
      'takt.model.name': 'gpt-5.4-mini',
      'takt.step.name': 'implement',
    };
    expect(metricPoint(points, 'takt.token.input_tokens', attributes)?.value).toBe(100);
    expect(metricPoint(points, 'takt.token.output_tokens', attributes)?.value).toBe(50);
    expect(metricPoint(points, 'takt.token.estimated_cost_usd', attributes)?.value).toBe(0.0003);
  });

  const VALID_USAGE_ATTRIBUTES = {
    'takt.run.id': 'run-1',
    'takt.provider.name': 'codex',
    'takt.model.name': 'gpt-5',
    'takt.step.name': 'implement',
    'gen_ai.usage.input_tokens': 11,
    'gen_ai.usage.output_tokens': 7,
    'gen_ai.usage.total_tokens': 18,
  };

  it.each([
    { reason: 'the span is a workflow span', name: 'workflow.test-workflow', attributes: VALID_USAGE_ATTRIBUTES },
    { reason: 'the span is a step span', name: 'step.implement', attributes: VALID_USAGE_ATTRIBUTES },
    { reason: 'the run id is missing', name: 'phase.implement.execute', attributes: omitAttribute(VALID_USAGE_ATTRIBUTES, 'takt.run.id') },
    { reason: 'the provider is missing', name: 'phase.implement.execute', attributes: omitAttribute(VALID_USAGE_ATTRIBUTES, 'takt.provider.name') },
    { reason: 'the step name is missing', name: 'phase.implement.execute', attributes: omitAttribute(VALID_USAGE_ATTRIBUTES, 'takt.step.name') },
    { reason: 'only input tokens are present', name: 'phase.implement.execute', attributes: omitAttribute(VALID_USAGE_ATTRIBUTES, 'gen_ai.usage.output_tokens') },
    { reason: 'only output tokens are present', name: 'phase.implement.execute', attributes: omitAttribute(VALID_USAGE_ATTRIBUTES, 'gen_ai.usage.input_tokens') },
    {
      reason: 'no usage attributes are present',
      name: 'phase.implement.execute',
      attributes: {
        'takt.run.id': 'run-1',
        'takt.provider.name': 'codex',
        'takt.model.name': 'gpt-5',
        'takt.step.name': 'implement',
      },
    },
  ])('Given $reason, When the processor receives the span, Then records no token counters', async ({ name, attributes }) => {
    const points = await collectMetricPoints(async () => {
      const { WorkflowMetricsSpanProcessor } = await import('../infra/observability/workflowMetricsSpanProcessor.js');
      const processor = new WorkflowMetricsSpanProcessor();

      processor.onEnd(makeReadableSpan(name, attributes));
    });

    expect(points.filter((point) => point.name.startsWith('takt.token.'))).toEqual([]);
  });
});

function omitAttribute(attributes: Record<string, unknown>, key: string): Record<string, unknown> {
  const { [key]: _omitted, ...rest } = attributes;
  return rest;
}

function makeReadableSpan(name: string, attributes: Record<string, unknown>): ReadableSpan {
  return {
    name,
    attributes,
    startTime: [1_778_777_200, 0] as HrTime,
    endTime: [1_778_777_205, 0] as HrTime,
  } as ReadableSpan;
}
