import type { MorePartsResponse } from '../../../agents/agent-usecases.js';
import type { CompanionFinding, PartDefinition, PartResult } from '../../models/types.js';
import { createAbortScope, type AbortScope } from './abort-signal.js';
import {
  createTeamLeaderPartCancellation,
  isTeamLeaderPartCancellation,
} from './team-leader-part-cancellation.js';
import {
  TeamLeaderExecutionTerminalGate,
  type TeamLeaderExecutionPublicationFence,
} from './team-leader-execution-terminal.js';
import { isProviderStreamParseError } from '../../../shared/types/agent-failure.js';

type DeepReadonly<T> = T extends object
  ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
  : T;

interface TeamLeaderFeedbackArgs {
  readonly partResults: readonly DeepReadonly<PartResult>[];
  readonly latestBatchResults: readonly DeepReadonly<PartResult>[];
  readonly completedPartResults: readonly DeepReadonly<PartResult>[];
  readonly plannedParts: readonly DeepReadonly<PartDefinition>[];
  readonly scheduledIds: readonly string[];
  readonly cancellablePartIds: readonly string[];
  readonly abortSignal: AbortSignal;
  readonly companionFindings?: readonly DeepReadonly<CompanionFinding>[];
}

export interface TeamLeaderExecutionOptions {
  initialParts: PartDefinition[];
  maxConcurrency: number;
  abortSignal?: AbortSignal;
  runPart: (
    part: PartDefinition,
    partIndex: number,
    publicationFence: TeamLeaderExecutionPublicationFence,
    abortSignal: AbortSignal,
  ) => Promise<PartResult>;
  requestMoreParts: (args: TeamLeaderFeedbackArgs) => Promise<MorePartsResponse>;
  reviewCompletion?: (
    args: Omit<TeamLeaderFeedbackArgs, 'companionFindings'>,
  ) => Promise<readonly CompanionFinding[]>;
  onPartQueued?: (part: DeepReadonly<PartDefinition>, partIndex: number) => void;
  onPartCompleted?: (result: DeepReadonly<PartResult>) => void;
  onPlanningDone?: (feedback: { reason: string; plannedParts: number; completedParts: number }) => void;
  onPlanningNoNewParts?: (feedback: { reason: string; plannedParts: number; completedParts: number }) => void;
  onPartsAdded?: (feedback: {
    parts: readonly DeepReadonly<PartDefinition>[];
    reason: string;
    totalPlanned: number;
  }) => void;
  onPlanningError?: (error: unknown) => void;
  onCompletionPlanningFailure?: (error: unknown) => void;
  onTerminalError?: (error: unknown) => void;
}

interface RunningPart {
  partId: string;
  abortScope: AbortScope;
  settlement?: PartSettlement;
  promise: Promise<PartSettlement>;
}

interface CompletedPartSettlement {
  partId: string;
  kind: 'completed';
  result: PartResult;
}

interface CancelledPartSettlement {
  partId: string;
  kind: 'cancelled';
}

type PartSettlement = CompletedPartSettlement | CancelledPartSettlement;

export interface TeamLeaderExecutionResult {
  plannedParts: PartDefinition[];
  partResults: PartResult[];
}

