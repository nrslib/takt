import type { WorkflowConfig } from '../models/types.js';
import { hashCanonicalJson } from '../../shared/utils/canonical-json.js';
import type {
  ReviewerAnomalyAcknowledgementGate,
  ReviewerAnomalyEvidenceReference,
} from './findings/reviewer-anomaly-acknowledgement.js';

interface SealedWorkflowOpaqueRef {
  readonly opaqueRef: string;
  readonly workflowContentHash: string;
}

const workflowOpaqueRefs =
  new WeakMap<WorkflowConfig, SealedWorkflowOpaqueRef>();

interface SealedReviewerAnomalyDefinitionCapability {
  readonly capability: ReviewerAnomalyDefinitionCapability;
  readonly workflowContentHash: string;
}

const reviewerAnomalyDefinitionCapabilities =
  new WeakMap<WorkflowConfig, SealedReviewerAnomalyDefinitionCapability>();
const reviewerAnomalyCallCapabilities =
  new WeakMap<object, ReviewerAnomalyCallCapability>();

export interface ReviewerAnomalyDefinitionCapability {
  readonly kind: 'reviewer_anomaly_acknowledgement';
  readonly approvalSteps: readonly [string, string];
  readonly workflowRef: string;
}

export interface ReviewerAnomalyCallCapability extends ReviewerAnomalyDefinitionCapability {
  readonly evidenceReferences: readonly ReviewerAnomalyEvidenceReference[];
  readonly reviewScopeSnapshotId: string;
  readonly gate: ReviewerAnomalyAcknowledgementGate;
}

function bindOnce<T extends object, V>(
  storage: WeakMap<T, V>,
  target: T,
  value: V,
  capabilityName: string,
): void {
  if (storage.has(target)) {
    throw new Error(`${capabilityName} is already bound to this object`);
  }
  storage.set(target, value);
}

function freezeObservation<T extends { runId: string; stepName: string; timestamp: string }>(observation: T): T {
  return Object.freeze({ ...observation });
}

export function issueWorkflowOpaqueRef(workflow: WorkflowConfig, opaqueRef: string): void {
  bindOnce(
    workflowOpaqueRefs,
    workflow,
    Object.freeze({
      opaqueRef,
      workflowContentHash: hashCanonicalJson(workflow),
    }),
    'Workflow opaque reference',
  );
}

export function readWorkflowOpaqueRef(workflow: WorkflowConfig): string | undefined {
  const sealed = workflowOpaqueRefs.get(workflow);
  if (sealed === undefined) {
    return undefined;
  }
  if (sealed.workflowContentHash !== hashCanonicalJson(workflow)) {
    throw new Error(
      'Workflow opaque reference is invalid because workflow content changed after issuance',
    );
  }
  return sealed.opaqueRef;
}

export function issueReviewerAnomalyDefinitionCapability(
  workflow: WorkflowConfig,
  input: {
    kind: 'reviewer_anomaly_acknowledgement';
    approvalSteps: readonly [string, string];
    workflowRef: string;
  },
): void {
  const capability = Object.freeze({
    kind: input.kind,
    approvalSteps: Object.freeze([...input.approvalSteps]) as readonly [string, string],
    workflowRef: input.workflowRef,
  });
  bindOnce(
    reviewerAnomalyDefinitionCapabilities,
    workflow,
    Object.freeze({
      capability,
      workflowContentHash: hashCanonicalJson(workflow),
    }),
    'Reviewer anomaly definition capability',
  );
}

export function readReviewerAnomalyDefinitionCapability(
  workflow: WorkflowConfig,
): ReviewerAnomalyDefinitionCapability | undefined {
  const sealed = reviewerAnomalyDefinitionCapabilities.get(workflow);
  if (sealed === undefined) {
    return undefined;
  }
  if (sealed.workflowContentHash !== hashCanonicalJson(workflow)) {
    throw new Error(
      'Reviewer anomaly definition capability is invalid because workflow content changed after issuance',
    );
  }
  return sealed.capability;
}

export function issueReviewerAnomalyCallCapability(
  options: object,
  input: ReviewerAnomalyCallCapability,
): void {
  const gate = Object.freeze({
    ...input.gate,
    startedAt: freezeObservation(input.gate.startedAt),
  });
  const capability = Object.freeze({
    kind: input.kind,
    approvalSteps: Object.freeze([...input.approvalSteps]) as readonly [string, string],
    workflowRef: input.workflowRef,
    evidenceReferences: Object.freeze(input.evidenceReferences.map((reference) => Object.freeze({ ...reference }))),
    reviewScopeSnapshotId: input.reviewScopeSnapshotId,
    gate,
  });
  bindOnce(
    reviewerAnomalyCallCapabilities,
    options,
    capability,
    'Reviewer anomaly call capability',
  );
}

export function readReviewerAnomalyCallCapability(
  options: object,
): ReviewerAnomalyCallCapability | undefined {
  return reviewerAnomalyCallCapabilities.get(options);
}
