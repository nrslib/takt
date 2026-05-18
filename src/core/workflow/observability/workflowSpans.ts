import { context, SpanStatusCode, trace, type Attributes, type Span } from '@opentelemetry/api';
import { getErrorMessage } from '../../../shared/utils/index.js';
import type { WorkflowMaxSteps, WorkflowStep } from '../../models/types.js';
import type { StepProviderInfo, StepRunResult } from '../types.js';
import { getWorkflowStepKind } from '../step-kind.js';

const tracer = trace.getTracer('takt.workflow');

type AttributeInput = Record<string, string | number | boolean | undefined>;

export interface WorkflowSpanParams {
  enabled: boolean;
  workflowName: string;
  initialStep: string;
  stepCount: number;
  maxSteps: WorkflowMaxSteps;
  runMode: 'full' | 'single_iteration';
  resumeDepth: number;
}

export interface WorkflowSpanOutcome {
  status?: string;
  abortKind?: string;
  nextStep?: string;
}

export interface StepSpanParams {
  enabled: boolean;
  workflowName: string;
  step: WorkflowStep;
  iteration: number;
  stepIteration?: number;
  providerInfo?: StepProviderInfo;
  getFinalStepIteration?: () => number | undefined;
}

export async function runWithWorkflowSpan<T>(
  params: WorkflowSpanParams,
  execute: () => Promise<T>,
  getOutcome: (result: T) => WorkflowSpanOutcome,
): Promise<T> {
  if (!params.enabled) {
    return execute();
  }

  return runInSpan(
    buildSpanName('workflow', params.workflowName),
    buildWorkflowAttributes(params),
    async (span) => {
      const result = await execute();
      recordWorkflowOutcome(span, getOutcome(result));
      return result;
    },
  );
}

export async function runWithStepSpan(
  params: StepSpanParams,
  execute: () => Promise<StepRunResult>,
): Promise<StepRunResult> {
  if (!params.enabled) {
    return execute();
  }

  return runInSpan(
    buildSpanName('step', params.step.name),
    buildStepAttributes(params),
    async (span) => {
      const result = await execute();
      recordStepResult(span, params, result);
      return result;
    },
  );
}

function buildWorkflowAttributes(params: WorkflowSpanParams): Attributes {
  return compactAttributes({
    'takt.workflow.name': params.workflowName,
    'takt.workflow.initial_step': params.initialStep,
    'takt.workflow.step_count': params.stepCount,
    'takt.workflow.max_steps': params.maxSteps,
    'takt.workflow.run_mode': params.runMode,
    'takt.workflow.resume_depth': params.resumeDepth,
  });
}

function buildStepAttributes(params: StepSpanParams): Attributes {
  return compactAttributes({
    'takt.workflow.name': params.workflowName,
    'takt.step.name': params.step.name,
    'takt.step.type': getWorkflowStepKind(params.step),
    'takt.step.iteration': params.iteration,
    'takt.step.local_iteration': params.stepIteration,
    ...providerAttributes(params.providerInfo),
  });
}

async function runInSpan<T>(
  name: string,
  attributes: Attributes,
  execute: (span: Span) => Promise<T>,
): Promise<T> {
  const span = tracer.startSpan(name, { attributes });
  return context.with(trace.setSpan(context.active(), span), async () => {
    try {
      return await execute(span);
    } catch (error) {
      recordSpanError(span, error);
      throw error;
    } finally {
      span.end();
    }
  });
}

function recordWorkflowOutcome(span: Span, outcome: WorkflowSpanOutcome): void {
  const attributes = compactAttributes({
    'takt.workflow.status': outcome.status,
    'takt.workflow.abort.kind': outcome.abortKind,
    'takt.workflow.next_step': outcome.nextStep,
  });
  span.setAttributes(attributes);

  if (outcome.status && outcome.status !== 'completed' && outcome.status !== 'running') {
    span.setStatus({ code: SpanStatusCode.ERROR, message: `workflow ${outcome.status}` });
  }
}

function recordStepResult(span: Span, params: StepSpanParams, result: StepRunResult): void {
  const finalStepIteration = params.getFinalStepIteration?.();
  span.setAttributes(compactAttributes({
    'takt.step.local_iteration': finalStepIteration ?? params.stepIteration,
    'takt.step.status': result.response.status,
    ...providerAttributes(result.providerInfo ?? params.providerInfo),
  }));

  if (result.response.status === 'error' || result.response.status === 'rate_limited') {
    span.setStatus({ code: SpanStatusCode.ERROR, message: `step ${result.response.status}` });
  }
}

function providerAttributes(providerInfo: StepProviderInfo | undefined): AttributeInput {
  return {
    'takt.provider.name': providerInfo?.provider,
    'takt.provider.source': providerInfo?.providerSource,
    'takt.model.name': providerInfo?.model,
    'takt.model.source': providerInfo?.modelSource,
  };
}

function recordSpanError(span: Span, error: unknown): void {
  const message = getErrorMessage(error);
  span.recordException(error instanceof Error ? error : message);
  span.setStatus({ code: SpanStatusCode.ERROR, message });
}

function buildSpanName(prefix: 'workflow' | 'step', name: string): string {
  return `${prefix}.${name || 'unknown'}`;
}

function compactAttributes(attributes: AttributeInput): Attributes {
  const compacted: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined) {
      compacted[key] = value;
    }
  }
  return compacted;
}