export async function runTeamLeaderExecution(
  options: TeamLeaderExecutionOptions,
): Promise<TeamLeaderExecutionResult> {
  options.abortSignal?.throwIfAborted();
  const queue: PartDefinition[] = structuredClone(options.initialParts);
  const plannedParts: PartDefinition[] = structuredClone(options.initialParts);
  const partResults: PartResult[] = [];
  const running = new Map<string, RunningPart>();
  const scheduledIds = new Set(options.initialParts.map((part) => part.id));
  const terminalGate = new TeamLeaderExecutionTerminalGate(options.onTerminalError);

  let nextPartIndex = 0;
  let leaderDone = false;
  let completionReviewAfterPlanningFailure = false;
  let planningFailure: unknown;
  let latestBatchStart = 0;
  let pendingTerminalFeedback: MorePartsResponse | undefined;

  const cancellablePartIds = (): string[] => [
    ...queue.map((part) => part.id),
    ...[...running.values()]
      .filter((part) => part.settlement === undefined)
      .map((part) => part.partId),
  ];

  const publishPartCompletion = (settlement: PartSettlement): boolean => {
    const runningPart = running.get(settlement.partId);
    if (runningPart === undefined) {
      return false;
    }
    running.delete(settlement.partId);
    runningPart.abortScope.dispose();
    if (settlement.kind === 'cancelled') {
      const retainedPlans = plannedParts.filter((part) => part.id !== settlement.partId);
      plannedParts.splice(0, plannedParts.length, ...retainedPlans);
      return false;
    }
    terminalGate.assertRunning('part.settlement');
    partResults.push(settlement.result);
    terminalGate.assertRunning('part.completed');
    options.onPartCompleted?.(structuredClone(settlement.result));
    return true;
  };

  const publishSettledParts = (): PartSettlement[] => {
    const settlements = [...running.values()]
      .flatMap((part) => part.settlement === undefined ? [] : [part.settlement]);
    for (const settlement of settlements) {
      publishPartCompletion(settlement);
    }
    return settlements;
  };

  const applyCancellations = (cancelPartIds: readonly string[]): void => {
    const queuedCancellationIds = new Set(
      cancelPartIds.filter((partId) => queue.some((part) => part.id === partId)),
    );
    const runningCancellationIds = new Set(
      cancelPartIds.filter((partId) => {
        const runningPart = running.get(partId);
        return runningPart !== undefined && runningPart.settlement === undefined;
      }),
    );
    if (queuedCancellationIds.size === 0 && runningCancellationIds.size === 0) {
      return;
    }

    const retainedQueue = queue.filter((part) => !queuedCancellationIds.has(part.id));
    queue.splice(0, queue.length, ...retainedQueue);
    if (queuedCancellationIds.size > 0) {
      const retainedPlans = plannedParts.filter((part) => !queuedCancellationIds.has(part.id));
      plannedParts.splice(0, plannedParts.length, ...retainedPlans);
    }
    for (const partId of runningCancellationIds) {
      running.get(partId)?.abortScope.abort(createTeamLeaderPartCancellation(partId));
    }
  };

  const tryPlanMoreParts = async (): Promise<void> => {
    terminalGate.assertRunning('feedback.dequeue');
    options.abortSignal?.throwIfAborted();
    if (leaderDone) {
      return;
    }
    publishSettledParts();
    const latestBatchResults = partResults.slice(latestBatchStart);
    if (latestBatchResults.some((result) => result.response.status === 'rate_limited')) {
      leaderDone = true;
      return;
    }

    const feedbackAbortScope = createAbortScope(options.abortSignal);
    const buildFeedbackArgs = (
      companionFindings?: readonly CompanionFinding[],
    ): TeamLeaderFeedbackArgs => ({
      partResults: structuredClone(partResults),
      latestBatchResults: structuredClone(latestBatchResults),
      completedPartResults: structuredClone(partResults.slice(0, latestBatchStart)),
      plannedParts: structuredClone(plannedParts),
      scheduledIds: [...scheduledIds],
      cancellablePartIds: cancellablePartIds(),
      abortSignal: feedbackAbortScope.signal,
      ...(companionFindings === undefined
        ? {}
        : { companionFindings: structuredClone(companionFindings) }),
    });
    const deferTerminalFeedback = (feedback: MorePartsResponse): boolean => {
      if (
        !feedback.done
        || options.reviewCompletion === undefined
        || (queue.length === 0 && running.size === 0)
      ) {
        return false;
      }
      pendingTerminalFeedback = structuredClone(feedback);
      return true;
    };
    let feedbackPromise: Promise<MorePartsResponse> | undefined;
    let planningCorrectionForCompanionFindings = false;
    let reviewCompletionFailed = false;

    try {
      let feedback: MorePartsResponse;
      if (pendingTerminalFeedback === undefined) {
        feedbackPromise = options.requestMoreParts(buildFeedbackArgs());
        const terminalSettlement = Promise.race(
          [...running.values()].map((part) => (
            part.promise.then(() => new Promise<never>(() => {}))
          )),
        );
        feedback = await Promise.race([feedbackPromise, terminalSettlement]);
      } else {
        feedback = pendingTerminalFeedback;
        pendingTerminalFeedback = undefined;
      }
      terminalGate.assertRunning('feedback.provider_result');
      options.abortSignal?.throwIfAborted();

      publishSettledParts();
      applyCancellations(feedback.cancelPartIds);

      if (deferTerminalFeedback(feedback)) {
        return;
      }

      const hasUnscheduledPart = (candidate: MorePartsResponse): boolean => (
        candidate.parts.some((part) => !scheduledIds.has(part.id))
      );
      const isTerminalFeedback = (candidate: MorePartsResponse): boolean => (
        candidate.done || !hasUnscheduledPart(candidate)
      );
      while (
        queue.length === 0
        && running.size === 0
        && isTerminalFeedback(feedback)
        && options.reviewCompletion !== undefined
      ) {
        let findings: readonly CompanionFinding[];
        try {
          findings = await options.reviewCompletion(buildFeedbackArgs());
        } catch (error) {
          reviewCompletionFailed = true;
          throw error;
        }
        if (findings.length === 0) {
          break;
        }
        planningCorrectionForCompanionFindings = true;
        feedback = await options.requestMoreParts(buildFeedbackArgs(findings));
        terminalGate.assertRunning('feedback.companion_provider_result');
        options.abortSignal?.throwIfAborted();
        publishSettledParts();
        applyCancellations(feedback.cancelPartIds);
        if (feedback.done || !hasUnscheduledPart(feedback)) {
          throw new Error('Team Companion correction planning did not schedule a correction part');
        }
        planningCorrectionForCompanionFindings = false;
      }

      if (feedback.done) {
        terminalGate.assertRunning('feedback.planning_done');
        options.onPlanningDone?.({
          reason: feedback.reasoning,
          plannedParts: plannedParts.length,
          completedParts: partResults.length,
        });
        leaderDone = true;
        return;
      }

      const newParts: PartDefinition[] = [];
      for (const newPart of feedback.parts) {
        if (scheduledIds.has(newPart.id)) {
          continue;
        }
        scheduledIds.add(newPart.id);
        newParts.push(structuredClone(newPart));
      }

      if (newParts.length === 0) {
        if (queue.length > 0 || running.size > 0) {
          return;
        }
        options.onPlanningNoNewParts?.({
          reason: feedback.reasoning,
          plannedParts: plannedParts.length,
          completedParts: partResults.length,
        });
        leaderDone = true;
        return;
      }

      terminalGate.assertRunning('feedback.parts_added');
      plannedParts.push(...newParts);
      queue.push(...newParts);
      options.onPartsAdded?.({
        parts: structuredClone(newParts),
        reason: feedback.reasoning,
        totalPlanned: plannedParts.length,
      });
      latestBatchStart = partResults.length;
    } catch (error) {
      feedbackAbortScope.abort(error);
      void feedbackPromise?.catch(() => undefined);
      if (options.abortSignal?.aborted) {
        throw error;
      }
      if (isProviderStreamParseError(error)) {
        throw error;
      }
      if (reviewCompletionFailed) {
        throw error;
      }
      options.onPlanningError?.(error);
      if (planningCorrectionForCompanionFindings) {
        options.onCompletionPlanningFailure?.(error);
      } else {
        completionReviewAfterPlanningFailure = true;
        planningFailure = error;
      }
      leaderDone = true;
    } finally {
      feedbackAbortScope.dispose();
    }
  };

  try {
    while (queue.length > 0 || running.size > 0 || !leaderDone) {
      while (queue.length > 0 && running.size < options.maxConcurrency) {
        terminalGate.assertRunning('part.dequeue');
        options.abortSignal?.throwIfAborted();
        const part = queue.shift();
        if (!part) {
          break;
        }
        const partIndex = nextPartIndex;
        nextPartIndex += 1;
        terminalGate.assertRunning('part.queued');
        options.onPartQueued?.(structuredClone(part), partIndex);
        options.abortSignal?.throwIfAborted();
        const abortScope = createAbortScope(options.abortSignal);
        const partSnapshot = structuredClone(part);
        const promise = options.runPart(
          structuredClone(partSnapshot),
          partIndex,
          terminalGate,
          abortScope.signal,
        )
          .then((result): PartSettlement => {
            if (result.part.id !== partSnapshot.id) {
              throw new Error(
                `Team leader part result identity mismatch: expected "${partSnapshot.id}", received "${result.part.id}"`,
              );
            }
            return { partId: partSnapshot.id, kind: 'completed', result };
          })
          .catch((error): PartSettlement => {
            if (isTeamLeaderPartCancellation(error)) {
              return { partId: partSnapshot.id, kind: 'cancelled' };
            }
            throw terminalGate.latch(error);
          });
        const runningPart: RunningPart = {
          partId: part.id,
          abortScope,
          promise,
        };
        runningPart.promise = promise.then((settlement) => {
          runningPart.settlement = settlement;
          return settlement;
        });
        running.set(part.id, runningPart);
      }

      if (running.size > 0) {
        await Promise.race([...running.values()].map((part) => part.promise));
        const settledParts = publishSettledParts();
        const publishedSuccessfulPart = settledParts.some((settlement) => (
          settlement.kind === 'completed' && settlement.result.response.status === 'done'
        ));
        if (options.abortSignal?.aborted) {
          options.abortSignal.throwIfAborted();
        }

        if (publishedSuccessfulPart) {
          await tryPlanMoreParts();
        } else if (queue.length === 0 && running.size === 0) {
          await tryPlanMoreParts();
        }
        continue;
      }

      if (leaderDone) {
        break;
      }

      await tryPlanMoreParts();
    }
  } catch (error) {
    const terminalError = terminalGate.latch(error);
    await Promise.allSettled([...running.values()].map((part) => part.promise));
    for (const runningPart of running.values()) {
      runningPart.abortScope.dispose();
    }
    throw terminalError;
  }

  if (completionReviewAfterPlanningFailure && options.reviewCompletion !== undefined) {
    const reviewAbortScope = createAbortScope(options.abortSignal);
    try {
      const findings = await options.reviewCompletion({
        partResults: structuredClone(partResults),
        latestBatchResults: structuredClone(partResults.slice(latestBatchStart)),
        completedPartResults: structuredClone(partResults.slice(0, latestBatchStart)),
        plannedParts: structuredClone(plannedParts),
        scheduledIds: [...scheduledIds],
        cancellablePartIds: cancellablePartIds(),
        abortSignal: reviewAbortScope.signal,
      });
      if (findings.length > 0) {
        options.onCompletionPlanningFailure?.(planningFailure);
      }
    } finally {
      reviewAbortScope.dispose();
    }
  }

  return {
    plannedParts,
    partResults,
  };
}
