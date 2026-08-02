import type {
  NdjsonInteractiveEnd,
  NdjsonInteractiveStart,
  NdjsonWorkflowCallComplete,
  NdjsonWorkflowCallStart,
  NdjsonPhaseComplete,
  NdjsonPhaseJudgeStage,
  NdjsonPhaseStart,
  NdjsonStepComplete,
  NdjsonStepStart,
  NdjsonWorkflowAbort,
  NdjsonWorkflowComplete,
} from '../../../infra/fs/index.js';
import type { PromptLogRecord } from '../../../shared/utils/index.js';
import type {
  AgentResponse,
  WorkflowResumePointEntry,
  WorkflowState,
  WorkflowStep,
} from '../../../core/models/index.js';
import type {
  JudgeStageEntry,
  PhasePromptParts,
  StepProviderInfo,
  WorkflowCallCompleteLifecycle,
  WorkflowCallLifecycle,
} from '../../../core/workflow/types.js';
import { redactProviderOptions } from '../../../core/workflow/providerOptionsRedaction.js';
import { toJudgmentMatchMethod } from '../../../core/logging/contracts.js';
import type { InteractiveMetadata } from './types.js';

type SanitizeText = (text: string) => string;

function serializeWorkflowStack(stack: readonly WorkflowResumePointEntry[] | undefined): {
  workflow?: string;
  stack?: Array<{
    workflow: string;
    workflow_ref?: string;
    step: string;
    kind: 'agent' | 'system' | 'workflow_call';
    call_instance?: number;
  }>;
} {
  if (!stack || stack.length === 0) {
    return {};
  }

  return {
    workflow: stack[stack.length - 1]?.workflow,
    stack: stack.map((entry) => ({
      workflow: entry.workflow,
      ...(entry.workflow_ref ? { workflow_ref: entry.workflow_ref } : {}),
      step: entry.step,
      kind: entry.kind,
      ...(entry.call_instance !== undefined ? { call_instance: entry.call_instance } : {}),
    })),
  };
}

export function buildWorkflowCallStartRecord(
  lifecycle: WorkflowCallLifecycle,
): NdjsonWorkflowCallStart {
  const scope = serializeWorkflowStack(lifecycle.stack);
  if (scope.workflow === undefined || scope.stack === undefined) {
    throw new Error(`workflow_call "${lifecycle.step}" requires a non-empty call stack`);
  }
  return {
    type: 'workflow_call_start',
    workflow: lifecycle.parentWorkflow,
    step: lifecycle.step,
    childWorkflow: lifecycle.childWorkflow,
    callInstance: lifecycle.callInstance,
    stack: scope.stack,
    timestamp: new Date().toISOString(),
  };
}

export function buildWorkflowCallCompleteRecord(
  lifecycle: WorkflowCallCompleteLifecycle,
  sanitizeText: SanitizeText,
): NdjsonWorkflowCallComplete {
  const start = buildWorkflowCallStartRecord(lifecycle);
  return {
    ...start,
    type: 'workflow_call_complete',
    status: lifecycle.result.status,
    ...(lifecycle.result.status === 'completed' && lifecycle.result.returnValue !== undefined
      ? { returnValue: sanitizeText(lifecycle.result.returnValue) }
      : {}),
    ...(lifecycle.result.status === 'aborted' && lifecycle.result.abortKind !== undefined
      ? { abortKind: lifecycle.result.abortKind }
      : {}),
    ...(lifecycle.result.status === 'aborted' && lifecycle.result.abortReason !== undefined
      ? { abortReason: sanitizeText(lifecycle.result.abortReason) }
      : {}),
    ...(lifecycle.result.status === 'failed'
      ? { reason: sanitizeText(lifecycle.result.reason) }
      : {}),
    timestamp: new Date().toISOString(),
  };
}

export function buildInteractiveRecords(
  meta: InteractiveMetadata,
  sanitizeText: SanitizeText,
): [NdjsonInteractiveStart, NdjsonInteractiveEnd] {
  return [
    { type: 'interactive_start', timestamp: new Date().toISOString() },
    {
      type: 'interactive_end',
      confirmed: meta.confirmed,
      ...(meta.task ? { task: sanitizeText(meta.task) } : {}),
      timestamp: new Date().toISOString(),
    },
  ];
}

export function buildPhaseStartRecord(
  step: WorkflowStep,
  phase: 1 | 2 | 3,
  phaseName: 'execute' | 'report' | 'judge',
  instruction: string,
  promptParts: PhasePromptParts,
  workflowStack: readonly WorkflowResumePointEntry[] | undefined,
  phaseExecutionId: string,
  iteration: number | undefined,
  sanitizeText: SanitizeText,
): NdjsonPhaseStart {
  return {
    type: 'phase_start',
    step: step.name,
    phase,
    phaseName,
    phaseExecutionId,
    timestamp: new Date().toISOString(),
    ...serializeWorkflowStack(workflowStack),
    instruction: sanitizeText(instruction),
    systemPrompt: sanitizeText(promptParts.systemPrompt),
    userInstruction: sanitizeText(promptParts.userInstruction),
    ...(iteration != null ? { iteration } : {}),
  };
}

