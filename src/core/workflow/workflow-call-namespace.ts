import { createHash } from 'node:crypto';
import {
  parseWorkflowExecutionOwnerIdentity,
  type WorkflowExecutionOwnerIdentity,
} from '../models/workflow-resume-contract.js';

interface WorkflowCallStorageKey {
  readonly scopeDigest: string;
  readonly callInstance: number | '*';
}

const WORKFLOW_CALL_STORAGE_KEY_PATTERN = /^call-([0-9a-f]{64})-([1-9]\d*|\*)$/;
const STORAGE_SCOPE_DOMAIN = 'takt.workflow-call.storage-scope';
export const MAX_WORKFLOW_CALL_STORAGE_KEY_BYTES = 86;

export function isWorkflowCallNamespaceSegment(segment: string): boolean {
  return parseWorkflowCallNamespaceSegment(segment) !== undefined;
}

function canonicalOwnerIdentity(identity: WorkflowExecutionOwnerIdentity): object {
  return {
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
  };
}

function digestCanonicalJson(domain: string, payload: object): string {
  return createHash('sha256').update(JSON.stringify({ domain, payload })).digest('hex');
}

function buildStorageKey(
  invocation: WorkflowExecutionOwnerIdentity,
  childWorkflow: string,
  callInstance: number | '*',
): WorkflowCallStorageKey {
  return {
    scopeDigest: digestCanonicalJson(STORAGE_SCOPE_DOMAIN, {
      invocation: canonicalOwnerIdentity(invocation),
      child_workflow_ref: childWorkflow,
    }),
    callInstance,
  };
}

function serializeStorageKey(key: WorkflowCallStorageKey): string {
  const segment = `call-${key.scopeDigest}-${key.callInstance}`;
  if (Buffer.byteLength(segment) > MAX_WORKFLOW_CALL_STORAGE_KEY_BYTES) {
    throw new Error('Workflow-call storage key exceeds its fixed byte limit');
  }
  return segment;
}

export function buildWorkflowCallNamespaceSegment(
  invocationIdentity: string,
  childWorkflow: string,
  callInstance: number | '*',
): string {
  const invocation = parseWorkflowExecutionOwnerIdentity(invocationIdentity);
  if (invocation === undefined) {
    throw new Error('Workflow-call storage key requires a canonical invocation identity');
  }
  if (childWorkflow.length === 0) {
    throw new Error('Workflow-call storage key requires a child workflow reference');
  }
  if (callInstance !== '*' && (!Number.isSafeInteger(callInstance) || callInstance < 1)) {
    throw new Error('Workflow-call storage key requires a positive call instance');
  }
  return serializeStorageKey(buildStorageKey(invocation, childWorkflow, callInstance));
}

export function parseWorkflowCallNamespaceSegment(
  segment: string,
): WorkflowCallStorageKey | undefined {
  const match = WORKFLOW_CALL_STORAGE_KEY_PATTERN.exec(segment);
  if (match === null) {
    return undefined;
  }
  const callInstance = match[2] === '*' ? '*' : Number(match[2]);
  if (callInstance !== '*' && !Number.isSafeInteger(callInstance)) {
    return undefined;
  }
  return {
    scopeDigest: match[1]!,
    callInstance,
  };
}

export function workflowCallReportRequestSegmentsMatch(
  actual: string,
  requested: string,
): boolean {
  if (actual === requested) {
    return true;
  }
  const requestedStorageKey = parseWorkflowCallNamespaceSegment(requested);
  const actualStorageKey = parseWorkflowCallNamespaceSegment(actual);
  if (requestedStorageKey !== undefined && actualStorageKey !== undefined) {
    return requestedStorageKey.callInstance === '*'
      && requestedStorageKey.scopeDigest === actualStorageKey.scopeDigest;
  }
  return false;
}

export function workflowCallReportRequestPathsMatch(
  actual: readonly string[],
  requested: readonly string[],
): boolean {
  return actual.length === requested.length
    && actual.every((segment, index) => workflowCallReportRequestSegmentsMatch(segment, requested[index]!));
}

export type WorkflowCallNamespaceCorrespondenceProof =
  | { readonly matches: true }
  | { readonly matches: false; readonly reason: string };

function proveWorkflowCallRunNamespaceSegmentsCorrespond(
  source: string,
  target: string,
): WorkflowCallNamespaceCorrespondenceProof {
  if (source === target) {
    return { matches: true };
  }
  const sourceStorageKey = parseWorkflowCallNamespaceSegment(source);
  const targetStorageKey = parseWorkflowCallNamespaceSegment(target);
  if (sourceStorageKey !== undefined && targetStorageKey !== undefined) {
    return sourceStorageKey.scopeDigest === targetStorageKey.scopeDigest
      ? { matches: true }
      : { matches: false, reason: 'scope_mismatch' };
  }
  return { matches: false, reason: 'unsupported_namespace_format' };
}

export function proveWorkflowCallRunNamespacePathsCorrespond(
  source: readonly string[],
  target: readonly string[],
): WorkflowCallNamespaceCorrespondenceProof {
  if (source.length !== target.length) {
    return { matches: false, reason: 'namespace_depth_mismatch' };
  }
  for (let index = 0; index < source.length; index += 1) {
    const proof = proveWorkflowCallRunNamespaceSegmentsCorrespond(
      source[index]!,
      target[index]!,
    );
    if (!proof.matches) {
      return { matches: false, reason: `namespace_segment_${index}:${proof.reason}` };
    }
  }
  return { matches: true };
}
