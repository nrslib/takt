export interface WorkflowExecutionIdentity {
  readonly workflow: string;
  readonly step: string;
  readonly calls: readonly WorkflowExecutionCallIdentity[];
}

export interface WorkflowExecutionCallIdentity {
  readonly workflow: string;
  readonly step: string;
  readonly kind: WorkflowResumeFrameKind;
  readonly instance: number;
}

const ROOT_KEYS = ['workflow', 'step', 'calls'] as const;
const CALL_KEYS = ['workflow', 'step', 'kind', 'instance'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function isValidCallIdentity(value: unknown): value is WorkflowExecutionCallIdentity {
  if (!isRecord(value) || !hasExactKeys(value, CALL_KEYS)) {
    return false;
  }
  return typeof value.workflow === 'string'
    && value.workflow.length > 0
    && typeof value.step === 'string'
    && value.step.length > 0
    && typeof value.kind === 'string'
    && ['agent', 'parallel', 'arpeggio', 'team_leader', 'system', 'workflow_call'].includes(value.kind)
    && Number.isInteger(value.instance)
    && (value.instance as number) > 0;
}

function isValidIdentity(value: unknown): value is WorkflowExecutionIdentity {
  if (!isRecord(value) || !hasExactKeys(value, ROOT_KEYS)) {
    return false;
  }
  return typeof value.workflow === 'string'
    && value.workflow.length > 0
    && typeof value.step === 'string'
    && value.step.length > 0
    && Array.isArray(value.calls)
    && value.calls.every(isValidCallIdentity);
}

export function serializeWorkflowExecutionIdentity(
  identity: WorkflowExecutionIdentity,
): string {
  if (!isValidIdentity(identity)) {
    throw new Error('Invalid workflow execution identity');
  }
  return JSON.stringify({
    workflow: identity.workflow,
    step: identity.step,
    calls: identity.calls.map((call) => ({
      workflow: call.workflow,
      step: call.step,
      kind: call.kind,
      instance: call.instance,
    })),
  });
}

export function parseWorkflowExecutionIdentity(
  identity: string,
): WorkflowExecutionIdentity | undefined {
  try {
    const parsed: unknown = JSON.parse(identity);
    if (!isValidIdentity(parsed)) {
      return undefined;
    }
    return serializeWorkflowExecutionIdentity(parsed) === identity ? parsed : undefined;
  } catch {
    return undefined;
  }
}
import type { WorkflowResumeFrameKind } from '../models/types.js';
