import type { WorkflowConfig } from '../../../core/models/index.js';
import type { WorkflowTrustInfo } from './workflowTrustSource.js';
import {
  attachWorkflowOpaqueRef as attachOpaqueRef,
  attachWorkflowResolvedSections as attachResolvedSections,
  attachWorkflowSourcePath as attachSourcePath,
  attachWorkflowTrustInfo as attachTrustInfo,
  buildOpaqueWorkflowRef,
  getAttachedWorkflowOpaqueRef as getOpaqueRef,
  getWorkflowResolvedSections as getResolvedSections,
  getAttachedWorkflowTrustInfo as getTrustInfo,
  getWorkflowSourcePath as getSourcePath,
} from '../../../shared/workflowConfigMetadata.js';
import type { ResolvedSectionMap } from './resource-resolver.js';

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

export function attachWorkflowResolvedSections(
  workflow: WorkflowConfig,
  sections: Partial<Record<string, ResolvedSectionMap | undefined>>,
): WorkflowConfig {
  const definedSections = Object.fromEntries(
    Object.entries(sections).filter((entry): entry is [string, ResolvedSectionMap] => entry[1] !== undefined),
  );
  return attachResolvedSections(workflow, definedSections);
}

export function getWorkflowResolvedSectionMap(
  workflow: WorkflowConfig,
  facetType: string,
): ResolvedSectionMap | undefined {
  return getResolvedSections(workflow)?.[facetType] as ResolvedSectionMap | undefined;
}
