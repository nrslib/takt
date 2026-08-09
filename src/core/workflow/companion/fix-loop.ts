import type { AgentResponse, CompanionFindingEvidence } from '../../models/index.js';
import { createAbortError } from './abort.js';
import { buildCompanionFixInstruction } from './evidence.js';

export async function runCompanionFixLoop<TOptions extends object>(input: {
  initialResponse: AgentResponse;
  phase1Options: TOptions;
  completeReview: (context: { implementerResponse: string }) => Promise<{
    openMustFix: CompanionFindingEvidence[];
    escalated: boolean;
    reason?: string;
  }>;
  executeFix: (attempt: {
    sequence: number;
    phase: 1;
    sessionId: string | undefined;
    options: TOptions & { sessionId: string | undefined };
    instruction: string;
  }) => Promise<AgentResponse>;
  abortSignal?: AbortSignal;
}): Promise<{
  phaseResponse: AgentResponse;
  latestSessionId: string | undefined;
  fixRounds: number;
  escalated: boolean;
  escalationReason?: string;
}> {
  let latestSessionId = input.initialResponse.sessionId;
  let latestImplementerResponse = input.initialResponse.content;
  let fixRounds = 0;
  for (;;) {
    throwIfAborted(input.abortSignal);
    const review = await input.completeReview({ implementerResponse: latestImplementerResponse });
    throwIfAborted(input.abortSignal);
    if (review.escalated || review.openMustFix.length === 0) {
      return terminal(
        input.initialResponse,
        latestSessionId,
        fixRounds,
        review.escalated,
        review.reason,
      );
    }
    const sequence = fixRounds + 2;
    const fixed = await input.executeFix({
      sequence,
      phase: 1,
      sessionId: latestSessionId,
      options: { ...input.phase1Options, sessionId: latestSessionId },
      instruction: buildCompanionFixInstruction(review.openMustFix),
    });
    throwIfAborted(input.abortSignal);
    latestSessionId = fixed.sessionId ?? latestSessionId;
    fixRounds += 1;
    if (fixed.status !== 'done') {
      return terminal(fixed, latestSessionId, fixRounds, false);
    }
    latestImplementerResponse = fixed.content;
  }
}

function terminal(
  phaseResponse: AgentResponse,
  latestSessionId: string | undefined,
  fixRounds: number,
  escalated: boolean,
  escalationReason?: string,
) {
  return {
    phaseResponse,
    latestSessionId,
    fixRounds,
    escalated,
    ...(escalationReason === undefined ? {} : { escalationReason }),
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createAbortError(signal.reason);
}
