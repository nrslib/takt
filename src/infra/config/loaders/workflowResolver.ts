/**
 * Workflow resolution.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { isScopeRef, parseScopeRef } from 'faceted-prompting';
import type { WorkflowConfig } from '../../../core/models/index.js';
import { getBuiltinWorkflowsDir, getGlobalWorkflowsDir, getProjectWorkflowsDir, getRepertoireDir } from '../paths.js';
import { resolveWorkflowConfigValues } from '../resolveWorkflowConfigValue.js';
import { loadWorkflowFromFile } from './workflowFileLoader.js';
import { validateProjectWorkflowTrustBoundary } from './workflowTrustBoundary.js';
import {
  collectValidatedWorkflowEntries,
  iterateWorkflowDir,
  listBuiltinWorkflowNamesForDir,
  listRepertoireWorkflowEntries,
  loadAllWorkflowsWithSourcesFromDirs,
  type WorkflowDirEntry,
  type WorkflowSource,
  type WorkflowWithSource,
} from './workflowDiscovery.js';

interface LoadWorkflowsOptions {
  onWarning?: (message: string) => void;
}

interface WorkflowLookupDir {
  dir: string;
  source: WorkflowSource;
  disabled?: string[];
}

export type { WorkflowDirEntry, WorkflowSource, WorkflowWithSource } from './workflowDiscovery.js';
export { getWorkflowDescription, type FirstStepInfo, type StepPreview } from './workflowPreview.js';

function resolvePath(pathInput: string, basePath: string): string {
  if (pathInput.startsWith('~')) {
    return resolve(homedir(), pathInput.slice(1).replace(/^\//, ''));
  }
  if (isAbsolute(pathInput)) {
    return pathInput;
  }
  return resolve(basePath, pathInput);
}

function resolveWorkflowFile(workflowsDir: string, name: string): string | null {
  for (const ext of ['.yaml', '.yml']) {
    const filePath = join(workflowsDir, `${name}${ext}`);
    if (existsSync(filePath)) return filePath;
  }
  return null;
}

function getWorkflowDirs(cwd: string): WorkflowLookupDir[] {
  const config = resolveWorkflowConfigValues(cwd, ['enableBuiltinWorkflows', 'language', 'disabledBuiltins']);
  const dirs: WorkflowLookupDir[] = [];
  if (config.enableBuiltinWorkflows !== false) {
    dirs.push({ dir: getBuiltinWorkflowsDir(config.language), disabled: config.disabledBuiltins ?? [], source: 'builtin' });
  }
  dirs.push({ dir: getGlobalWorkflowsDir(), source: 'user' });
  dirs.push({ dir: getProjectWorkflowsDir(cwd), source: 'project' });
  return dirs;
}

export function listBuiltinWorkflowNames(cwd: string, options?: { includeDisabled?: boolean }): string[] {
  const config = resolveWorkflowConfigValues(cwd, ['language', 'disabledBuiltins']);
  const disabled = options?.includeDisabled ? undefined : (config.disabledBuiltins ?? []);
  return listBuiltinWorkflowNamesForDir(getBuiltinWorkflowsDir(config.language), disabled);
}

export function getBuiltinWorkflow(name: string, projectCwd: string): WorkflowConfig | null {
  const config = resolveWorkflowConfigValues(projectCwd, ['enableBuiltinWorkflows', 'language', 'disabledBuiltins']);
  if (config.enableBuiltinWorkflows === false || (config.disabledBuiltins ?? []).includes(name)) {
    return null;
  }
  const yamlPath = join(getBuiltinWorkflowsDir(config.language), `${name}.yaml`);
  return existsSync(yamlPath) ? loadWorkflowFromFile(yamlPath, projectCwd) : null;
}

function loadWorkflowFromPath(filePath: string, basePath: string, projectCwd: string): WorkflowConfig | null {
  const resolvedPath = resolvePath(filePath, basePath);
  if (!existsSync(resolvedPath)) {
    return null;
  }

  const workflow = loadWorkflowFromFile(resolvedPath, projectCwd);
  validateProjectWorkflowTrustBoundary(workflow, resolvedPath, projectCwd);
  return workflow;
}

export function loadWorkflow(name: string, projectCwd: string): WorkflowConfig | null {
  for (const dir of [getProjectWorkflowsDir(projectCwd), getGlobalWorkflowsDir()]) {
    const match = resolveWorkflowFile(dir, name);
    if (match) {
      const workflow = loadWorkflowFromFile(match, projectCwd);
      if (dir === getProjectWorkflowsDir(projectCwd)) {
        validateProjectWorkflowTrustBoundary(workflow, match, projectCwd);
      }
      return workflow;
    }
  }
  return getBuiltinWorkflow(name, projectCwd);
}

export function isWorkflowPath(identifier: string): boolean {
  return (
    identifier.startsWith('/') ||
    identifier.startsWith('~') ||
    identifier.startsWith('./') ||
    identifier.startsWith('../') ||
    identifier.endsWith('.yaml') ||
    identifier.endsWith('.yml')
  );
}

function loadRepertoireWorkflowByRef(identifier: string, projectCwd: string): WorkflowConfig | null {
  const scopeRef = parseScopeRef(identifier);
  const workflowsDir = join(getRepertoireDir(), `@${scopeRef.owner}`, scopeRef.repo, 'workflows');
  const filePath = resolveWorkflowFile(workflowsDir, scopeRef.name);
  return filePath ? loadWorkflowFromFile(filePath, projectCwd) : null;
}

export function loadWorkflowByIdentifier(identifier: string, projectCwd: string): WorkflowConfig | null {
  if (isScopeRef(identifier)) {
    return loadRepertoireWorkflowByRef(identifier, projectCwd);
  }
  if (isWorkflowPath(identifier)) {
    return loadWorkflowFromPath(identifier, projectCwd, projectCwd);
  }
  return loadWorkflow(identifier, projectCwd);
}

export function loadAllWorkflowsWithSources(
  cwd: string,
  options?: LoadWorkflowsOptions,
): Map<string, WorkflowWithSource> {
  return loadAllWorkflowsWithSourcesFromDirs(cwd, getWorkflowDirs(cwd), options);
}

export function listWorkflowEntries(cwd: string, options?: LoadWorkflowsOptions): WorkflowDirEntry[] {
  const dirs = getWorkflowDirs(cwd);
  const entries = dirs.flatMap(({ dir, source, disabled }) => Array.from(iterateWorkflowDir(dir, source, disabled)));
  entries.push(...listRepertoireWorkflowEntries());
  return collectValidatedWorkflowEntries(entries, cwd, options).map(({ entry }) => entry);
}

export function loadAllWorkflows(cwd: string, options?: LoadWorkflowsOptions): Map<string, WorkflowConfig> {
  return new Map(
    Array.from(loadAllWorkflowsWithSources(cwd, options).entries()).map(([name, entry]) => [name, entry.config]),
  );
}

export function listWorkflows(cwd: string, options?: LoadWorkflowsOptions): string[] {
  return listWorkflowEntries(cwd, options).map((entry) => entry.name).sort();
}