export function buildPhaseCompleteRecord(
  step: WorkflowStep,
  phase: 1 | 2 | 3,
  phaseName: 'execute' | 'report' | 'judge',
  content: string,
  phaseStatus: string,
  phaseError: string | undefined,
  workflowStack: readonly WorkflowResumePointEntry[] | undefined,
  phaseExecutionId: string,
  iteration: number | undefined,
  completedAt: string,
  sanitizeText: SanitizeText,
): NdjsonPhaseComplete {
  return {
    type: 'phase_complete',
    step: step.name,
    phase,
    phaseName,
    phaseExecutionId,
    status: phaseStatus,
    content: sanitizeText(content),
    timestamp: completedAt,
    ...serializeWorkflowStack(workflowStack),
    ...(phaseError ? { error: sanitizeText(phaseError) } : {}),
    ...(iteration != null ? { iteration } : {}),
  };
}

export function buildPromptLogRecord(
  step: WorkflowStep,
  phase: 1 | 2 | 3,
  iteration: number,
  phaseExecutionId: string,
  promptParts: PhasePromptParts,
  content: string,
  timestamp: string,
  sanitizeText: SanitizeText,
): PromptLogRecord {
  return {
    step: step.name,
    phase,
    iteration,
    phaseExecutionId,
    prompt: sanitizeText(promptParts.userInstruction),
    systemPrompt: sanitizeText(promptParts.systemPrompt),
    userInstruction: sanitizeText(promptParts.userInstruction),
    response: sanitizeText(content),
    timestamp,
  };
}

export function buildPhaseJudgeStageRecord(
  step: WorkflowStep,
  phase: 3,
  phaseName: 'judge',
  entry: JudgeStageEntry,
  workflowStack: readonly WorkflowResumePointEntry[] | undefined,
  phaseExecutionId: string,
  iteration: number | undefined,
  sanitizeText: SanitizeText,
): NdjsonPhaseJudgeStage {
  return {
    type: 'phase_judge_stage',
    step: step.name,
    phase,
    phaseName,
    phaseExecutionId,
    stage: entry.stage,
    method: entry.method,
    status: entry.status,
    ...serializeWorkflowStack(workflowStack),
    instruction: sanitizeText(entry.instruction),
    response: sanitizeText(entry.response),
    timestamp: new Date().toISOString(),
    ...(iteration != null ? { iteration } : {}),
  };
}

export function buildStepStartRecord(
  step: WorkflowStep,
  iteration: number,
  instruction: string | undefined,
  workflowStack: readonly WorkflowResumePointEntry[] | undefined,
  sanitizeText: SanitizeText,
  providerInfo?: StepProviderInfo,
): NdjsonStepStart {
  return {
    type: 'step_start',
    step: step.name,
    persona: step.personaDisplayName,
    iteration,
    timestamp: new Date().toISOString(),
    ...serializeWorkflowStack(workflowStack),
    ...(instruction ? { instruction: sanitizeText(instruction) } : {}),
    ...(providerInfo?.provider !== undefined ? { provider: providerInfo.provider } : {}),
    ...(providerInfo?.providerSource !== undefined ? { providerSource: providerInfo.providerSource } : {}),
    ...(providerInfo?.model !== undefined ? { model: providerInfo.model } : {}),
    ...(providerInfo?.modelSource !== undefined ? { modelSource: providerInfo.modelSource } : {}),
    ...(providerInfo?.providerOptions !== undefined ? { providerOptions: redactProviderOptions(providerInfo.providerOptions) } : {}),
    ...(providerInfo?.providerOptionsSources !== undefined ? { providerOptionsSources: providerInfo.providerOptionsSources } : {}),
  };
}

export function buildStepCompleteRecord(
  step: WorkflowStep,
  response: AgentResponse,
  instruction: string,
  iteration: number,
  workflowStack: readonly WorkflowResumePointEntry[] | undefined,
  sanitizeText: SanitizeText,
): NdjsonStepComplete {
  const matchMethod = toJudgmentMatchMethod(response.matchedRuleMethod);
  return {
    type: 'step_complete',
    step: step.name,
    persona: response.persona,
    iteration,
    status: response.status,
    content: sanitizeText(response.content),
    instruction: sanitizeText(instruction),
    ...serializeWorkflowStack(workflowStack),
    ...(response.matchedRuleIndex != null ? { matchedRuleIndex: response.matchedRuleIndex } : {}),
    ...(response.matchedRuleMethod ? { matchedRuleMethod: response.matchedRuleMethod } : {}),
    ...(matchMethod ? { matchMethod } : {}),
    ...(response.error ? { error: sanitizeText(response.error) } : {}),
    ...(response.failureCategory ? { failureCategory: response.failureCategory } : {}),
    timestamp: response.timestamp.toISOString(),
  };
}

export function buildWorkflowCompleteRecord(state: WorkflowState): NdjsonWorkflowComplete {
  return {
    type: 'workflow_complete',
    iterations: state.iteration,
    endTime: new Date().toISOString(),
  };
}

export function buildWorkflowAbortRecord(
  state: WorkflowState,
  reason: string,
  sanitizeText: SanitizeText,
): NdjsonWorkflowAbort {
  return {
    type: 'workflow_abort',
    iterations: state.iteration,
    reason: sanitizeText(reason),
    endTime: new Date().toISOString(),
  };
}
