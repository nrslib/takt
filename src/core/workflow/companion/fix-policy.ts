import type { AgentResponse, CompanionFinding } from '../../models/index.js';
import type { CompanionFixPolicy } from '../../models/companion-types.js';
import { safeExternalErrorMessage } from '../../../shared/utils/safeExternalErrorMessage.js';
import { createAbortError } from './abort.js';
import { buildCompanionSingleFixInstruction } from './evidence.js';
import {
  isLiveInterventionStructuredOutputFinalizationError,
} from '../structured-output-finalization-error.js';
import {
  runCompanionFixLoop,
  type CompanionFollowUpContext,
  type CompanionFollowUpResult,
} from './fix-loop.js';

interface CompanionFixPolicyInput<TOptions extends object> {
  readonly initialResponse: AgentResponse;
  readonly phase1Options: TOptions;
  readonly completeReview: (
    context: CompanionFollowUpContext & { readonly implementerResponse: string },
  ) => Promise<{ readonly findings: readonly CompanionFinding[] }>;
  readonly executeFollowUp: (attempt: {
    readonly sequence: number;
    readonly phase: 1;
    readonly findingCount: number;
    readonly sessionId: string | undefined;
    readonly options: TOptions & { sessionId: string | undefined };
    readonly instruction: string;
  }) => Promise<CompanionFollowUpResult>;
  readonly abortSignal?: AbortSignal;
}

export async function runCompanionFixPolicy<TOptions extends object>(input: CompanionFixPolicyInput<TOptions> & {
  readonly policy: CompanionFixPolicy;
}): Promise<{
  readonly phaseResponse: AgentResponse;
  readonly latestSessionId: string | undefined;
  readonly followUpRounds: number;
  readonly followUpFailureReason?: string;
}> {
  if (input.policy === 'loop') {
    return runCompanionFixLoop(input);
  }

  throwIfAborted(input.abortSignal);
  const review = await input.completeReview({
    implementerResponse: input.initialResponse.content,
    followUpRound: 0,
  });
  throwIfAborted(input.abortSignal);
  if (review.findings.length === 0) {
    return {
      phaseResponse: input.initialResponse,
      latestSessionId: input.initialResponse.sessionId,
      followUpRounds: 0,
    };
  }

  const latestSessionId = input.initialResponse.sessionId;
  let fixedResult: CompanionFollowUpResult;
  try {
    fixedResult = await input.executeFollowUp({
      sequence: 2,
      phase: 1,
      findingCount: review.findings.length,
      sessionId: latestSessionId,
      options: { ...input.phase1Options, sessionId: latestSessionId },
      instruction: buildCompanionSingleFixInstruction(review.findings),
    });
  } catch (error) {
    throwIfAborted(input.abortSignal);
    if (isLiveInterventionStructuredOutputFinalizationError(error)) throw error;
    return {
      phaseResponse: input.initialResponse,
      latestSessionId,
      followUpRounds: 1,
      followUpFailureReason: safeExternalErrorMessage(error),
    };
  }
  throwIfAborted(input.abortSignal);
  const fixed = fixedResult;
  if (fixed.kind === 'live_intervention' && fixed.response.status !== 'done') {
    return {
      phaseResponse: fixed.response,
      latestSessionId: fixed.response.sessionId ?? latestSessionId,
      followUpRounds: 1,
      followUpFailureReason: safeExternalErrorMessage(
        fixed.response.error ?? fixed.response.content,
      ),
    };
  }
  if (fixed.response.status !== 'done') {
    return {
      phaseResponse: input.initialResponse,
      latestSessionId,
      followUpRounds: 1,
      followUpFailureReason: safeExternalErrorMessage(
        fixed.response.error ?? fixed.response.content,
      ),
    };
  }

  const fixedSessionId = fixed.response.sessionId ?? latestSessionId;
  return {
    phaseResponse: fixed.response.sessionId === undefined && fixedSessionId !== undefined
      ? { ...fixed.response, sessionId: fixedSessionId }
      : fixed.response,
    latestSessionId: fixedSessionId,
    followUpRounds: 1,
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createAbortError(signal.reason);
}
