import type { AgentResponse, CompanionFindingEvidence } from '../../models/index.js';
import { createLogger } from '../../../shared/utils/index.js';
import { createAbortError } from './abort.js';
import { buildCompanionFixInstruction } from './evidence.js';

const log = createLogger('companion-fix-loop');

export interface CompanionFixReviewContext {
  readonly afterFix: boolean;
  readonly fixRound?: number;
}

export interface CompanionFixAttemptFailure {
  readonly stage: 'review' | 'fix';
  readonly fixRound: number;
  readonly sequence?: number;
  readonly reason: string;
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
  onAttemptFailure?: (failure: CompanionFixAttemptFailure) => void;
}): Promise<{
  phaseResponse: AgentResponse;
  latestSessionId: string | undefined;
  fixRounds: number;
  attemptFailures: readonly CompanionFixAttemptFailure[];
}> {
  let latestResponse = input.initialResponse;
  let latestSessionId = input.initialResponse.sessionId;
  let latestImplementerResponse = input.initialResponse.content;
  let fixRounds = 0;
  const attemptFailures: CompanionFixAttemptFailure[] = [];
  for (;;) {
    throwIfAborted(input.abortSignal);
    let review: Awaited<ReturnType<typeof input.completeReview>>;
    try {
      review = await input.completeReview({
        implementerResponse: latestImplementerResponse,
        afterFix: fixRounds > 0,
        ...(fixRounds > 0 ? { fixRound: fixRounds } : {}),
      });
    } catch (error) {
      if (input.abortSignal?.aborted) throw createAbortError(input.abortSignal.reason);
      recordFailure(attemptFailures, input.onAttemptFailure, {
        stage: 'review',
        fixRound: fixRounds,
        reason: errorMessage(error),
      });
      return terminal(latestResponse, latestSessionId, fixRounds, attemptFailures);
    }
    throwIfAborted(input.abortSignal);
    if (review.escalated || review.openMustFix.length === 0) {
      return terminal(latestResponse, latestSessionId, fixRounds, attemptFailures);
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
    } catch (error) {
      if (input.abortSignal?.aborted) throw createAbortError(input.abortSignal.reason);
      fixRounds += 1;
      recordFailure(attemptFailures, input.onAttemptFailure, {
        stage: 'fix',
        fixRound: fixRounds,
        sequence,
        reason: errorMessage(error),
      });
      return terminal(latestResponse, latestSessionId, fixRounds, attemptFailures);
    }
    throwIfAborted(input.abortSignal);
    fixRounds += 1;
    if (fixed.status !== 'done') {
      recordFailure(attemptFailures, input.onAttemptFailure, {
        stage: 'fix',
        fixRound: fixRounds,
        sequence,
        reason: fixed.error ?? `Companion fix returned status "${fixed.status}"`,
      });
      return terminal(latestResponse, latestSessionId, fixRounds, attemptFailures);
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
  attemptFailures: readonly CompanionFixAttemptFailure[],
) {
  return {
    phaseResponse,
    latestSessionId,
    fixRounds,
    attemptFailures,
  };
}

function recordFailure(
  failures: CompanionFixAttemptFailure[],
  onAttemptFailure: ((failure: CompanionFixAttemptFailure) => void) | undefined,
  failure: CompanionFixAttemptFailure,
): void {
  failures.push(failure);
  try {
    onAttemptFailure?.(failure);
  } catch (error) {
    log.warn('Companion attempt failure observer failed; continuing advisory loop', {
      stage: failure.stage,
      fixRound: failure.fixRound,
      sequence: failure.sequence,
      reason: errorMessage(error),
    });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createAbortError(signal.reason);
}
