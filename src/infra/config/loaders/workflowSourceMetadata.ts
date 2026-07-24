import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { WorkflowConfig } from '../../../core/models/index.js';
import { getWorkflowOpaqueRef } from '../../../core/workflow/reviewer-anomaly-capability.js';
import type { WorkflowTrustInfo } from './workflowTrustSource.js';

const WORKFLOW_SOURCE_PATH = Symbol('workflowSourcePath');
const WORKFLOW_TRUST_INFO = Symbol('workflowTrustInfo');
type WorkflowConfigWithSourcePath = WorkflowConfig & {
  [WORKFLOW_SOURCE_PATH]?: string;
  [WORKFLOW_TRUST_INFO]?: WorkflowTrustInfo;
};

export function attachWorkflowSourcePath(workflow: WorkflowConfig, sourcePath: string): WorkflowConfig {
  Object.defineProperty(workflow, WORKFLOW_SOURCE_PATH, {
    value: resolve(sourcePath),
    writable: true,
    configurable: true,
    enumerable: false,
  });
  return workflow;
}

export function buildOpaqueWorkflowRef(
  sourcePath: string,
  trustInfo: Pick<WorkflowTrustInfo, 'source'>,
): string {
  const normalizedPath = resolve(sourcePath);
  const digest = createHash('sha256').update(normalizedPath).digest('hex');
  return `${trustInfo.source}:sha256:${digest}`;
}

export function getAttachedWorkflowOpaqueRef(workflow: WorkflowConfig): string | undefined {
  return getWorkflowOpaqueRef(workflow);
}

export function getWorkflowSourcePath(workflow: WorkflowConfig): string | undefined {
  return (workflow as WorkflowConfigWithSourcePath)[WORKFLOW_SOURCE_PATH];
}

export function attachWorkflowTrustInfo(workflow: WorkflowConfig, trustInfo: WorkflowTrustInfo): WorkflowConfig {
  Object.defineProperty(workflow, WORKFLOW_TRUST_INFO, {
    value: trustInfo,
    writable: true,
    configurable: true,
    enumerable: false,
  });
  return workflow;
}

export function getAttachedWorkflowTrustInfo(workflow: WorkflowConfig): WorkflowTrustInfo | undefined {
  return (workflow as WorkflowConfigWithSourcePath)[WORKFLOW_TRUST_INFO];
}
