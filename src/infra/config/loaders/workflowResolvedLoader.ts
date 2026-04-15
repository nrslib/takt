import type { WorkflowConfig } from '../../../core/models/index.js';
import type { WorkflowCallArgResolutionPolicy } from './workflowCallableArgResolver.js';
import { loadWorkflowFromFile, loadWorkflowFromFileForDiscovery } from './workflowFileLoader.js';
import { validateProjectWorkflowTrustBoundary } from './workflowTrustBoundary.js';
import {
  resolveWorkflowTrustInfo,
  type WorkflowTrustInfo,
  type WorkflowTrustSource,
} from './workflowTrustSource.js';

type WorkflowLoadMode = 'runtime' | 'discovery';

export interface WorkflowResolvedLoaderOptions {
  callableArgs?: Record<string, string | string[]>;
  loadMode?: WorkflowLoadMode;
  lookupCwd: string;
  parentTrustInfo?: WorkflowTrustInfo;
  projectCwd: string;
  source?: WorkflowTrustSource;
}

function buildWorkflowCallArgPolicy(
  parentTrustInfo: WorkflowTrustInfo | undefined,
  childTrustInfo: WorkflowTrustInfo,
): WorkflowCallArgResolutionPolicy | undefined {
  if (!parentTrustInfo || parentTrustInfo.isProjectTrustRoot || !childTrustInfo.isProjectTrustRoot) {
    return undefined;
  }

  return {
    allowExternalFacetRefs: false,
  };
}

export function loadWorkflowFileWithResolutionOptions(
  filePath: string,
  options: WorkflowResolvedLoaderOptions,
): WorkflowConfig {
  const trustInfo = resolveWorkflowTrustInfo({
    filePath,
    projectCwd: options.projectCwd,
    lookupCwd: options.lookupCwd,
    source: options.source,
  });
  const loadWorkflow = options.loadMode === 'discovery'
    ? loadWorkflowFromFileForDiscovery
    : loadWorkflowFromFile;
  const workflow = loadWorkflow(filePath, options.projectCwd, {
    trustInfo,
    callableArgs: options.callableArgs,
    callableArgPolicy: buildWorkflowCallArgPolicy(options.parentTrustInfo, trustInfo),
  });

  if (trustInfo.source === 'project') {
    validateProjectWorkflowTrustBoundary(workflow, filePath, options.projectCwd);
  }

  return workflow;
}
