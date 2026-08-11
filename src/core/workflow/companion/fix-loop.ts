import type { AgentResponse, CompanionFindingEvidence } from '../../models/index.js';
import { createAbortError } from './abort.js';
import { buildCompanionFixInstruction } from './evidence.js';

export interface CompanionFixReviewContext {
  readonly afterFix: boolean;
  readonly fixRound?: number;
}

export async function runCompanionFixLoop<TOptions extends object>(input: {
  initialResponse: AgentResponse;
  phase1Options: TOptions;
  completeReview: (context: CompanionFixReviewContext & { implementerResponse: string }) => Promise<{
    openMustFix: CompanionFindingEvidence[];
    escalated: boolean;
    reason?: string;
  }>;
  executeFix: (attempt: {
    sequence: number;
    phase: 1;
    openMustFixCount: number;
    sessionId: string | undefined;
    options: TOptions & { sessionId: string | undefined };
    instruction: string;
  }) => Promise<AgentResponse>;
  abortSignal?: AbortSignal;
}): Promise<{
  phaseResponse: AgentResponse;
  latestSessionId: string | undefined;
  fixRounds: number;
}> {
  let latestResponse = input.initialResponse;
  let latestSessionId = input.initialResponse.sessionId;
  let latestImplementerResponse = input.initialResponse.content;
  let fixRounds = 0;
  for (;;) {
    throwIfAborted(input.abortSignal);
    let review: Awaited<ReturnType<typeof input.completeReview>>;
    try {
      review = await input.completeReview({
        implementerResponse: latestImplementerResponse,
        afterFix: fixRounds > 0,
        ...(fixRounds > 0 ? { fixRound: fixRounds } : {}),
      });
    } catch {
      if (input.abortSignal?.aborted) throw createAbortError(input.abortSignal.reason);
      return terminal(latestResponse, latestSessionId, fixRounds);
    }
    throwIfAborted(input.abortSignal);
    if (review.escalated || review.openMustFix.length === 0) {
      return terminal(latestResponse, latestSessionId, fixRounds);
    }
    const sequence = fixRounds + 2;
    let fixed: AgentResponse;
    try {
      fixed = await input.executeFix({
        sequence,
        phase: 1,
        openMustFixCount: review.openMustFix.length,
        sessionId: latestSessionId,
        options: { ...input.phase1Options, sessionId: latestSessionId },
        instruction: buildCompanionFixInstruction(review.openMustFix),
      });
    } catch {
      if (input.abortSignal?.aborted) throw createAbortError(input.abortSignal.reason);
      return terminal(latestResponse, latestSessionId, fixRounds + 1);
    }
    throwIfAborted(input.abortSignal);
    fixRounds += 1;
    if (fixed.status !== 'done') {
      return terminal(latestResponse, latestSessionId, fixRounds);
    }
    latestResponse = fixed;
    latestSessionId = fixed.sessionId ?? latestSessionId;
    latestImplementerResponse = fixed.content;
  }
}

function terminal(
  phaseResponse: AgentResponse,
  latestSessionId: string | undefined,
  fixRounds: number,
) {
  return {
    phaseResponse,
    latestSessionId,
    fixRounds,
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createAbortError(signal.reason);
}
