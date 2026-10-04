import { lstatSync, realpathSync } from 'node:fs';
import type { WorkflowCallArgValue, WorkflowConfig } from '../../../core/models/index.js';
import type { WorkflowCallArgResolutionPolicy } from './workflowCallableArgResolver.js';
import { loadWorkflowFromFile, loadWorkflowFromFileForDiscovery } from './workflowFileLoader.js';
import {
  resolveWorkflowTrustInfo,
  type WorkflowTrustInfo,
  type WorkflowTrustSource,
} from './workflowTrustSource.js';

type WorkflowLoadMode = 'runtime' | 'discovery';

export interface WorkflowResolvedLoaderOptions {
  callableArgs?: Record<string, WorkflowCallArgValue>;
  loadMode?: WorkflowLoadMode;
  lookupCwd: string;
  parentTrustInfo?: WorkflowTrustInfo;
  projectCwd: string;
  source?: WorkflowTrustSource;
  resourceRoot?: string;
}

function resolveResourceRoot(resourceRoot: string | undefined): string | undefined {
  if (resourceRoot === undefined) return undefined;
  const stats = lstatSync(resourceRoot);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Workflow resource root must be a directory and must not be a symlink: ${resourceRoot}`);
  }
  return realpathSync(resourceRoot);
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
  const canonicalFilePath = realpathSync(filePath);
  const trustInfo = resolveWorkflowTrustInfo({
    filePath: canonicalFilePath,
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
    resourceRoot: resolveResourceRoot(options.resourceRoot),
  });

  return workflow;
}
