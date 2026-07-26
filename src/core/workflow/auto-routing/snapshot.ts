import { createHash } from 'node:crypto';
import { ROUTING_WORK_SNAPSHOT_LOCAL_IDENTITY, type RoutingWorkSnapshot } from './contracts.js';
import { normalizeRoutingText } from './normalizer.js';
import type { FindingLedger } from '../../models/finding-types.js';
import {
  ROUTING_REMAINING_WORK_FIELD_BUDGET,
  ROUTING_REMAINING_WORK_ITEM_LIMIT,
  ROUTING_REMAINING_WORK_TOTAL_BUDGET,
} from './limits.js';

type Finding = {
  id: string;
  severity?: string;
  lifecycle?: string;
  title?: string;
  description: string;
  suggestion?: string;
  provisional?: unknown;
};

export interface BuildRoutingWorkSnapshotInput {
  goal: string;
  userInputs: string[];
  retryNote?: string;
  step: RoutingWorkSnapshot['step'] & { passPreviousResponse: boolean };
  part?: { title: string; instruction: string };
  lastOutput?: string;
  findings: {
    open: Iterable<Finding>;
    conflicts: Iterable<{ id: string; status: string; description: string }>;
  };
  previousAttemptFailed?: boolean;
  noProgress?: boolean;
  retryingSameWork?: boolean;
  sensitiveValues?: readonly string[];
}

export type RoutingFindings = BuildRoutingWorkSnapshotInput['findings'];

export function buildRoutingFindings(ledger: FindingLedger | undefined): RoutingFindings {
  if (ledger === undefined) {
    return { open: [], conflicts: [] };
  }

  return {
    open: (function* () {
      for (const finding of ledger.findings) {
        if (finding.status !== 'open') continue;
        if (finding.description === undefined) {
          throw new Error(`Open finding "${finding.id}" is missing a routing description`);
        }
        yield {
          id: finding.id,
          severity: finding.severity,
          lifecycle: finding.lifecycle,
          title: finding.title,
          description: finding.description,
          ...(finding.suggestion !== undefined ? { suggestion: finding.suggestion } : {}),
          ...(finding.provisional !== undefined ? { provisional: finding.provisional } : {}),
        };
      }
    })(),
    conflicts: (function* () {
      for (const conflict of ledger.conflicts) {
        yield { id: conflict.id, status: conflict.status, description: conflict.description };
      }
    })(),
  };
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

function addUnorderedDigestValues(hash: ReturnType<typeof createHash>, values: string[]): void {
  for (const value of values.sort()) {
    addDigestValue(hash, value);
  }
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
  const findingDigestValues: string[] = [];
  const conflictDigestValues: string[] = [];
  let totalWorkCount = 0;
  let omittedWorkCount = 0;
  let projectionClosed = false;
  const addWork = (
    work: RoutingWorkSnapshot['remainingWork'][number],
    identity?: { kind: 'finding' | 'conflict'; value: string },
  ) => {
    totalWorkCount += 1;
    if (identity === undefined) {
      addDigestValue(workHash, work);
    } else {
      const digestValue = JSON.stringify({ kind: identity.kind, id: identity.value });
      (identity.kind === 'finding' ? findingDigestValues : conflictDigestValues).push(digestValue);
    }
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
  for (const finding of input.findings.open) {
    addWork({
      source: 'finding',
      ...(finding.severity !== undefined ? { severity: finding.severity } : {}),
      ...(finding.lifecycle !== undefined ? { lifecycle: finding.lifecycle } : {}),
      ...(finding.title !== undefined ? { title: finding.title } : {}),
      description: finding.description,
      ...(finding.suggestion !== undefined ? { suggestion: finding.suggestion } : {}),
      ...(finding.provisional !== undefined ? { provisional: true } : {}),
    }, { kind: 'finding', value: finding.id });
  }
  for (const conflict of input.findings.conflicts) {
    if (conflict.status === 'active') {
      addWork({ source: 'finding', conflict: true, description: conflict.description }, { kind: 'conflict', value: conflict.id });
    }
  }
  if (input.step.passPreviousResponse && input.lastOutput !== undefined) {
    addWork({ source: 'prior-result', description: input.lastOutput });
  }
  addUnorderedDigestValues(workHash, findingDigestValues);
  addUnorderedDigestValues(workHash, conflictDigestValues);
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
