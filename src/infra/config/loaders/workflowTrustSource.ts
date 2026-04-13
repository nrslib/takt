import { resolve } from 'node:path';
import type { WorkflowConfig } from '../../../core/models/index.js';
import {
  getBuiltinWorkflowsDir,
  getGlobalWorkflowsDir,
  getProjectWorkflowsDir,
  getRepertoireDir,
  isPathSafe,
} from '../paths.js';
import { resolveWorkflowConfigValue } from '../resolveWorkflowConfigValue.js';
import { getAttachedWorkflowTrustInfo, getWorkflowSourcePath } from './workflowSourceMetadata.js';

export type WorkflowTrustSource = 'project' | 'worktree' | 'user' | 'builtin' | 'repertoire' | 'external' | 'inline';

export interface WorkflowTrustInfo {
  source: WorkflowTrustSource;
  sourcePath?: string;
  isProjectTrustRoot: boolean;
  isProjectWorkflowRoot: boolean;
}

interface WorkflowTrustResolutionOptions {
  filePath?: string;
  projectCwd: string;
  lookupCwd?: string;
  source?: WorkflowTrustSource;
}

function isPathWithin(rootPath: string, candidatePath: string): boolean {
  return isPathSafe(resolve(rootPath), resolve(candidatePath));
}

function isDistinctLookupWorkflowRoot(projectCwd: string, lookupCwd: string): boolean {
  return resolve(getProjectWorkflowsDir(projectCwd)) !== resolve(getProjectWorkflowsDir(lookupCwd));
}

export function resolveWorkflowTrustInfo(options: WorkflowTrustResolutionOptions): WorkflowTrustInfo {
  const { filePath, projectCwd, lookupCwd = projectCwd, source } = options;
  if (!filePath) {
    return {
      source: 'inline',
      isProjectTrustRoot: true,
      isProjectWorkflowRoot: false,
    };
  }

  if (source === 'project') {
    return {
      source,
      sourcePath: resolve(filePath),
      isProjectTrustRoot: true,
      isProjectWorkflowRoot: true,
    };
  }

  if (source === 'worktree') {
    return {
      source,
      sourcePath: resolve(filePath),
      isProjectTrustRoot: false,
      isProjectWorkflowRoot: false,
    };
  }

  if (source === 'user' || source === 'builtin' || source === 'repertoire' || source === 'external') {
    return {
      source,
      sourcePath: resolve(filePath),
      isProjectTrustRoot: false,
      isProjectWorkflowRoot: false,
    };
  }

  if (
    isDistinctLookupWorkflowRoot(projectCwd, lookupCwd)
    && isPathWithin(getProjectWorkflowsDir(lookupCwd), filePath)
  ) {
    return {
      source: 'worktree',
      sourcePath: resolve(filePath),
      isProjectTrustRoot: false,
      isProjectWorkflowRoot: false,
    };
  }

  if (isPathWithin(getProjectWorkflowsDir(projectCwd), filePath)) {
    return {
      source: 'project',
      sourcePath: resolve(filePath),
      isProjectTrustRoot: true,
      isProjectWorkflowRoot: true,
    };
  }

  if (isPathWithin(projectCwd, filePath)) {
    return {
      source: 'project',
      sourcePath: resolve(filePath),
      isProjectTrustRoot: true,
      isProjectWorkflowRoot: false,
    };
  }

  if (isPathWithin(getGlobalWorkflowsDir(), filePath)) {
    return {
      source: 'user',
      sourcePath: resolve(filePath),
      isProjectTrustRoot: false,
      isProjectWorkflowRoot: false,
    };
  }

  const language = resolveWorkflowConfigValue(projectCwd, 'language');
  if (isPathWithin(getBuiltinWorkflowsDir(language), filePath)) {
    return {
      source: 'builtin',
      sourcePath: resolve(filePath),
      isProjectTrustRoot: false,
      isProjectWorkflowRoot: false,
    };
  }

  if (isPathWithin(getRepertoireDir(), filePath)) {
    return {
      source: 'repertoire',
      sourcePath: resolve(filePath),
      isProjectTrustRoot: false,
      isProjectWorkflowRoot: false,
    };
  }

  return {
    source: 'external',
    sourcePath: resolve(filePath),
    isProjectTrustRoot: false,
    isProjectWorkflowRoot: false,
  };
}

export function getWorkflowTrustInfo(workflow: WorkflowConfig, projectCwd: string): WorkflowTrustInfo {
  const attached = getAttachedWorkflowTrustInfo(workflow);
  if (attached) {
    return attached;
  }
  return resolveWorkflowTrustInfo({ filePath: getWorkflowSourcePath(workflow), projectCwd });
}

export function getWorkflowPathTrustInfo(
  filePath: string | undefined,
  projectCwd: string,
  lookupCwd = projectCwd,
): WorkflowTrustInfo {
  return resolveWorkflowTrustInfo({ filePath, projectCwd, lookupCwd });
}
