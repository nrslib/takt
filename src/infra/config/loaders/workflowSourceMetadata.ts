import type { WorkflowConfig } from '../../../core/models/index.js';
import type { WorkflowTrustInfo } from './workflowTrustSource.js';
import {
  attachWorkflowOpaqueRef as attachOpaqueRef,
  attachWorkflowSourcePath as attachSourcePath,
  attachWorkflowTrustInfo as attachTrustInfo,
  buildOpaqueWorkflowRef,
  getAttachedWorkflowOpaqueRef as getOpaqueRef,
  getAttachedWorkflowTrustInfo as getTrustInfo,
  getWorkflowSourcePath as getSourcePath,
} from '../../../shared/workflowConfigMetadata.js';

export { buildOpaqueWorkflowRef };

export function attachWorkflowOpaqueRef(workflow: WorkflowConfig, opaqueRef: string): WorkflowConfig {
  return attachOpaqueRef(workflow, opaqueRef);
}

export function attachWorkflowSourcePath(workflow: WorkflowConfig, sourcePath: string): WorkflowConfig {
  return attachSourcePath(workflow, sourcePath);
}

export function attachWorkflowTrustInfo(workflow: WorkflowConfig, trustInfo: WorkflowTrustInfo): WorkflowConfig {
  return attachTrustInfo(workflow, trustInfo);
}

export function getAttachedWorkflowOpaqueRef(workflow: WorkflowConfig): string | undefined {
  return getOpaqueRef(workflow);
}

export function getAttachedWorkflowTrustInfo(workflow: WorkflowConfig): WorkflowTrustInfo | undefined {
  return getTrustInfo(workflow) as WorkflowTrustInfo | undefined;
}

export function getWorkflowSourcePath(workflow: WorkflowConfig): string | undefined {
  return getSourcePath(workflow);
}
