import { context, metrics, SpanStatusCode, trace, type Attributes, type Span } from '@opentelemetry/api';
import { getErrorMessage } from '../../../shared/utils/index.js';
import type { ProviderUsageSnapshot } from '../../models/response.js';
import type { WorkflowMaxSteps, WorkflowResumePointEntry, WorkflowStep } from '../../models/types.js';
import type { JudgeStageEntry, PhaseName, PhasePromptParts, StepProviderInfo, StepRunResult } from '../types.js';
import { getWorkflowStepKind } from '../step-kind.js';
import { USAGE_MISSING_REASONS } from '../../logging/contracts.js';

const tracer = trace.getTracer('takt.workflow');
const WORKFLOW_RUN_COUNTER_OPTIONS = {
  description: 'Workflow executions by status',
};
const WORKFLOW_DURATION_HISTOGRAM_OPTIONS = {
  description: 'Workflow execution duration',
  unit: 'ms',
};
const STEP_RUN_COUNTER_OPTIONS = {
  description: 'Workflow step executions by status',
};
const STEP_DURATION_HISTOGRAM_OPTIONS = {
  description: 'Workflow step execution duration',
  unit: 'ms',
};
const PHASE_RUN_COUNTER_OPTIONS = {
  description: 'Workflow phase executions by status',
};
const PHASE_DURATION_HISTOGRAM_OPTIONS = {
  description: 'Workflow phase execution duration',
  unit: 'ms',
};
const JUDGE_STAGE_COUNTER_OPTIONS = {
  description: 'Workflow judge stage executions by status',
};

type AttributeInput = Record<string, string | number | boolean | undefined>;

export interface WorkflowSpanParams {
  enabled: boolean;
  runId?: string;
  workflowName: string;
  initialStep: string;
  stepCount: number;
  maxSteps: WorkflowMaxSteps;
  runMode: 'full' | 'single_iteration';
  resumeDepth: number;
  sanitizeText?: (text: string) => string;
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
  runId?: string;
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
  runId?: string;
  workflowName: string;
  step: WorkflowStep;
  iteration?: number;
  phase: 1 | 2 | 3;
  phaseName: PhaseName;
  instruction?: string;
  phaseExecutionId?: string;
  workflowStack?: WorkflowResumePointEntry[];
  sanitizeText?: (text: string) => string;
  providerInfo?: StepProviderInfo;
  getPromptParts?: () => PhasePromptParts | undefined;
}

export interface PhaseSpanOutcome {
  status?: string;
  content?: string;
  error?: string;
  matchedRuleIndex?: number;
  matchedRuleMethod?: string;
  providerUsage?: ProviderUsageSnapshot;
}

export interface JudgeStageSpanParams {
  enabled: boolean;
  runId?: string;
  workflowName: string;
  step: WorkflowStep;
  iteration?: number;
  phaseExecutionId?: string;
  workflowStack?: WorkflowResumePointEntry[];
  entry: JudgeStageEntry;
  sanitizeText?: (text: string) => string;
  providerInfo?: StepProviderInfo;
}

