import type {
  AgentResponse,
  WorkflowResumePointEntry,
  WorkflowStep,
} from '../../models/types.js';
import type {
  PhasePromptParts,
  StepProviderInfo,
} from '../types.js';
import { runWithPhaseSpan } from '../observability/workflowSpans.js';
import { buildPhaseExecutionId } from '../../../shared/utils/phaseExecutionId.js';

const MAX_PHASE1_EXECUTIONS = 3;

export const PHASE1_EMPTY_OUTPUT_ERROR = 'Phase 1 returned empty output';

export const PHASE1_EMPTY_CONTINUATION_INSTRUCTION = [
  'Continue the review or work from the previous response.',
  'Complete the remaining work and return the final response body.',
  'Do not return an empty response.',
].join(' ');

export type Phase1AttemptReason =
  | 'initial'
  | 'provider_error_fresh'
  | 'empty_continuation'
  | 'empty_fresh'
  | 'publication_retry_fresh'
  | 'companion_fix';

export interface Phase1Attempt {
  readonly sequence: number;
  readonly reason: Phase1AttemptReason;
  readonly instruction: string;
  readonly sessionId: string | undefined;
}

interface Phase1EmptyRecoveryOptions {
  readonly instruction: string;
  readonly initialSessionId: string | undefined;
  readonly retryProviderErrorFresh: boolean;
  readonly execute: (attempt: Phase1Attempt) => Promise<AgentResponse>;
  readonly discardSession: (sessionId: string | undefined) => void;
  readonly recordSupersededAttempt?: (
    response: AgentResponse,
    attempt: Phase1Attempt,
  ) => void;
}

export interface Phase1EmptyRecoveryResult {
  readonly response: AgentResponse;
  readonly finalAttempt: Phase1Attempt;
}

interface SingleFreshPhase1RetryOptions {
  readonly stepName: string;
  readonly sequence: number;
  readonly instruction: string;
  readonly discardSession: () => void;
  readonly execute: (
    attempt: Phase1Attempt,
  ) => Promise<{ response: AgentResponse; promptResolved: boolean }>;
  readonly complete: (
    response: AgentResponse,
    attempt: Phase1Attempt,
  ) => void;
}

interface ObservedPhase1AttemptOptions {
  readonly enabled: boolean;
  readonly runId: string | undefined;
  readonly workflowName: string;
  readonly eventStep: WorkflowStep;
  readonly spanStep: WorkflowStep;
  readonly iteration: number;
  readonly attempt: Phase1Attempt;
  readonly workflowStack: WorkflowResumePointEntry[] | undefined;
  readonly sanitizeText: ((text: string) => string) | undefined;
  readonly providerInfo: StepProviderInfo;
  readonly execute: (
    instruction: string,
    sessionId: string | undefined,
    onPromptResolved: (promptParts: PhasePromptParts) => void,
  ) => Promise<AgentResponse>;
  readonly onPhaseStart: ((
    step: WorkflowStep,
    phase: 1,
    phaseName: 'execute',
    instruction: string,
    promptParts: PhasePromptParts,
    phaseExecutionId: string,
    iteration: number,
  ) => void) | undefined;
}

interface CompleteObservedPhase1AttemptOptions {
  readonly eventStep: WorkflowStep;
  readonly iteration: number;
  readonly attempt: Phase1Attempt;
  readonly response: AgentResponse;
  readonly onPhaseComplete: ((
    step: WorkflowStep,
    phase: 1,
    phaseName: 'execute',
    content: string,
    status: string,
    error: string | undefined,
    phaseExecutionId: string,
    iteration: number,
  ) => void) | undefined;
}

export async function executeObservedPhase1Attempt(
  options: ObservedPhase1AttemptOptions,
): Promise<{ response: AgentResponse; promptResolved: boolean }> {
  const phaseExecutionId = buildPhaseExecutionId({
    step: options.eventStep.name,
    iteration: options.iteration,
    phase: 1,
    sequence: options.attempt.sequence,
  });
  let resolvedPromptParts: PhasePromptParts | undefined;
  const onPromptResolved = (promptParts: PhasePromptParts): void => {
    resolvedPromptParts = promptParts;
    options.onPhaseStart?.(
      options.eventStep,
      1,
      'execute',
      options.attempt.instruction,
      promptParts,
      phaseExecutionId,
      options.iteration,
    );
  };
  const response = await runWithPhaseSpan({
    enabled: options.enabled,
    runId: options.runId,
    workflowName: options.workflowName,
    step: options.spanStep,
    iteration: options.iteration,
    phase: 1,
    phaseName: 'execute',
    instruction: options.attempt.instruction,
    phaseExecutionId,
    workflowStack: options.workflowStack,
    sanitizeText: options.sanitizeText,
    providerInfo: options.providerInfo,
    getPromptParts: () => resolvedPromptParts,
  }, () => options.execute(
    options.attempt.instruction,
    options.attempt.sessionId,
    onPromptResolved,
  ), (result) => ({
    status: result.status,
    content: result.content,
    error: result.error,
    providerUsage: result.providerUsage,
  }));
  return {
    response,
    promptResolved: resolvedPromptParts !== undefined,
  };
}

