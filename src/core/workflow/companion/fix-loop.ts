import type { AgentResponse, CompanionFinding } from '../../models/index.js';
import { safeExternalErrorMessage } from '../../../shared/utils/safeExternalErrorMessage.js';
import { createAbortError } from './abort.js';
import { buildCompanionFollowUpInstruction } from './evidence.js';

export interface CompanionFollowUpContext {
  readonly followUpRound: number;
}

export async function runCompanionFixLoop<TOptions extends object>(input: {
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
  }) => Promise<AgentResponse>;
  readonly abortSignal?: AbortSignal;
}): Promise<{
  readonly phaseResponse: AgentResponse;
  readonly latestSessionId: string | undefined;
  readonly followUpRounds: number;
  readonly followUpFailureReason?: string;
}> {
  let latestResponse = input.initialResponse;
  let latestSessionId = input.initialResponse.sessionId;
  let latestImplementerResponse = input.initialResponse.content;
  let followUpRounds = 0;

  for (;;) {
    throwIfAborted(input.abortSignal);
    const review = await input.completeReview({
      implementerResponse: latestImplementerResponse,
      followUpRound: followUpRounds,
    });
    throwIfAborted(input.abortSignal);
    if (review.findings.length === 0) {
      return { phaseResponse: latestResponse, latestSessionId, followUpRounds };
    }

    let fixed: AgentResponse;
    try {
      fixed = await input.executeFollowUp({
        sequence: followUpRounds + 2,
        phase: 1,
        findingCount: review.findings.length,
        sessionId: latestSessionId,
        options: { ...input.phase1Options, sessionId: latestSessionId },
        instruction: buildCompanionFollowUpInstruction(review.findings),
      });
    } catch (error) {
      followUpRounds += 1;
      throwIfAborted(input.abortSignal);
      return {
        phaseResponse: latestResponse,
        latestSessionId,
        followUpRounds,
        followUpFailureReason: safeExternalErrorMessage(error),
      };
    }
    throwIfAborted(input.abortSignal);
    followUpRounds += 1;
    if (fixed.status !== 'done') {
      return {
        phaseResponse: latestResponse,
        latestSessionId,
        followUpRounds,
        followUpFailureReason: safeExternalErrorMessage(fixed.error ?? fixed.content),
      };
    }
    latestSessionId = fixed.sessionId ?? latestSessionId;
    latestResponse = fixed.sessionId === undefined && latestSessionId !== undefined
      ? { ...fixed, sessionId: latestSessionId }
      : fixed;
    latestImplementerResponse = fixed.content;
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createAbortError(signal.reason);
}
