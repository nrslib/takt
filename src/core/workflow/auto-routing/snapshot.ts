import { createHash } from 'node:crypto';
import { ROUTING_WORK_SNAPSHOT_LOCAL_IDENTITY, type RoutingWorkSnapshot } from './contracts.js';
import { normalizeRoutingText } from './normalizer.js';
import {
  ROUTING_REMAINING_WORK_FIELD_BUDGET,
  ROUTING_REMAINING_WORK_ITEM_LIMIT,
  ROUTING_REMAINING_WORK_TOTAL_BUDGET,
} from './limits.js';

export interface BuildRoutingWorkSnapshotInput {
  goal: string;
  userInputs: string[];
  retryNote?: string;
  step: RoutingWorkSnapshot['step'] & { passPreviousResponse: boolean };
  part?: { title: string; instruction: string };
  lastOutput?: string;
  previousAttemptFailed?: boolean;
  noProgress?: boolean;
  retryingSameWork?: boolean;
  sensitiveValues?: readonly string[];
}

function projectWorkForSnapshot(
  work: RoutingWorkSnapshot['remainingWork'][number],
  sensitiveValues: readonly string[],
): RoutingWorkSnapshot['remainingWork'][number] {
  return {
    ...work,
    description: normalizeRoutingText(work.description, ROUTING_REMAINING_WORK_FIELD_BUDGET, sensitiveValues),
    ...(work.title !== undefined
      ? { title: normalizeRoutingText(work.title, ROUTING_REMAINING_WORK_FIELD_BUDGET, sensitiveValues) }
      : {}),
    ...(work.suggestion !== undefined
      ? { suggestion: normalizeRoutingText(work.suggestion, ROUTING_REMAINING_WORK_FIELD_BUDGET, sensitiveValues) }
      : {}),
  };
}

function appendBoundedWork(
  target: Array<RoutingWorkSnapshot['remainingWork'][number]>,
  work: RoutingWorkSnapshot['remainingWork'][number],
  totalSize: { value: number },
  sensitiveValues: readonly string[],
): boolean {
  if (target.length >= ROUTING_REMAINING_WORK_ITEM_LIMIT) return false;
  const projected = projectWorkForSnapshot(work, sensitiveValues);
  const size = JSON.stringify(projected).length;
  if (totalSize.value + size > ROUTING_REMAINING_WORK_TOTAL_BUDGET) return false;
  target.push(projected);
  totalSize.value += size;
  return true;
}

function addDigestValue(hash: ReturnType<typeof createHash>, value: unknown): void {
  hash.update(JSON.stringify(value));
  hash.update('\n');
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Reflect.ownKeys(value)) {
      deepFreeze((value as Record<PropertyKey, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

export function buildRoutingWorkSnapshot(input: BuildRoutingWorkSnapshotInput): RoutingWorkSnapshot {
  const sensitiveValues = [...new Set(input.sensitiveValues ?? [])];
  const step = {
    name: input.step.name,
    tags: [...input.step.tags],
    ...(input.step.personaKey !== undefined ? { personaKey: input.step.personaKey } : {}),
    ...(input.step.instruction !== undefined ? { instruction: input.step.instruction } : {}),
    stepType: input.step.stepType,
    ...(input.step.edit !== undefined ? { edit: input.step.edit } : {}),
  };
  const remainingWork: Array<RoutingWorkSnapshot['remainingWork'][number]> = [];
  const totalSize = { value: 0 };
  const workHash = createHash('sha256');
  let totalWorkCount = 0;
  let omittedWorkCount = 0;
  let projectionClosed = false;
  const addWork = (
    work: RoutingWorkSnapshot['remainingWork'][number],
  ) => {
    totalWorkCount += 1;
    addDigestValue(workHash, work);
    if (!projectionClosed) {
      projectionClosed = !appendBoundedWork(remainingWork, work, totalSize, sensitiveValues);
    }
    if (projectionClosed && remainingWork.length < totalWorkCount) {
      omittedWorkCount += 1;
    }
  };
  for (const description of input.userInputs) addWork({ source: 'task', description });
  if (input.retryNote !== undefined) addWork({ source: 'task', description: input.retryNote });
  if (input.part !== undefined) addWork({ source: 'team-part', title: input.part.title, description: input.part.instruction });
  if (input.step.passPreviousResponse && input.lastOutput !== undefined) {
    addWork({ source: 'prior-result', description: input.lastOutput });
  }
  const snapshot: RoutingWorkSnapshot = {
    goal: input.goal,
    step,
    remainingWork,
    progress: {
      previousAttemptFailed: input.previousAttemptFailed === true,
      noProgress: input.noProgress === true,
      retryingSameWork: input.retryingSameWork === true,
    },
  };
  Object.defineProperty(snapshot, ROUTING_WORK_SNAPSHOT_LOCAL_IDENTITY, {
    value: deepFreeze({
      workDigest: workHash.digest('hex'),
      totalWorkCount,
      omittedWorkCount,
      sensitiveValues,
    }),
    enumerable: false,
  });
  return deepFreeze(snapshot);
}
