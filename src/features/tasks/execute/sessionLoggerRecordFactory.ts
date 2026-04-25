import type {
  NdjsonInteractiveEnd,
  NdjsonInteractiveStart,
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
import type { JudgeStageEntry, PhasePromptParts, StepProviderInfo } from '../../../core/workflow/types.js';
import type { InteractiveMetadata } from './types.js';

type SanitizeText = (text: string) => string;

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

function serializeWorkflowStack(stack: WorkflowResumePointEntry[] | undefined): {
  workflow?: string;
  stack?: Array<{
    workflow: string;
    workflow_ref?: string;
    step: string;
    kind: 'agent' | 'system' | 'workflow_call';
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
    })),
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
  workflowStack: WorkflowResumePointEntry[] | undefined,
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
  workflowStack: WorkflowResumePointEntry[] | undefined,
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
  workflowStack: WorkflowResumePointEntry[] | undefined,
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
  workflowStack: WorkflowResumePointEntry[] | undefined,
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
    ...(providerInfo?.providerOptions !== undefined ? { providerOptions: providerInfo.providerOptions } : {}),
    ...(providerInfo?.providerOptionsSources !== undefined ? { providerOptionsSources: providerInfo.providerOptionsSources } : {}),
  };
}

export function buildStepCompleteRecord(
  step: WorkflowStep,
  response: AgentResponse,
  instruction: string,
  iteration: number,
  workflowStack: WorkflowResumePointEntry[] | undefined,
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
