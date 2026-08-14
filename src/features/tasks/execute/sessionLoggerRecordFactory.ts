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
  NdjsonCompanionReviewRound,
  NdjsonCompanionQueueCoalesced,
  NdjsonCompanionCall,
  NdjsonCompanionReviewSkipped,
  NdjsonCompanionReviewTrigger,
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
  CompanionCallPurpose,
  CompanionCallStatus,
  CompanionModeratorAudit,
  CompanionAcceptedFindingAudit,
  CompanionReviewPhase,
  CompanionReviewSkipReason,
  CompanionReviewZeroReason,
} from '../../../core/workflow/types.js';
import { redactProviderOptions } from '../../../core/workflow/providerOptionsRedaction.js';
import { toJudgmentMatchMethod } from '../../../core/logging/contracts.js';
import {
  parseCanonicalWorkflowResumeFrame,
} from '../../../shared/types/workflow-resume.js';
import type { InteractiveMetadata } from './types.js';
import { truncateUtf8 } from '../../../shared/utils/utf8.js';
import { isSensitiveKeyName } from '../../../shared/utils/sensitiveText.js';
import { COMPANION_PROMPT_LIMITS } from '../../../core/workflow/companion/limits.js';
import { COMPANION_OUTPUT_LIMITS } from '../../../core/workflow/companion/output-envelope.js';

type SanitizeText = (text: string) => string;

const COMPANION_AUDIT_PROMPT_MAX_BYTES = COMPANION_PROMPT_LIMITS.maxPromptBytes;
const COMPANION_AUDIT_RESPONSE_MAX_BYTES = COMPANION_OUTPUT_LIMITS.maxSerializedBytes;

function serializeWorkflowStack(stack: WorkflowResumePointEntry[] | undefined): {
  workflow?: string;
  stack?: Array<{
    workflow: string;
    workflow_ref: string;
    step: string;
    kind: WorkflowResumePointEntry['kind'];
    occurrence: number;
  }>;
} {
  if (!stack || stack.length === 0) {
    return {};
  }

  return {
    workflow: stack[stack.length - 1]?.workflow,
    stack: stack.map((entry, index) => (
      parseCanonicalWorkflowResumeFrame(
        entry,
        `NDJSON workflow stack[${index}]`,
      )
    )),
  };
}

