import { metrics } from '@opentelemetry/api';
import type { AgentResponse, ProviderUsageSnapshot } from '../../models/response.js';
import type { StepProviderInfo, StepRunResult } from '../types.js';
import { AGENT_FAILURE_CATEGORIES } from '../../../shared/types/agent-failure.js';
import { usageSnapshotFromSpanAttributes } from '../../logging/spanUsageAttributes.js';

const INPUT_TOKENS_COUNTER_OPTIONS = {
  description: 'Input tokens used by provider calls',
  unit: 'tokens',
};
const OUTPUT_TOKENS_COUNTER_OPTIONS = {
  description: 'Output tokens used by provider calls',
  unit: 'tokens',
};
const CACHED_INPUT_TOKENS_COUNTER_OPTIONS = {
  description: 'Cached input tokens used by provider calls',
  unit: 'tokens',
};
const ESTIMATED_COST_COUNTER_OPTIONS = {
  description: 'Estimated provider call cost in USD',
  unit: 'USD',
};
const PROVIDER_ERRORS_COUNTER_OPTIONS = {
  description: 'Provider errors and retry attempts by type',
};
const QUALITY_GATE_RESULTS_COUNTER_OPTIONS = {
  description: 'Command quality gate results by gate and result',
};
const WORKFLOW_LOOPS_COUNTER_OPTIONS = {
  description: 'Workflow same-step loops detected',
};
const WORKFLOW_CYCLES_COUNTER_OPTIONS = {
  description: 'Workflow configured cycles detected',
};
const DEFAULT_MODEL_LABEL = '(default)';

export interface SpanMetricSnapshot {
  name: string;
  attributes: Record<string, unknown>;
}

export interface ProviderErrorMetricInput {
  runId?: string;
  provider?: string;
  model?: string;
  errorType: string;
  count?: number;
}

export interface QualityGateResultMetricInput {
  runId?: string;
  workflowName: string;
  stepName: string;
  gateName: string;
  result: 'pass' | 'fail';
}

export interface WorkflowDetectionMetricInput {
  runId?: string;
  workflowName: string;
  stepName: string;
}

export type TokenCostEstimator = (
  provider: string,
  model: string,
  usage: ProviderUsageSnapshot,
) => number | undefined;

export function recordTokenUsageMetricsFromSpan(
  span: SpanMetricSnapshot,
  estimateTokenCostUsd: TokenCostEstimator,
): void {
  if (!isUsageMetricSpan(span.name)) {
    return;
  }

  const runId = stringAttribute(span, 'takt.run.id');
  const provider = stringAttribute(span, 'takt.provider.name');
  const model = stringAttribute(span, 'takt.model.name');
  const stepName = stringAttribute(span, 'takt.step.name');
  const usage = usageSnapshotFromSpanAttributes(span.attributes);
  if (!runId || !provider || !stepName || usage.usageMissing) {
    return;
  }

  const inputTokens = finiteMetricNumber(usage.inputTokens);
  const outputTokens = finiteMetricNumber(usage.outputTokens);
  if (inputTokens === undefined || outputTokens === undefined) {
    return;
  }

  const attributes: Record<string, string> = {
    'takt.run.id': runId,
    'takt.provider.name': provider,
    'takt.model.name': model ?? DEFAULT_MODEL_LABEL,
    'takt.step.name': stepName,
  };
  const meter = workflowMeter();
  meter.createCounter('takt.token.input_tokens', INPUT_TOKENS_COUNTER_OPTIONS).add(inputTokens, attributes);
  meter.createCounter('takt.token.output_tokens', OUTPUT_TOKENS_COUNTER_OPTIONS).add(outputTokens, attributes);

  const cachedInputTokens = finiteMetricNumber(usage.cachedInputTokens);
  if (cachedInputTokens !== undefined) {
    meter.createCounter(
      'takt.token.cached_input_tokens',
      CACHED_INPUT_TOKENS_COUNTER_OPTIONS,
    ).add(cachedInputTokens, attributes);
  }

  const estimatedCost = model ? finiteMetricNumber(estimateTokenCostUsd(provider, model, usage)) : undefined;
  if (estimatedCost !== undefined) {
    meter.createCounter('takt.token.estimated_cost_usd', ESTIMATED_COST_COUNTER_OPTIONS).add(estimatedCost, attributes);
  }
}

