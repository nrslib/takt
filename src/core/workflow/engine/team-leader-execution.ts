import type { MorePartsResponse } from '../../../agents/agent-usecases.js';
import type { PartDefinition, PartResult } from '../../models/types.js';
import { DEFAULT_TEAM_LEADER_MAX_TOTAL_PARTS } from '../../../shared/constants.js';
import { isPlanningBudgetError } from './team-leader-budget-errors.js';

export interface TeamLeaderExecutionOptions {
  initialParts: PartDefinition[];
  maxConcurrency: number;
  refillThreshold: number;
  maxTotalParts?: number;
  abortSignal?: AbortSignal;
  runPart: (part: PartDefinition, partIndex: number) => Promise<PartResult>;
  requestMoreParts: (
    args: {
      partResults: PartResult[];
      scheduledIds: string[];
      remainingPartBudget: number;
      unfinishedScheduledPartCount: number;
    }
  ) => Promise<MorePartsResponse>;
  onPartQueued?: (part: PartDefinition, partIndex: number) => void;
  onPartCompleted?: (result: PartResult) => void;
  onPlanningDone?: (feedback: { reason: string; plannedParts: number; completedParts: number }) => void;
  onPlanningNoNewParts?: (feedback: { reason: string; plannedParts: number; completedParts: number }) => void;
  onPartsAdded?: (feedback: { parts: PartDefinition[]; reason: string; totalPlanned: number }) => void;
  onPlanningError?: (error: unknown) => void;
}

interface RunningPart {
  partId: string;
  result: PartResult;
}

export interface TeamLeaderExecutionResult {
  plannedParts: PartDefinition[];
  partResults: PartResult[];
}

export async function runTeamLeaderExecution(
  options: TeamLeaderExecutionOptions,
): Promise<TeamLeaderExecutionResult> {
  options.abortSignal?.throwIfAborted();
  const maxTotalParts = options.maxTotalParts ?? DEFAULT_TEAM_LEADER_MAX_TOTAL_PARTS;
  if (options.initialParts.length > maxTotalParts) {
    throw new Error(`Initial team leader parts exceed max_total_parts: ${options.initialParts.length} > ${maxTotalParts}`);
  }

  const queue: PartDefinition[] = [...options.initialParts];
  const plannedParts: PartDefinition[] = [...options.initialParts];
  const partResults: PartResult[] = [];
  const running = new Map<string, Promise<RunningPart>>();
  const scheduledIds = new Set(options.initialParts.map((part) => part.id));

  let nextPartIndex = 0;
  let leaderDone = false;
  let deferredDoneReason: string | undefined;

  const tryPlanMoreParts = async (): Promise<void> => {
    options.abortSignal?.throwIfAborted();
    if (leaderDone) {
      return;
    }

    if (deferredDoneReason && plannedParts.length === partResults.length && partResults.every(isSuccessfulPartResult)) {
      options.onPlanningDone?.({
        reason: deferredDoneReason,
        plannedParts: plannedParts.length,
        completedParts: partResults.length,
      });
      leaderDone = true;
      return;
    }

    const remainingPartBudget = maxTotalParts - plannedParts.length;
    if (remainingPartBudget <= 0) {
      leaderDone = true;
      return;
    }

    try {
      const feedback = await options.requestMoreParts({
        partResults,
        scheduledIds: [...scheduledIds],
        remainingPartBudget,
        unfinishedScheduledPartCount: plannedParts.length - partResults.length,
      });
      options.abortSignal?.throwIfAborted();

      if (feedback.done) {
        if (plannedParts.length > partResults.length) {
          deferredDoneReason = feedback.reasoning;
          return;
        }
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
        newParts.push(newPart);
      }

      if (newParts.length === 0) {
        if (plannedParts.length > partResults.length) {
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

      assertPlannedPartsWithinLimit(plannedParts.length, newParts.length, maxTotalParts);
      plannedParts.push(...newParts);
      queue.push(...newParts);
      deferredDoneReason = undefined;
      options.onPartsAdded?.({
        parts: newParts,
        reason: feedback.reasoning,
        totalPlanned: plannedParts.length,
      });
    } catch (error) {
      if (options.abortSignal?.aborted) {
        throw error;
      }
      if (isPlanningBudgetError(error)) {
        throw error;
      }
      options.onPlanningError?.(error);
      leaderDone = true;
    }
  };

  while (queue.length > 0 || running.size > 0 || !leaderDone) {
    while (queue.length > 0 && running.size < options.maxConcurrency) {
      options.abortSignal?.throwIfAborted();
      const part = queue.shift();
      if (!part) {
        break;
      }
      const partIndex = nextPartIndex;
      nextPartIndex += 1;
      options.onPartQueued?.(part, partIndex);
      options.abortSignal?.throwIfAborted();
      const runningPart = options.runPart(part, partIndex).then((result) => ({ partId: part.id, result }));
      running.set(part.id, runningPart);
    }

    if (running.size > 0) {
      const completed = await Promise.race(running.values());
      running.delete(completed.partId);
      partResults.push(completed.result);
      options.onPartCompleted?.(completed.result);
      if (options.abortSignal?.aborted) {
        if (queue.length > 0 || running.size > 0) {
          options.abortSignal.throwIfAborted();
        }
        leaderDone = true;
        continue;
      }

      if (queue.length <= options.refillThreshold) {
        await tryPlanMoreParts();
      }
      continue;
    }

    if (leaderDone) {
      break;
    }

    await tryPlanMoreParts();
  }

  return { plannedParts, partResults };
}

function isSuccessfulPartResult(result: PartResult): boolean {
  return result.response.status === 'done';
}

function assertPlannedPartsWithinLimit(
  currentPlannedCount: number,
  newPartCount: number,
  maxTotalParts: number,
): void {
  const totalPlannedParts = currentPlannedCount + newPartCount;
  if (totalPlannedParts > maxTotalParts) {
    throw new Error(`Team leader planned parts exceed max_total_parts: ${totalPlannedParts} > ${maxTotalParts}`);
  }
}
