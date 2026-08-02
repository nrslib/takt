import type {
  WorkflowCallInvocationRecord,
  WorkflowResumePoint,
  WorkflowResumePointEntry,
} from './types.js';

export interface WorkflowExecutionCallIdentity {
  readonly workflow: string;
  readonly step: string;
  readonly kind: 'workflow_call';
  readonly instance: number;
}

export interface WorkflowExecutionOwnerIdentity {
  readonly workflow: string;
  readonly step: string;
  readonly owners: readonly WorkflowExecutionOwnerSegment[];
}

export type WorkflowExecutionOwnerSegment =
  | {
    readonly workflow: string;
    readonly step: string;
    readonly kind: 'agent' | 'system';
  }
  | WorkflowExecutionCallIdentity;

const CALL_KEYS = ['workflow', 'step', 'kind', 'instance'] as const;
const OWNER_ROOT_KEYS = ['workflow', 'step', 'owners'] as const;
const NON_CALL_OWNER_KEYS = ['workflow', 'step', 'kind'] as const;

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
    && value.kind === 'workflow_call'
    && Number.isSafeInteger(value.instance)
    && (value.instance as number) > 0;
}

function isValidOwnerSegment(value: unknown): value is WorkflowExecutionOwnerSegment {
  if (!isRecord(value)) {
    return false;
  }
  if (value.kind === 'workflow_call') {
    return isValidCallIdentity(value);
  }
  return hasExactKeys(value, NON_CALL_OWNER_KEYS)
    && typeof value.workflow === 'string'
    && value.workflow.length > 0
    && typeof value.step === 'string'
    && value.step.length > 0
    && (value.kind === 'agent' || value.kind === 'system');
}

function isValidOwnerIdentity(value: unknown): value is WorkflowExecutionOwnerIdentity {
  if (!isRecord(value) || !hasExactKeys(value, OWNER_ROOT_KEYS)) {
    return false;
  }
  return typeof value.workflow === 'string'
    && value.workflow.length > 0
    && typeof value.step === 'string'
    && value.step.length > 0
    && Array.isArray(value.owners)
    && value.owners.every(isValidOwnerSegment);
}

export function serializeWorkflowExecutionOwnerIdentity(
  identity: WorkflowExecutionOwnerIdentity,
): string {
  if (!isValidOwnerIdentity(identity)) {
    throw new Error('Invalid workflow execution owner identity');
  }
  return JSON.stringify({
    workflow: identity.workflow,
    step: identity.step,
    owners: identity.owners.map((owner) => owner.kind === 'workflow_call'
      ? {
          workflow: owner.workflow,
          step: owner.step,
          kind: owner.kind,
          instance: owner.instance,
        }
      : {
          workflow: owner.workflow,
          step: owner.step,
          kind: owner.kind,
        }),
  });
}

export function parseWorkflowExecutionOwnerIdentity(
  identity: string,
): WorkflowExecutionOwnerIdentity | undefined {
  try {
    const parsed: unknown = JSON.parse(identity);
    if (!isValidOwnerIdentity(parsed)) {
      return undefined;
    }
    return serializeWorkflowExecutionOwnerIdentity(parsed) === identity ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function workflowReference(entry: WorkflowResumePointEntry): string {
  return entry.workflow_ref ?? entry.workflow;
}

export function buildWorkflowExecutionOwnerIdentity(
  workflow: string,
  step: string,
  ownerPath: readonly WorkflowResumePointEntry[],
): WorkflowExecutionOwnerIdentity {
  const identity: WorkflowExecutionOwnerIdentity = {
    workflow,
    step,
    owners: ownerPath.map((entry) => {
      const ownerWorkflow = workflowReference(entry);
      if (entry.kind !== 'workflow_call') {
        return {
          workflow: ownerWorkflow,
          step: entry.step,
          kind: entry.kind,
        };
      }
      if (entry.call_instance === undefined) {
        throw new Error(`Workflow-call resume entry "${entry.step}" requires a positive call_instance`);
      }
      return {
        workflow: ownerWorkflow,
        step: entry.step,
        kind: entry.kind,
        instance: entry.call_instance,
      };
    }),
  };
  if (!isValidOwnerIdentity(identity)) {
    throw new Error('Invalid workflow execution owner identity');
  }
  return identity;
}

function buildStackInvocationIdentity(
  entry: WorkflowResumePointEntry,
  stackPrefix: readonly WorkflowResumePointEntry[],
): string {
  return serializeWorkflowExecutionOwnerIdentity(buildWorkflowExecutionOwnerIdentity(
    workflowReference(entry),
    entry.step,
    stackPrefix,
  ));
}

export function validateWorkflowCallInvocationRecord(
  identity: string,
  record: WorkflowCallInvocationRecord,
): void {
  if (parseWorkflowExecutionOwnerIdentity(identity) === undefined) {
    throw new Error(`Invalid workflow-call invocation identity "${identity}"`);
  }
  if (!Number.isSafeInteger(record.call_instance) || record.call_instance < 1) {
    throw new Error(`Workflow-call invocation "${identity}" requires a positive call_instance`);
  }
  if (record.child_workflow_ref.length === 0) {
    throw new Error(`Workflow-call invocation "${identity}" requires a child workflow reference`);
  }
}

export function validateWorkflowResumePointInvocationSemantics(
  resumePoint: WorkflowResumePoint,
): void {
  for (const [identity, record] of Object.entries(resumePoint.workflow_call_invocations)) {
    validateWorkflowCallInvocationRecord(identity, record);
  }

  resumePoint.stack.forEach((entry, index) => {
    if (entry.kind !== 'workflow_call') {
      return;
    }
    if (entry.call_instance === undefined) {
      throw new Error(`Workflow-call resume entry "${entry.step}" requires a positive call_instance`);
    }
    const persistedStepIteration = entry.step_iterations?.[entry.step];
    if (persistedStepIteration !== undefined && persistedStepIteration !== entry.call_instance) {
      throw new Error(`Workflow-call step iteration does not match resume entry "${entry.step}"`);
    }
    const identity = buildStackInvocationIdentity(entry, resumePoint.stack.slice(0, index));
    const record = resumePoint.workflow_call_invocations[identity];
    if (record?.call_instance !== entry.call_instance) {
      throw new Error(`Workflow-call invocation identity does not match resume entry "${entry.step}"`);
    }
    const childEntry = resumePoint.stack[index + 1];
    if (childEntry !== undefined && record.child_workflow_ref !== workflowReference(childEntry)) {
      throw new Error(`Workflow-call child reference does not match resume entry "${entry.step}"`);
    }
  });
}
