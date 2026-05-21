import { context, SpanStatusCode, trace, type Attributes, type Span } from '@opentelemetry/api';
import { getErrorMessage } from '../../../shared/utils/index.js';
import type { WorkflowMaxSteps, WorkflowResumePointEntry, WorkflowStep } from '../../models/types.js';
import type { JudgeStageEntry, PhaseName, StepProviderInfo, StepRunResult } from '../types.js';
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
  abortReason?: string;
  nextStep?: string;
  iterations?: number;
}

export interface StepSpanParams {
  enabled: boolean;
  workflowName: string;
  step: WorkflowStep;
  iteration: number;
  stepIteration?: number;
  instruction?: string;
  workflowStack?: WorkflowResumePointEntry[];
  sanitizeText?: (text: string) => string;
  providerInfo?: StepProviderInfo;
  getFinalStepIteration?: () => number | undefined;
}

export interface PhaseSpanParams {
  enabled: boolean;
  workflowName: string;
  step: WorkflowStep;
  iteration?: number;
  phase: 1 | 2 | 3;
  phaseName: PhaseName;
  instruction?: string;
  phaseExecutionId?: string;
  sanitizeText?: (text: string) => string;
  providerInfo?: StepProviderInfo;
}

export interface PhaseSpanOutcome {
  status?: string;
  content?: string;
  error?: string;
  matchedRuleIndex?: number;
  matchedRuleMethod?: string;
}

export interface JudgeStageSpanParams {
  enabled: boolean;
  workflowName: string;
  step: WorkflowStep;
  iteration?: number;
  phaseExecutionId?: string;
  entry: JudgeStageEntry;
  sanitizeText?: (text: string) => string;
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

export async function runWithPhaseSpan<T>(
  params: PhaseSpanParams,
  execute: () => Promise<T>,
  getOutcome: (result: T) => PhaseSpanOutcome,
): Promise<T> {
  if (!params.enabled) {
    return execute();
  }

  return runInSpan(
    buildPhaseSpanName(params),
    buildPhaseAttributes(params),
    async (span) => {
      const result = await execute();
      recordPhaseOutcome(span, params, getOutcome(result));
      return result;
    },
  );
}

export function recordJudgeStageSpan(params: JudgeStageSpanParams): void {
  if (!params.enabled) {
    return;
  }

  const span = tracer.startSpan(buildJudgeStageSpanName(params), {
    attributes: buildJudgeStageAttributes(params),
  });
  try {
    if (params.entry.status === 'error') {
      span.setStatus({ code: SpanStatusCode.ERROR, message: `judge stage ${params.entry.status}` });
    }
  } finally {
    span.end();
  }
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
    ...workflowStackAttributes(params.workflowStack),
    'takt.step.name': params.step.name,
    'takt.step.persona': params.step.personaDisplayName,
    'takt.step.type': getWorkflowStepKind(params.step),
    'takt.step.iteration': params.iteration,
    'takt.step.local_iteration': params.stepIteration,
    'takt.step.instruction': sanitizeSpanText(params.sanitizeText, params.instruction),
    ...providerAttributes(params.providerInfo),
  });
}

function buildPhaseAttributes(params: PhaseSpanParams): Attributes {
  return compactAttributes({
    'takt.workflow.name': params.workflowName,
    'takt.step.name': params.step.name,
    'takt.step.persona': params.step.personaDisplayName,
    'takt.step.type': getWorkflowStepKind(params.step),
    'takt.step.iteration': params.iteration,
    'takt.phase.number': params.phase,
    'takt.phase.name': params.phaseName,
    'takt.phase.execution_id': params.phaseExecutionId,
    'takt.phase.instruction': sanitizeSpanText(params.sanitizeText, params.instruction),
    ...providerAttributes(params.providerInfo),
  });
}

