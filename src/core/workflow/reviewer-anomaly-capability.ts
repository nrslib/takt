import type { WorkflowConfig } from '../models/types.js';
import {
  issueReviewerAnomalyCallCapability,
  issueReviewerAnomalyDefinitionCapability,
  issueWorkflowOpaqueRef,
  readReviewerAnomalyCallCapability,
  readReviewerAnomalyDefinitionCapability,
  readWorkflowOpaqueRef,
  type ReviewerAnomalyCallCapability,
  type ReviewerAnomalyDefinitionCapability,
} from './reviewer-anomaly-capability-storage.js';
export type {
  ReviewerAnomalyCallCapability,
  ReviewerAnomalyDefinitionCapability,
} from './reviewer-anomaly-capability-storage.js';

export function getWorkflowOpaqueRef(workflow: WorkflowConfig): string | undefined {
  return readWorkflowOpaqueRef(workflow);
}

export function transferWorkflowOpaqueRef(source: WorkflowConfig, target: WorkflowConfig): WorkflowConfig {
  const opaqueRef = getWorkflowOpaqueRef(source);
  if (opaqueRef !== undefined) {
    issueWorkflowOpaqueRef(target, opaqueRef);
  }
  return target;
}

export function getReviewerAnomalyDefinitionCapability(
  workflow: WorkflowConfig,
): ReviewerAnomalyDefinitionCapability | undefined {
  return readReviewerAnomalyDefinitionCapability(workflow);
}

export function transferReviewerAnomalyDefinitionCapability(
  source: WorkflowConfig,
  target: WorkflowConfig,
): WorkflowConfig {
  const capability = getReviewerAnomalyDefinitionCapability(source);
  const opaqueRef = getWorkflowOpaqueRef(source);
  if (opaqueRef !== undefined) {
    issueWorkflowOpaqueRef(target, opaqueRef);
  }
  if (capability !== undefined) {
    issueReviewerAnomalyDefinitionCapability(target, capability);
  }
  return target;
}

export function getReviewerAnomalyCallCapability(
  options: object,
): ReviewerAnomalyCallCapability | undefined {
  return readReviewerAnomalyCallCapability(options);
}

export function transferReviewerAnomalyCallCapability(source: object, target: object): void {
  const capability = getReviewerAnomalyCallCapability(source);
  if (capability !== undefined) {
    issueReviewerAnomalyCallCapability(target, capability);
  }
}