export async function runWithWorkflowSpan<T>(
  params: WorkflowSpanParams,
  execute: () => Promise<T>,
  getOutcome: (result: T) => WorkflowSpanOutcome,
): Promise<T> {
  if (!params.enabled) {
    return execute();
  }

  const startedAt = Date.now();
  return runInSpan(
    buildWorkflowSpanName(params),
    buildWorkflowAttributes(params),
    async (span) => {
      recordWorkflowStartSpan(params);
      try {
        const result = await execute();
        const outcome = getOutcome(result);
        recordWorkflowOutcome(span, params, outcome);
        recordWorkflowMetrics(params, outcome, Date.now() - startedAt);
        return result;
      } catch (error) {
        recordWorkflowMetrics(params, {
          status: 'error',
          abortReason: getErrorMessage(error),
        }, Date.now() - startedAt);
        throw error;
      }
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

  const startedAt = Date.now();
  return runInSpan(
    buildStepSpanName(params),
    buildStepAttributes(params),
    async (span) => {
      try {
        const result = await execute();
        recordStepResult(span, params, result);
        recordStepMetrics(params, result, Date.now() - startedAt);
        return result;
      } catch (error) {
        recordStepMetrics(params, undefined, Date.now() - startedAt, getErrorMessage(error));
        throw error;
      }
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

  const startedAt = Date.now();
  return runInSpan(
    buildPhaseSpanName(params),
    buildPhaseAttributes(params),
    async (span) => {
      try {
        const result = await execute();
        const outcome = getOutcome(result);
        recordPhaseOutcome(span, params, outcome);
        recordPhaseMetrics(params, outcome, Date.now() - startedAt);
        return result;
      } catch (error) {
        const outcome = {
          status: 'error',
          error: getErrorMessage(error),
          providerUsage: {
            usageMissing: true,
            reason: USAGE_MISSING_REASONS.NOT_AVAILABLE,
          },
        };
        recordPhaseOutcome(span, params, outcome);
        recordPhaseMetrics(params, outcome, Date.now() - startedAt);
        throw error;
      }
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
    recordJudgeStageMetrics(params);
    span.setAttributes(compactAttributes({
      ...providerAttributes(params.providerInfo),
      ...usageAttributes(params.entry.providerUsage),
    }));
    if (params.entry.status === 'error') {
      span.setStatus({ code: SpanStatusCode.ERROR, message: `judge stage ${params.entry.status}` });
    }
  } finally {
    span.end();
  }
}

function recordWorkflowStartSpan(params: WorkflowSpanParams): void {
  const span = tracer.startSpan(buildWorkflowStartSpanName(params), {
    attributes: buildWorkflowAttributes(params),
  });
  try {
    span.setAttributes({ 'takt.workflow.status': 'running' });
  } finally {
    span.end();
  }
}

function buildWorkflowAttributes(params: WorkflowSpanParams): Attributes {
  return compactAttributes({
    'takt.run.id': params.runId,
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
    'takt.run.id': params.runId,
    'takt.workflow.name': params.workflowName,
    ...workflowStackAttributes(params.workflowStack),
    'takt.step.name': params.step.name,
    'takt.step.persona': params.step.personaDisplayName,
    'takt.step.type': getWorkflowStepKind(params.step),
    'takt.step.iteration': params.iteration,
    'takt.step.local_iteration': params.stepIteration,
    'takt.step.instruction': sanitizeSpanText(params.sanitizeText, params.instruction),
    ...providerAttributes(params.providerInfo),
    ...providerOptionsAttributes(params.providerInfo),
  });
}

function buildPhaseAttributes(params: PhaseSpanParams): Attributes {
  return compactAttributes({
    'takt.run.id': params.runId,
    'takt.workflow.name': params.workflowName,
    ...workflowStackAttributes(params.workflowStack),
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
    'takt.run.id': params.runId,
    'takt.workflow.name': params.workflowName,
    ...workflowStackAttributes(params.workflowStack),
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
  parentContext = context.active(),
): Promise<T> {
  const span = tracer.startSpan(name, { attributes }, parentContext);
  return context.with(trace.setSpan(parentContext, span), async () => {
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

function recordWorkflowOutcome(span: Span, params: WorkflowSpanParams, outcome: WorkflowSpanOutcome): void {
  const attributes = compactAttributes({
    'takt.workflow.status': outcome.status,
    'takt.workflow.abort.kind': outcome.abortKind,
    'takt.workflow.abort.reason': sanitizeSpanText(params.sanitizeText, outcome.abortReason),
    'takt.workflow.next_step': outcome.nextStep,
    'takt.workflow.iterations': outcome.iterations,
  });
  span.setAttributes(attributes);

  if (outcome.status && outcome.status !== 'completed' && outcome.status !== 'running') {
    span.setStatus({ code: SpanStatusCode.ERROR, message: `workflow ${outcome.status}` });
  }
}

function recordWorkflowMetrics(
  params: WorkflowSpanParams,
  outcome: WorkflowSpanOutcome,
  durationMs: number,
): void {
  const attributes = compactAttributes({
    'takt.run.id': params.runId,
    'takt.workflow.name': params.workflowName,
    'takt.workflow.status': outcome.status ?? 'unknown',
    'takt.workflow.abort.kind': outcome.abortKind,
    'takt.workflow.run_mode': params.runMode,
  });
  const meter = metrics.getMeter('takt.workflow');
  meter.createCounter('takt.workflow.runs', WORKFLOW_RUN_COUNTER_OPTIONS).add(1, attributes);
  meter.createHistogram('takt.workflow.duration', WORKFLOW_DURATION_HISTOGRAM_OPTIONS).record(durationMs, attributes);
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

function recordStepMetrics(
  params: StepSpanParams,
  result: StepRunResult | undefined,
  durationMs: number,
  errorMessage?: string,
): void {
  const providerInfo = result?.providerInfo ?? params.providerInfo;
  const attributes = compactAttributes({
    'takt.run.id': params.runId,
    'takt.workflow.name': params.workflowName,
    'takt.step.name': params.step.name,
    'takt.step.type': getWorkflowStepKind(params.step),
    'takt.step.status': result?.response.status ?? (errorMessage ? 'error' : 'unknown'),
    'takt.step.result.failure_category': result?.response.failureCategory,
    ...providerAttributes(providerInfo),
  });
  const meter = metrics.getMeter('takt.workflow');
  meter.createCounter('takt.workflow.step.runs', STEP_RUN_COUNTER_OPTIONS).add(1, attributes);
  meter.createHistogram('takt.workflow.step.duration', STEP_DURATION_HISTOGRAM_OPTIONS).record(durationMs, attributes);
}

function recordPhaseOutcome(span: Span, params: PhaseSpanParams, outcome: PhaseSpanOutcome): void {
  const promptParts = params.getPromptParts?.();
  span.setAttributes(compactAttributes({
    'takt.phase.status': outcome.status,
    'takt.phase.system_prompt': sanitizeSpanText(params.sanitizeText, promptParts?.systemPrompt),
    'takt.phase.user_instruction': sanitizeSpanText(params.sanitizeText, promptParts?.userInstruction),
    'takt.phase.result.content': sanitizeSpanText(params.sanitizeText, outcome.content),
    'takt.phase.result.error': sanitizeSpanText(params.sanitizeText, outcome.error),
    'takt.phase.result.matched_rule_index': outcome.matchedRuleIndex,
    'takt.phase.result.matched_rule_method': outcome.matchedRuleMethod,
    ...usageAttributes(outcome.providerUsage),
  }));

  if (outcome.status === 'error' || outcome.status === 'rate_limited') {
    span.setStatus({ code: SpanStatusCode.ERROR, message: `phase ${outcome.status}` });
  }
}

function recordPhaseMetrics(
  params: PhaseSpanParams,
  outcome: PhaseSpanOutcome,
  durationMs: number,
): void {
  const attributes = compactAttributes({
    'takt.run.id': params.runId,
    'takt.workflow.name': params.workflowName,
    'takt.step.name': params.step.name,
    'takt.step.type': getWorkflowStepKind(params.step),
    'takt.phase.number': params.phase,
    'takt.phase.name': params.phaseName,
    'takt.phase.status': outcome.status ?? 'unknown',
    ...providerAttributes(params.providerInfo),
  });
  const meter = metrics.getMeter('takt.workflow');
  meter.createCounter('takt.workflow.phase.runs', PHASE_RUN_COUNTER_OPTIONS).add(1, attributes);
  meter.createHistogram('takt.workflow.phase.duration', PHASE_DURATION_HISTOGRAM_OPTIONS).record(durationMs, attributes);
}

function recordJudgeStageMetrics(params: JudgeStageSpanParams): void {
  metrics.getMeter('takt.workflow').createCounter(
    'takt.workflow.judge_stage.runs',
    JUDGE_STAGE_COUNTER_OPTIONS,
  ).add(1, compactAttributes({
    'takt.run.id': params.runId,
    'takt.workflow.name': params.workflowName,
    'takt.step.name': params.step.name,
    'takt.step.type': getWorkflowStepKind(params.step),
    'takt.phase.number': 3,
    'takt.phase.name': 'judge',
    'takt.judge.stage': params.entry.stage,
    'takt.judge.method': params.entry.method,
    'takt.judge.status': params.entry.status,
  }));
}

const REDACTED_PLACEHOLDER = '[redacted]';

function sanitizeSpanText(sanitizeText: ((text: string) => string) | undefined, text: string | undefined): string | undefined {
  if (text === undefined) {
    return undefined;
  }
  // Fail closed: observability span attributes must never carry raw text when
  // no sanitizer was threaded to the call site. Returning the raw text here was
  // a silent leak if any future call site forgot to pass sanitizeText.
  return sanitizeText ? sanitizeText(text) : REDACTED_PLACEHOLDER;
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

function usageAttributes(usage: ProviderUsageSnapshot | undefined): AttributeInput {
  if (!usage) {
    return {};
  }
  if (usage.usageMissing) {
    return {
      'takt.usage.missing': true,
      'takt.usage.missing_reason': usage.reason,
    };
  }
  return {
    'takt.usage.missing': false,
    'gen_ai.usage.input_tokens': usage.inputTokens,
    'gen_ai.usage.output_tokens': usage.outputTokens,
    'gen_ai.usage.total_tokens': usage.totalTokens,
    'gen_ai.usage.cached_input_tokens': usage.cachedInputTokens,
    'gen_ai.usage.cache_creation_input_tokens': usage.cacheCreationInputTokens,
    'gen_ai.usage.cache_read_input_tokens': usage.cacheReadInputTokens,
  };
}

// Step-span only: the canonical step_start record carries providerOptions /
// providerOptionsSources. Span attributes cannot hold objects, so serialize
// them as JSON and parse back in the mapper. Kept out of providerAttributes()
// so metric attributes (which feed cardinality) never get a JSON blob.
function providerOptionsAttributes(providerInfo: StepProviderInfo | undefined): AttributeInput {
  return {
    'takt.provider.options': providerInfo?.providerOptions !== undefined
      ? JSON.stringify(providerInfo.providerOptions)
      : undefined,
    'takt.provider.options_sources': providerInfo?.providerOptionsSources !== undefined
      ? JSON.stringify(providerInfo.providerOptionsSources)
      : undefined,
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

function buildWorkflowSpanName(params: WorkflowSpanParams): string {
  return `workflow.${params.workflowName}`;
}

function buildStepSpanName(params: StepSpanParams): string {
  return `step.${params.step.name}`;
}

function buildWorkflowStartSpanName(params: WorkflowSpanParams): string {
  return `workflow_start.${params.workflowName}`;
}

function buildPhaseSpanName(params: PhaseSpanParams): string {
  return `phase.${params.step.name}.${params.phaseName}`;
}

function buildJudgeStageSpanName(params: JudgeStageSpanParams): string {
  return `judge_stage.${params.step.name}.${params.entry.stage}.${params.entry.method}`;
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
