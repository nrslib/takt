import type { WorkflowResumePointEntry } from '../models/types.js';

export interface WorkflowExecutionScope {
  readonly kind: 'workflow_execution_scope';
  readonly stack: readonly WorkflowResumePointEntry[];
}

export interface WorkflowEventAttribution {
  readonly iteration: number;
  readonly scope: WorkflowExecutionScope;
}

function snapshotEntry(entry: WorkflowResumePointEntry): WorkflowResumePointEntry {
  const stepIterations = entry.step_iterations === undefined
    ? undefined
    : Object.freeze({ ...entry.step_iterations });
  return Object.freeze({
    ...entry,
    ...(stepIterations === undefined ? {} : { step_iterations: stepIterations }),
  });
}

export function snapshotWorkflowExecutionScope(
  stack: readonly WorkflowResumePointEntry[] | undefined,
): WorkflowExecutionScope {
  return Object.freeze({
    kind: 'workflow_execution_scope',
    stack: Object.freeze((stack ?? []).map(snapshotEntry)),
  });
}

export function workflowCallPathFromStack(
  stack: readonly WorkflowResumePointEntry[],
): WorkflowResumePointEntry[] {
  return stack
    .filter((entry) => entry.kind === 'workflow_call')
    .map(snapshotEntry);
}

export function workflowOwnerPathFromStack(
  stack: readonly WorkflowResumePointEntry[],
): WorkflowResumePointEntry[] {
  return stack.map(snapshotEntry);
}

export function isWorkflowExecutionScope(value: unknown): value is WorkflowExecutionScope {
  return typeof value === 'object'
    && value !== null
    && (value as { kind?: unknown }).kind === 'workflow_execution_scope'
    && Array.isArray((value as { stack?: unknown }).stack);
}

export function requireWorkflowEventAttribution(
  attribution: WorkflowEventAttribution | undefined,
  event: 'step:report' | 'findings:ledger',
): WorkflowEventAttribution {
  if (attribution === undefined) {
    throw new Error(`${event} event requires explicit iteration and execution scope`);
  }
  return attribution;
}

function deepFreeze(value: unknown, visited: WeakSet<object>): void {
  if (typeof value !== 'object' || value === null || visited.has(value)) {
    return;
  }
  visited.add(value);
  for (const property of Reflect.ownKeys(value)) {
    deepFreeze(Reflect.get(value, property), visited);
  }
  Object.freeze(value);
}

export function snapshotWorkflowEventValue<T>(value: T): T {
  const snapshot = structuredClone(value);
  deepFreeze(snapshot, new WeakSet<object>());
  return snapshot;
}
