import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveWorkflowConfigValues } from '../resolveWorkflowConfigValue.js';
import {
  getBuiltinWorkflowsDir,
  getGlobalWorkflowsDir,
  getProjectWorkflowsDir,
  isPathSafe,
} from '../paths.js';
import { listBuiltinWorkflowNamesForDir, type WorkflowSource } from './workflowDiscovery.js';
import type { WorkflowTrustSource } from './workflowTrustSource.js';

interface WorkflowLookupDir {
  dir: string;
  source: WorkflowSource;
  disabled?: string[];
}

export interface NamedWorkflowLookupDir<Source extends WorkflowTrustSource = WorkflowTrustSource> {
  dir: string;
  source: Source;
  disabled?: string[];
}

export function resolveWorkflowFile(workflowsDir: string, name: string): string | null {
  const resolvedWorkflowsDir = resolve(workflowsDir);
  for (const ext of ['.yaml', '.yml']) {
    const filePath = resolve(workflowsDir, `${name}${ext}`);
    if (!isPathSafe(resolvedWorkflowsDir, filePath)) {
      continue;
    }
    if (existsSync(filePath)) {
      return filePath;
    }
  }
  return null;
}

export function findWorkflowInLookupDirs<Source extends WorkflowTrustSource>(
  name: string,
  lookupDirs: NamedWorkflowLookupDir<Source>[],
): { filePath: string; source: Source } | null {
  for (const { dir, source, disabled } of lookupDirs) {
    if (source === 'builtin' && disabled?.includes(name)) {
      continue;
    }

    const filePath = resolveWorkflowFile(dir, name);
    if (!filePath) {
      continue;
    }

    return { filePath, source };
  }

  return null;
}

export function getWorkflowDirs(cwd: string): WorkflowLookupDir[] {
  const config = resolveWorkflowConfigValues(cwd, ['enableBuiltinWorkflows', 'language', 'disabledBuiltins']);
  const dirs: WorkflowLookupDir[] = [];

  if (config.enableBuiltinWorkflows !== false) {
    dirs.push({
      dir: getBuiltinWorkflowsDir(config.language),
      disabled: config.disabledBuiltins ?? [],
      source: 'builtin',
    });
  }

  dirs.push({ dir: getGlobalWorkflowsDir(), source: 'user' });
  dirs.push({ dir: getProjectWorkflowsDir(cwd), source: 'project' });
  return dirs;
}

export function getNamedWorkflowLookupDirs(projectCwd: string): WorkflowLookupDir[] {
  const config = resolveWorkflowConfigValues(projectCwd, ['enableBuiltinWorkflows', 'language', 'disabledBuiltins']);
  const dirs: WorkflowLookupDir[] = [
    {
      dir: resolve(getProjectWorkflowsDir(projectCwd)),
      source: 'project',
    },
    { dir: getGlobalWorkflowsDir(), source: 'user' },
  ];

  if (config.enableBuiltinWorkflows !== false) {
    dirs.push({
      dir: getBuiltinWorkflowsDir(config.language),
      disabled: config.disabledBuiltins ?? [],
      source: 'builtin',
    });
  }

  return dirs;
}

export function getBuiltinWorkflowPath(name: string, projectCwd: string): string | null {
  const config = resolveWorkflowConfigValues(projectCwd, ['enableBuiltinWorkflows', 'language', 'disabledBuiltins']);
  if (config.enableBuiltinWorkflows === false || (config.disabledBuiltins ?? []).includes(name)) {
    return null;
  }
  return resolveWorkflowFile(getBuiltinWorkflowsDir(config.language), name);
}

export function listBuiltinWorkflowNames(
  cwd: string,
  options?: { includeDisabled?: boolean },
): string[] {
  const config = resolveWorkflowConfigValues(cwd, ['language', 'disabledBuiltins']);
  const disabled = options?.includeDisabled ? undefined : (config.disabledBuiltins ?? []);
  return listBuiltinWorkflowNamesForDir(getBuiltinWorkflowsDir(config.language), disabled);
}
