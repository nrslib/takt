import type { MorePartsResponse } from '../agent-usecases.js';
import type { PartDefinition, PartResult } from '../../models/types.js';

const DEFAULT_MAX_TOTAL_PARTS = 20;

export interface TeamLeaderExecutionOptions {
  initialParts: PartDefinition[];
  maxConcurrency: number;
  refillThreshold: number;
  maxTotalParts?: number;
  runPart: (part: PartDefinition, partIndex: number) => Promise<PartResult>;
  requestMoreParts: (
    args: {
      partResults: PartResult[];
      scheduledIds: string[];
      remainingPartBudget: number;
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
  const maxTotalParts = options.maxTotalParts ?? DEFAULT_MAX_TOTAL_PARTS;
  const queue: PartDefinition[] = [...options.initialParts];
  const plannedParts: PartDefinition[] = [...options.initialParts];
  const partResults: PartResult[] = [];
  const running = new Map<string, Promise<RunningPart>>();
  const scheduledIds = new Set(options.initialParts.map((part) => part.id));

  let nextPartIndex = 0;
  let leaderDone = false;

  const tryPlanMoreParts = async (): Promise<void> => {
    if (leaderDone) {
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
      });

      if (feedback.done) {
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
        options.onPlanningNoNewParts?.({
          reason: feedback.reasoning,
          plannedParts: plannedParts.length,
          completedParts: partResults.length,
        });
        leaderDone = true;
        return;
      }

      plannedParts.push(...newParts);
      queue.push(...newParts);
      options.onPartsAdded?.({
        parts: newParts,
        reason: feedback.reasoning,
        totalPlanned: plannedParts.length,
      });
    } catch (error) {
      options.onPlanningError?.(error);
      leaderDone = true;
    }
  };

  while (queue.length > 0 || running.size > 0 || !leaderDone) {
    while (queue.length > 0 && running.size < options.maxConcurrency) {
      const part = queue.shift();
      if (!part) {
        break;
      }
      const partIndex = nextPartIndex;
      nextPartIndex += 1;
      options.onPartQueued?.(part, partIndex);
      const runningPart = options.runPart(part, partIndex).then((result) => ({ partId: part.id, result }));
      running.set(part.id, runningPart);
    }

    if (running.size > 0) {
      const completed = await Promise.race(running.values());
      running.delete(completed.partId);
      partResults.push(completed.result);
      options.onPartCompleted?.(completed.result);

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