export function buildWorkflowCallStartRecord(
  lifecycle: WorkflowCallLifecycle,
): NdjsonWorkflowCallStart {
  const scope = serializeWorkflowStack(lifecycle.stack);
  if (scope.stack === undefined) {
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
  scope: string,
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
    scope,
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
    ...(providerInfo?.providerOptions !== undefined ? { providerOptions: redactProviderOptions(providerInfo.providerOptions) } : {}),
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
  failureCategory?: AgentResponse['failureCategory'],
): NdjsonWorkflowAbort {
  return {
    type: 'workflow_abort',
    iterations: state.iteration,
    reason: sanitizeText(reason),
    ...(failureCategory === undefined ? {} : { failureCategory }),
    endTime: new Date().toISOString(),
  };
}

export function buildCompanionReviewRoundRecord(input: {
  readonly step: string;
  readonly companion: string;
  readonly trigger: NdjsonCompanionReviewTrigger;
  readonly digest: string;
  readonly changedLines: number;
  readonly findingCount: number;
  readonly reviewerFindings: readonly CompanionAcceptedFindingAudit[];
  readonly moderator?: CompanionModeratorAudit;
  readonly acceptedFindings: readonly CompanionAcceptedFindingAudit[];
  readonly zeroReason?: CompanionReviewZeroReason;
  readonly runPathNamespace?: readonly string[];
}, sanitizeText: SanitizeText): NdjsonCompanionReviewRound {
  return {
    type: 'companion_review_round',
    step: input.step,
    companion: input.companion,
    trigger: input.trigger,
    digest: input.digest,
    changedLines: input.changedLines,
    findingCount: input.findingCount,
    reviewerFindings: sanitizeAcceptedFindings(input.reviewerFindings, sanitizeText),
    ...(input.moderator === undefined ? {} : {
      moderator: sanitizeModeratorAudit(input.moderator, sanitizeText),
    }),
    acceptedFindings: sanitizeAcceptedFindings(input.acceptedFindings, sanitizeText),
    ...(input.zeroReason === undefined ? {} : { zeroReason: input.zeroReason }),
    ...(input.runPathNamespace === undefined || input.runPathNamespace.length === 0
      ? {}
      : { runPathNamespace: [...input.runPathNamespace] }),
    timestamp: new Date().toISOString(),
  };
}

export function buildCompanionQueueCoalescedRecord(input: {
  readonly step: string;
  readonly companion: string;
  readonly replaced: NdjsonCompanionQueueCoalesced['replaced'];
  readonly replacement: NdjsonCompanionQueueCoalesced['replacement'];
  readonly runPathNamespace?: readonly string[];
}): NdjsonCompanionQueueCoalesced {
  const { runPathNamespace, ...record } = input;
  return {
    type: 'companion_queue_coalesced',
    ...record,
    ...(runPathNamespace === undefined || runPathNamespace.length === 0
      ? {}
      : { runPathNamespace: [...runPathNamespace] }),
    timestamp: new Date().toISOString(),
  };
}

export function buildCompanionCallRecord(
  input: {
    readonly step: string;
    readonly agent: string;
    readonly purpose: CompanionCallPurpose;
    readonly attempt: number;
    readonly status: CompanionCallStatus;
    readonly provider: string;
    readonly model?: string;
    readonly systemPrompt?: string;
    readonly prompt?: string;
    readonly promptResolved: boolean;
    readonly runPathNamespace?: readonly string[];
    readonly response?: AgentResponse;
    readonly error?: string;
  },
  sanitizeText: SanitizeText,
): NdjsonCompanionCall {
  const promptResolved = input.promptResolved;
  const systemPrompt = !promptResolved || input.systemPrompt === undefined
    ? undefined
    : truncateAuditText(input.systemPrompt, sanitizeText, COMPANION_AUDIT_PROMPT_MAX_BYTES);
  const prompt = !promptResolved || input.prompt === undefined
    ? undefined
    : truncateAuditText(input.prompt, sanitizeText, COMPANION_AUDIT_PROMPT_MAX_BYTES);
  const response = input.response === undefined
    ? undefined
    : truncateAuditText(input.response.content, sanitizeText, COMPANION_AUDIT_RESPONSE_MAX_BYTES);
  const structuredOutput = input.response?.structuredOutput === undefined
    ? undefined
    : serializeStructuredOutput(
      input.response.structuredOutput,
      sanitizeText,
      COMPANION_AUDIT_RESPONSE_MAX_BYTES,
    );
  const usage = serializeCompanionUsage(input.response?.providerUsage, sanitizeText);
  const sessionId = typeof input.response?.sessionId === 'string'
    ? input.response.sessionId.trim()
    : undefined;
  const error = (input.error ?? input.response?.error) === undefined
    ? undefined
    : truncateAuditText(
      input.error ?? input.response?.error ?? '',
      sanitizeText,
      COMPANION_AUDIT_RESPONSE_MAX_BYTES,
    );
  return {
    type: 'companion_call',
    step: input.step,
    agent: input.agent,
    purpose: input.purpose,
    attempt: input.attempt,
    status: input.status,
    provider: input.provider,
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.runPathNamespace === undefined || input.runPathNamespace.length === 0
      ? {}
      : { runPathNamespace: [...input.runPathNamespace] }),
    sessionIdAvailable: sessionId !== undefined && sessionId.length > 0,
    ...(sessionId === undefined || sessionId.length === 0
      ? {}
      : { sessionId: sanitizeText(sessionId) }),
    promptResolved,
    ...(systemPrompt === undefined ? {} : {
      systemPrompt: systemPrompt.value,
      systemPromptTruncated: systemPrompt.truncated,
    }),
    ...(prompt === undefined ? {} : {
      prompt: prompt.value,
      promptTruncated: prompt.truncated,
    }),
    ...(response === undefined
      ? {}
      : { response: response.value, responseTruncated: response.truncated }),
    ...(structuredOutput === undefined
      ? {}
      : { structuredOutput: structuredOutput.value, structuredOutputTruncated: structuredOutput.truncated }),
    usage,
    ...(error === undefined
      ? {}
      : { error: error.value, errorTruncated: error.truncated }),
    timestamp: new Date().toISOString(),
  };
}