export function recordProviderErrorMetric(input: ProviderErrorMetricInput): void {
  const count = input.count ?? 1;
  if (!input.runId || !input.provider || count <= 0) {
    return;
  }
  workflowMeter().createCounter('takt.provider.errors', PROVIDER_ERRORS_COUNTER_OPTIONS).add(count, {
    'takt.run.id': input.runId,
    'takt.provider.name': input.provider,
    'takt.model.name': input.model ?? DEFAULT_MODEL_LABEL,
    'takt.provider.error_type': input.errorType,
  });
}

export function recordStepProviderErrorMetrics(
  runId: string | undefined,
  result: StepRunResult | undefined,
  providerInfo: StepProviderInfo | undefined,
): void {
  const response = result?.response;
  const resolvedProviderInfo = result?.providerInfo ?? providerInfo;
  const provider = resolvedProviderInfo?.provider;
  const model = resolvedProviderInfo?.model;
  const retryCount = finiteMetricNumber(response?.retryCount);
  if (retryCount !== undefined && retryCount > 0) {
    recordProviderErrorMetric({
      runId,
      provider,
      model,
      errorType: 'retry',
      count: retryCount,
    });
  }

  const errorType = providerErrorType(response);
  if (errorType) {
    recordProviderErrorMetric({
      runId,
      provider,
      model,
      errorType,
    });
  }
}

export function recordQualityGateResultMetric(input: QualityGateResultMetricInput): void {
  if (!input.runId) {
    return;
  }
  workflowMeter().createCounter('takt.quality_gate.results', QUALITY_GATE_RESULTS_COUNTER_OPTIONS).add(1, {
    'takt.run.id': input.runId,
    'takt.workflow.name': input.workflowName,
    'takt.step.name': input.stepName,
    'takt.quality_gate.name': input.gateName,
    'takt.quality_gate.result': input.result,
  });
}

export function recordWorkflowLoopDetectedMetric(input: WorkflowDetectionMetricInput): void {
  recordWorkflowDetectionMetric('takt.workflow.loops_detected', WORKFLOW_LOOPS_COUNTER_OPTIONS, input);
}

export function recordWorkflowCycleDetectedMetric(input: WorkflowDetectionMetricInput): void {
  recordWorkflowDetectionMetric('takt.workflow.cycles_detected', WORKFLOW_CYCLES_COUNTER_OPTIONS, input);
}

function recordWorkflowDetectionMetric(
  name: string,
  options: { description: string },
  input: WorkflowDetectionMetricInput,
): void {
  if (!input.runId) {
    return;
  }
  workflowMeter().createCounter(name, options).add(1, {
    'takt.run.id': input.runId,
    'takt.workflow.name': input.workflowName,
    'takt.step.name': input.stepName,
  });
}

function workflowMeter() {
  return metrics.getMeter('takt.workflow');
}

function isUsageMetricSpan(name: string): boolean {
  return name.startsWith('phase.') || name.startsWith('judge_stage.');
}

function providerErrorType(response: AgentResponse | undefined): string | undefined {
  if (!response) {
    return undefined;
  }
  if (response.errorKind === 'rate_limit' || response.status === 'rate_limited') {
    return 'rate_limit';
  }
  if (response.failureCategory) {
    return response.failureCategory;
  }
  if (response.status === 'error') {
    return AGENT_FAILURE_CATEGORIES.PROVIDER_ERROR;
  }
  return undefined;
}

function stringAttribute(span: SpanMetricSnapshot, key: string): string | undefined {
  const value = span.attributes[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function finiteMetricNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