export function completeObservedPhase1Attempt(
  options: CompleteObservedPhase1AttemptOptions,
): void {
  options.onPhaseComplete?.(
    options.eventStep,
    1,
    'execute',
    options.response.content,
    options.response.status,
    options.response.error,
    buildPhaseExecutionId({
      step: options.eventStep.name,
      iteration: options.iteration,
      phase: 1,
      sequence: options.attempt.sequence,
    }),
    options.iteration,
  );
}

export async function runSingleFreshPhase1Retry(
  options: SingleFreshPhase1RetryOptions,
): Promise<AgentResponse> {
  options.discardSession();
  const attempt: Phase1Attempt = {
    sequence: options.sequence,
    reason: 'publication_retry_fresh',
    instruction: options.instruction,
    sessionId: undefined,
  };
  const result = await options.execute(attempt);
  if (!result.promptResolved) {
    throw new Error(`Missing prompt parts for phase start: ${options.stepName}:1`);
  }
  const response = isEmptyPhase1Response(result.response)
    ? { ...asEmptyOutputError(result.response), content: '' }
    : result.response;
  options.complete(response, attempt);
  return response;
}

function isEmptyPhase1Response(response: AgentResponse): boolean {
  return response.status === 'done'
    && response.structuredOutput === undefined
    && response.content.trim().length === 0;
}

function isProviderErrorEligibleForFreshRetry(response: AgentResponse): boolean {
  return response.status === 'error' && response.errorKind !== 'rate_limit';
}

function withEffectiveSession(
  response: AgentResponse,
  requestSessionId: string | undefined,
): AgentResponse {
  if (response.sessionId !== undefined || requestSessionId === undefined) {
    return response;
  }
  return { ...response, sessionId: requestSessionId };
}

function asEmptyOutputError(response: AgentResponse): AgentResponse {
  const withoutSession = { ...response };
  delete withoutSession.sessionId;
  return {
    ...withoutSession,
    status: 'error',
    error: PHASE1_EMPTY_OUTPUT_ERROR,
  };
}

export async function runPhase1WithEmptyRecovery(
  options: Phase1EmptyRecoveryOptions,
): Promise<Phase1EmptyRecoveryResult> {
  let executionCount = 0;

  const execute = async (
    reason: Phase1AttemptReason,
    instruction: string,
    sessionId: string | undefined,
  ): Promise<{ attempt: Phase1Attempt; response: AgentResponse }> => {
    executionCount++;
    const attempt: Phase1Attempt = {
      sequence: executionCount,
      reason,
      instruction,
      sessionId,
    };
    const response = withEffectiveSession(await options.execute(attempt), sessionId);
    return { attempt, response };
  };

  let current = await execute('initial', options.instruction, options.initialSessionId);

  if (
    options.retryProviderErrorFresh
    && isProviderErrorEligibleForFreshRetry(current.response)
    && executionCount < MAX_PHASE1_EXECUTIONS
  ) {
    options.recordSupersededAttempt?.(current.response, current.attempt);
    options.discardSession(options.initialSessionId);
    current = await execute('provider_error_fresh', options.instruction, undefined);
  }

  if (!isEmptyPhase1Response(current.response)) {
    return { response: current.response, finalAttempt: current.attempt };
  }

  const providerFreshCannotResume = current.attempt.reason === 'provider_error_fresh'
    && current.response.sessionId === undefined;
  if (executionCount < MAX_PHASE1_EXECUTIONS && !providerFreshCannotResume) {
    options.recordSupersededAttempt?.(current.response, current.attempt);
    if (current.response.sessionId === undefined) {
      options.discardSession(options.initialSessionId);
      current = await execute('empty_fresh', options.instruction, undefined);
    } else {
      current = await execute(
        'empty_continuation',
        PHASE1_EMPTY_CONTINUATION_INSTRUCTION,
        current.response.sessionId,
      );
    }
  }

  if (!isEmptyPhase1Response(current.response)) {
    if (
      options.retryProviderErrorFresh
      && current.attempt.reason === 'empty_continuation'
      && isProviderErrorEligibleForFreshRetry(current.response)
      && executionCount < MAX_PHASE1_EXECUTIONS
    ) {
      options.recordSupersededAttempt?.(current.response, current.attempt);
      options.discardSession(options.initialSessionId);
      current = await execute('provider_error_fresh', options.instruction, undefined);
    } else {
      return { response: current.response, finalAttempt: current.attempt };
    }
  }

  if (!isEmptyPhase1Response(current.response)) {
    return { response: current.response, finalAttempt: current.attempt };
  }

  if (
    current.attempt.reason === 'empty_continuation'
    && executionCount < MAX_PHASE1_EXECUTIONS
  ) {
    options.recordSupersededAttempt?.(current.response, current.attempt);
    options.discardSession(options.initialSessionId);
    current = await execute('empty_fresh', options.instruction, undefined);
  }

  if (isEmptyPhase1Response(current.response)) {
    options.discardSession(current.response.sessionId);
    return {
      response: asEmptyOutputError(current.response),
      finalAttempt: current.attempt,
    };
  }

  return { response: current.response, finalAttempt: current.attempt };
}