function sanitizeAcceptedFindings(
  findings: readonly CompanionAcceptedFindingAudit[],
  sanitizeText: SanitizeText,
): NdjsonCompanionReviewRound['acceptedFindings'] {
  return findings.map((finding) => ({
    severity: finding.severity,
    file: sanitizeText(finding.file),
    line: finding.line,
    finding: sanitizeText(finding.finding),
  }));
}

export function buildCompanionReviewSkippedRecord(
  input: {
    readonly step: string;
    readonly companion?: string;
    readonly phase: CompanionReviewPhase;
    readonly reason: CompanionReviewSkipReason;
    readonly fixRound?: number;
    readonly observedGeneration?: number;
    readonly runPathNamespace?: readonly string[];
  },
): NdjsonCompanionReviewSkipped {
  return {
    type: 'companion_review_skipped',
    step: input.step,
    ...(input.companion === undefined ? {} : { companion: input.companion }),
    ...(input.runPathNamespace === undefined || input.runPathNamespace.length === 0
      ? {}
      : { runPathNamespace: [...input.runPathNamespace] }),
    phase: input.phase,
    reason: input.reason,
    ...(input.fixRound === undefined ? {} : { fixRound: input.fixRound }),
    ...(input.observedGeneration === undefined
      ? {}
      : { observedGeneration: input.observedGeneration }),
    timestamp: new Date().toISOString(),
  };
}

function truncateAuditText(
  value: string,
  sanitizeText: SanitizeText,
  maxBytes: number,
): { value: string; truncated: boolean } {
  const sanitized = sanitizeText(value);
  const truncated = truncateUtf8(sanitized, maxBytes);
  return { value: truncated.value, truncated: truncated.bytes < Buffer.byteLength(sanitized, 'utf8') };
}

function sanitizeStructuredOutput(
  value: Record<string, unknown>,
  sanitizeText: SanitizeText,
): Record<string, unknown> {
  return sanitizeStructuredValue(value, sanitizeText) as Record<string, unknown>;
}

function serializeStructuredOutput(
  value: Record<string, unknown>,
  sanitizeText: SanitizeText,
  maxBytes: number,
): { value: string; truncated: boolean } {
  const sanitized = sanitizeStructuredOutput(value, sanitizeText);
  const serialized = JSON.stringify(sanitized);
  if (serialized === undefined) {
    throw new Error('Companion structured output is not serializable');
  }
  // Re-sanitize the serialized envelope so embedded assignment-style secrets
  // are covered in addition to key-aware nested redaction.
  return truncateAuditText(serialized, sanitizeText, maxBytes);
}

function sanitizeStructuredValue(
  value: unknown,
  sanitizeText: SanitizeText,
  key?: string,
): unknown {
  if (key !== undefined && isSensitiveKeyName(key)) return '[REDACTED]';
  if (typeof value === 'string') return sanitizeText(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeStructuredValue(item, sanitizeText));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([nestedKey, nested]) => [
      nestedKey,
      sanitizeStructuredValue(nested, sanitizeText, nestedKey),
    ]),
  );
}

function sanitizeModeratorAudit(
  moderator: CompanionModeratorAudit,
  sanitizeText: SanitizeText,
): NonNullable<NdjsonCompanionReviewRound['moderator']> {
  return {
    name: sanitizeText(moderator.name),
    invoked: moderator.invoked,
    ...(moderator.reason === undefined ? {} : { reason: moderator.reason }),
    decisions: moderator.decisions.map((decision) => ({
      action: decision.action,
      sourceIndex: decision.sourceIndex,
    })),
  };
}

function serializeCompanionUsage(
  usage: AgentResponse['providerUsage'],
  sanitizeText: SanitizeText,
): NdjsonCompanionCall['usage'] {
  if (usage === undefined) {
    return {
      usageMissing: true,
      reason: 'provider_did_not_return_usage',
    };
  }
  return {
    usageMissing: usage.usageMissing ?? true,
    ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
    ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
    ...(usage.cachedInputTokens === undefined ? {} : { cachedInputTokens: usage.cachedInputTokens }),
    ...(usage.cacheCreationInputTokens === undefined ? {} : {
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
    }),
    ...(usage.cacheReadInputTokens === undefined ? {} : { cacheReadInputTokens: usage.cacheReadInputTokens }),
    ...(usage.reason === undefined ? {} : { reason: sanitizeText(usage.reason) }),
  };
}
