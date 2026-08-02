import { createHash } from 'node:crypto';
import {
  parseWorkflowExecutionOwnerIdentity,
  type WorkflowExecutionOwnerIdentity,
} from '../models/workflow-resume-contract.js';
import type { WorkflowCallInvocationRecord } from '../models/types.js';

interface WorkflowCallStorageKey {
  readonly scopeDigest: string;
  readonly callInstance: number | '*';
}

interface LegacyWorkflowCallNamespace {
  readonly callInstance: number | '*';
  readonly stepName: string;
  readonly childWorkflow: string;
}

const WORKFLOW_CALL_STORAGE_KEY_PATTERN = /^call-v2-([0-9a-f]{64})-([1-9]\d*|\*)$/;
const LEGACY_WORKFLOW_CALL_NAMESPACE_PATTERN = /^iteration-([1-9]\d*|\*)--step-([^/]+)--workflow-([^/]+)$/;
const STORAGE_SCOPE_DOMAIN = 'takt.workflow-call.storage-scope.v2';
export const MAX_WORKFLOW_CALL_STORAGE_KEY_BYTES = 89;

function encodeLegacyValue(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function parseLegacyReportNamespaceSegment(segment: string): LegacyWorkflowCallNamespace | undefined {
  const match = LEGACY_WORKFLOW_CALL_NAMESPACE_PATTERN.exec(segment);
  if (match === null) {
    return undefined;
  }
  try {
    const callInstance = match[1] === '*' ? '*' : Number(match[1]);
    const stepName = decodeURIComponent(match[2]!);
    const childWorkflow = decodeURIComponent(match[3]!);
    const rebuilt = `iteration-${callInstance}--step-${encodeLegacyValue(stepName)}`
      + `--workflow-${encodeLegacyValue(childWorkflow)}`;
    return rebuilt === segment ? { callInstance, stepName, childWorkflow } : undefined;
  } catch {
    return undefined;
  }
}

export function isWorkflowCallNamespaceSegment(segment: string): boolean {
  return parseWorkflowCallNamespaceSegment(segment) !== undefined
    || parseLegacyReportNamespaceSegment(segment) !== undefined;
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

function legacyStepName(identity: WorkflowExecutionOwnerIdentity): string {
  let lastCallIndex = -1;
  identity.owners.forEach((owner, index) => {
    if (owner.kind === 'workflow_call') {
      lastCallIndex = index;
    }
  });
  return [
    ...identity.owners.slice(lastCallIndex + 1).map((owner) => owner.step),
    identity.step,
  ].join('/');
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
  const segment = `call-v2-${key.scopeDigest}-${key.callInstance}`;
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
  const requestedLegacy = parseLegacyReportNamespaceSegment(requested);
  const actualLegacy = parseLegacyReportNamespaceSegment(actual);
  return requestedLegacy?.callInstance === '*'
    && actualLegacy !== undefined
    && requestedLegacy.stepName === actualLegacy.stepName
    && requestedLegacy.childWorkflow === actualLegacy.childWorkflow;
}

export function workflowCallReportRequestPathsMatch(
  actual: readonly string[],
  requested: readonly string[],
): boolean {
  return actual.length === requested.length
    && actual.every((segment, index) => workflowCallReportRequestSegmentsMatch(segment, requested[index]!));
}

export interface WorkflowCallNamespaceCorrespondenceEvidence {
  readonly sourceWorkflowCallInvocations?: Readonly<Record<string, WorkflowCallInvocationRecord>>;
}

export type WorkflowCallNamespaceCorrespondenceProof =
  | { readonly matches: true }
  | { readonly matches: false; readonly reason: string };

function buildLegacyNamespace(
  invocation: WorkflowExecutionOwnerIdentity,
  record: WorkflowCallInvocationRecord,
): string {
  return `iteration-${record.call_instance}--step-${encodeLegacyValue(legacyStepName(invocation))}`
    + `--workflow-${encodeLegacyValue(record.child_workflow_ref)}`;
}

function proveLegacyToV2Correspondence(
  source: string,
  target: string,
  evidence: WorkflowCallNamespaceCorrespondenceEvidence,
): WorkflowCallNamespaceCorrespondenceProof {
  const sourceLegacy = parseLegacyReportNamespaceSegment(source);
  const targetStorageKey = parseWorkflowCallNamespaceSegment(target);
  if (sourceLegacy === undefined || targetStorageKey === undefined) {
    return { matches: false, reason: 'unsupported_namespace_format' };
  }
  const records = evidence.sourceWorkflowCallInvocations;
  if (records === undefined) {
    return { matches: false, reason: 'legacy_correspondence_metadata_missing' };
  }
  const candidates: Array<{
    readonly invocation: WorkflowExecutionOwnerIdentity;
    readonly record: WorkflowCallInvocationRecord;
  }> = [];
  for (const [identity, record] of Object.entries(records)) {
    const invocation = parseWorkflowExecutionOwnerIdentity(identity);
    if (
      invocation === undefined
      || !Number.isSafeInteger(record.call_instance)
      || record.call_instance < 1
      || record.child_workflow_ref.length === 0
    ) {
      return { matches: false, reason: 'legacy_correspondence_metadata_invalid' };
    }
    if (buildLegacyNamespace(invocation, record) === source) {
      candidates.push({ invocation, record });
    }
  }
  if (candidates.length === 0) {
    return { matches: false, reason: 'legacy_correspondence_candidate_missing' };
  }
  if (candidates.length > 1) {
    return { matches: false, reason: 'legacy_correspondence_candidate_ambiguous' };
  }
  const candidate = candidates[0]!;
  const candidateStorageKey = buildStorageKey(
    candidate.invocation,
    candidate.record.child_workflow_ref,
    candidate.record.call_instance,
  );
  return candidateStorageKey.scopeDigest === targetStorageKey.scopeDigest
    ? { matches: true }
    : { matches: false, reason: 'legacy_correspondence_target_mismatch' };
}

function proveWorkflowCallRunNamespaceSegmentsCorrespond(
  source: string,
  target: string,
  evidence: WorkflowCallNamespaceCorrespondenceEvidence,
): WorkflowCallNamespaceCorrespondenceProof {
  if (source === target && parseLegacyReportNamespaceSegment(source) === undefined) {
    return { matches: true };
  }
  const sourceStorageKey = parseWorkflowCallNamespaceSegment(source);
  const targetStorageKey = parseWorkflowCallNamespaceSegment(target);
  if (sourceStorageKey !== undefined && targetStorageKey !== undefined) {
    return sourceStorageKey.scopeDigest === targetStorageKey.scopeDigest
      ? { matches: true }
      : { matches: false, reason: 'v2_scope_mismatch' };
  }
  return proveLegacyToV2Correspondence(source, target, evidence);
}

export function proveWorkflowCallRunNamespacePathsCorrespond(
  source: readonly string[],
  target: readonly string[],
  evidence: WorkflowCallNamespaceCorrespondenceEvidence,
): WorkflowCallNamespaceCorrespondenceProof {
  if (source.length !== target.length) {
    return { matches: false, reason: 'namespace_depth_mismatch' };
  }
  for (let index = 0; index < source.length; index += 1) {
    const proof = proveWorkflowCallRunNamespaceSegmentsCorrespond(
      source[index]!,
      target[index]!,
      evidence,
    );
    if (!proof.matches) {
      return { matches: false, reason: `namespace_segment_${index}:${proof.reason}` };
    }
  }
  return { matches: true };
}