function buildJudgeStageAttributes(params: JudgeStageSpanParams): Attributes {
  return compactAttributes({
    'takt.workflow.name': params.workflowName,
    'takt.step.name': params.step.name,
    'takt.step.persona': params.step.personaDisplayName,
    'takt.step.type': getWorkflowStepKind(params.step),
    'takt.step.iteration': params.iteration,
    'takt.phase.number': 3,
    'takt.phase.name': 'judge',
    'takt.phase.execution_id': params.phaseExecutionId,
    'takt.judge.stage': params.entry.stage,
    'takt.judge.method': params.entry.method,
    'takt.judge.status': params.entry.status,
    'takt.judge.instruction': sanitizeSpanText(params.sanitizeText, params.entry.instruction),
    'takt.judge.response': sanitizeSpanText(params.sanitizeText, params.entry.response),
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
    'takt.workflow.abort.reason': outcome.abortReason,
    'takt.workflow.next_step': outcome.nextStep,
    'takt.workflow.iterations': outcome.iterations,
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
    'takt.step.result.persona': result.response.persona,
    'takt.step.result.content': sanitizeSpanText(params.sanitizeText, result.response.content),
    'takt.step.result.error': sanitizeSpanText(params.sanitizeText, result.response.error),
    'takt.step.result.failure_category': result.response.failureCategory,
    'takt.step.result.matched_rule_index': result.response.matchedRuleIndex,
    'takt.step.result.matched_rule_method': result.response.matchedRuleMethod,
    'takt.step.result.match_method': toJudgmentMatchMethod(result.response.matchedRuleMethod),
    'takt.step.result.timestamp': result.response.timestamp.toISOString(),
    ...providerAttributes(result.providerInfo ?? params.providerInfo),
  }));

  if (result.response.status === 'error' || result.response.status === 'rate_limited') {
    span.setStatus({ code: SpanStatusCode.ERROR, message: `step ${result.response.status}` });
  }
}

function recordPhaseOutcome(span: Span, params: PhaseSpanParams, outcome: PhaseSpanOutcome): void {
  span.setAttributes(compactAttributes({
    'takt.phase.status': outcome.status,
    'takt.phase.result.content': sanitizeSpanText(params.sanitizeText, outcome.content),
    'takt.phase.result.error': sanitizeSpanText(params.sanitizeText, outcome.error),
    'takt.phase.result.matched_rule_index': outcome.matchedRuleIndex,
    'takt.phase.result.matched_rule_method': outcome.matchedRuleMethod,
  }));

  if (outcome.status === 'error' || outcome.status === 'rate_limited') {
    span.setStatus({ code: SpanStatusCode.ERROR, message: `phase ${outcome.status}` });
  }
}

function sanitizeSpanText(sanitizeText: ((text: string) => string) | undefined, text: string | undefined): string | undefined {
  if (text === undefined) {
    return undefined;
  }
  return sanitizeText ? sanitizeText(text) : text;
}

function workflowStackAttributes(stack: WorkflowResumePointEntry[] | undefined): AttributeInput {
  if (!stack || stack.length === 0) {
    return {};
  }
  return {
    'takt.workflow.current_name': stack[stack.length - 1]?.workflow,
    'takt.workflow.stack': JSON.stringify(stack.map((entry) => ({
      workflow: entry.workflow,
      ...(entry.workflow_ref ? { workflow_ref: entry.workflow_ref } : {}),
      step: entry.step,
      kind: entry.kind,
    }))),
  };
}

function providerAttributes(providerInfo: StepProviderInfo | undefined): AttributeInput {
  return {
    'takt.provider.name': providerInfo?.provider,
    'takt.provider.source': providerInfo?.providerSource,
    'takt.model.name': providerInfo?.model,
    'takt.model.source': providerInfo?.modelSource,
  };
}

function toJudgmentMatchMethod(
  matchedRuleMethod: string | undefined,
): string | undefined {
  if (!matchedRuleMethod) {
    return undefined;
  }
  if (matchedRuleMethod === 'structured_output') {
    return 'structured_output';
  }
  if (matchedRuleMethod === 'ai_judge' || matchedRuleMethod === 'ai_judge_fallback') {
    return 'ai_judge';
  }
  if (matchedRuleMethod === 'phase3_tag' || matchedRuleMethod === 'phase1_tag') {
    return 'tag_fallback';
  }
  return undefined;
}

function recordSpanError(span: Span, error: unknown): void {
  const message = getErrorMessage(error);
  span.recordException(error instanceof Error ? error : message);
  span.setStatus({ code: SpanStatusCode.ERROR, message });
}

function buildSpanName(prefix: 'workflow' | 'step', name: string): string {
  return `${prefix}.${name || 'unknown'}`;
}

function buildPhaseSpanName(params: PhaseSpanParams): string {
  return `phase.${params.step.name || 'unknown'}.${params.phaseName}`;
}

function buildJudgeStageSpanName(params: JudgeStageSpanParams): string {
  return `judge_stage.${params.step.name || 'unknown'}.${params.entry.stage}.${params.entry.method}`;
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
