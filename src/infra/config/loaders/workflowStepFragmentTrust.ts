import type { FacetResolutionContext } from './resource-resolver.js';
import { getOwnValue, isRecord, type RawRecord, workflowError } from './workflowStepFragmentReader.js';
import { isPathWithin, type WorkflowStepFragmentProvenance } from './workflowStepFragmentProvenance.js';
import { resolveWorkflowTrustInfo, type WorkflowTrustInfo } from './workflowTrustSource.js';
import { getWorkflowStepKind } from '../../../core/models/workflow-step-kind.js';

interface TrustOptions {
  context?: FacetResolutionContext;
  workflowPath: string;
  trustInfo?: WorkflowTrustInfo;
}

function findFieldProvenance(
  provenance: readonly WorkflowStepFragmentProvenance[],
  stepPath: readonly PropertyKey[],
  field: string,
): WorkflowStepFragmentProvenance | undefined {
  return provenance.find((entry) => entry.stepPath.length === stepPath.length + 1 && isPathWithin(entry.stepPath, [...stepPath, field]));
}

function assertWorkflowCallTrustBoundary(merged: RawRecord, options: TrustOptions, provenance: readonly WorkflowStepFragmentProvenance[], stepPath: readonly PropertyKey[]): void {
  if (getWorkflowStepKind(merged) !== 'workflow_call') return;
  const callProvenance = findFieldProvenance(provenance, stepPath, 'call');
  if (!callProvenance) return;
  const projectDir = requireProjectDir(options, callProvenance, 'workflow_call');
  const workflowTrust = options.trustInfo ?? resolveWorkflowTrustInfo({ filePath: options.workflowPath, projectCwd: projectDir });
  const fragmentTrust = resolveWorkflowTrustInfo({ filePath: callProvenance.sourcePath, projectCwd: projectDir });
  if (workflowTrust.isProjectWorkflowRoot && !fragmentTrust.isProjectTrustRoot) {
    throw workflowError(options.workflowPath, `workflow_call from step fragment "${callProvenance.ref}" at ${callProvenance.sourcePath} crosses the workflow trust boundary`);
  }
}

function assertAllowGitCommitTrustBoundary(merged: RawRecord, options: TrustOptions, provenance: readonly WorkflowStepFragmentProvenance[], stepPath: readonly PropertyKey[]): void {
  if (getOwnValue(merged, 'allow_git_commit') !== true) return;
  const allowGitCommitProvenance = findFieldProvenance(provenance, stepPath, 'allow_git_commit');
  if (!allowGitCommitProvenance) return;
  const projectDir = requireProjectDir(options, allowGitCommitProvenance, 'allow_git_commit');
  const workflowTrust = options.trustInfo ?? resolveWorkflowTrustInfo({ filePath: options.workflowPath, projectCwd: projectDir });
  const fragmentTrust = resolveWorkflowTrustInfo({ filePath: allowGitCommitProvenance.sourcePath, projectCwd: projectDir });
  if (workflowTrust.isProjectWorkflowRoot && !fragmentTrust.isProjectTrustRoot) {
    throw workflowError(options.workflowPath, `allow_git_commit from step fragment "${allowGitCommitProvenance.ref}" at ${allowGitCommitProvenance.sourcePath} crosses the workflow trust boundary`);
  }
}

function requireProjectDir(options: TrustOptions, source: WorkflowStepFragmentProvenance, field: string): string {
  const projectDir = options.context?.projectDir;
  if (projectDir === undefined) {
    throw workflowError(
      options.workflowPath,
      `cannot validate ${field} trust for step fragment "${source.ref}" at ${source.sourcePath} without projectDir`,
    );
  }
  return projectDir;
}

export function assertWorkflowCallTrustBoundaries(raw: RawRecord, options: TrustOptions, provenance: readonly WorkflowStepFragmentProvenance[]): void {
  const steps = getOwnValue(raw, 'steps');
  if (!Array.isArray(steps)) return;
  const visit = (step: unknown, stepPath: readonly PropertyKey[]): void => {
    if (!isRecord(step)) return;
    assertWorkflowCallTrustBoundary(step, options, provenance, stepPath);
    assertAllowGitCommitTrustBoundary(step, options, provenance, stepPath);
    const parallel = getOwnValue(step, 'parallel');
    if (Array.isArray(parallel)) parallel.forEach((subStep, index) => visit(subStep, [...stepPath, 'parallel', index]));
  };
  steps.forEach((step, index) => visit(step, ['steps', index]));
}
