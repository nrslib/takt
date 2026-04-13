/**
 * Workflow resolution.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { isScopeRef, parseScopeRef } from 'faceted-prompting';
import type { WorkflowConfig } from '../../../core/models/index.js';
import {
  getBuiltinWorkflowsDir,
  getGlobalWorkflowsDir,
  getProjectWorkflowsDir,
  getRepertoireDir,
  isPathSafe,
} from '../paths.js';
import { resolveWorkflowConfigValues } from '../resolveWorkflowConfigValue.js';
import { loadWorkflowFromFile } from './workflowFileLoader.js';
import { validateProjectWorkflowTrustBoundary } from './workflowTrustBoundary.js';
import { resolveWorkflowTrustInfo, type WorkflowTrustSource } from './workflowTrustSource.js';
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

interface NamedWorkflowLookupDir {
  dir: string;
  source: WorkflowTrustSource;
  disabled?: string[];
}

export interface WorkflowLookupOptions {
  basePath?: string;
  lookupCwd?: string;
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
  const resolvedWorkflowsDir = resolve(workflowsDir);
  for (const ext of ['.yaml', '.yml']) {
    const filePath = resolve(workflowsDir, `${name}${ext}`);
    if (!isPathSafe(resolvedWorkflowsDir, filePath)) {
      continue;
    }
    if (existsSync(filePath)) return filePath;
  }
  return null;
}

function findWorkflowInLookupDirs(
  name: string,
  lookupDirs: NamedWorkflowLookupDir[],
): { filePath: string; source: WorkflowTrustSource } | null {
  for (const { dir, source, disabled } of lookupDirs) {
    if (source === 'builtin' && disabled?.includes(name)) {
      continue;
    }

    const match = resolveWorkflowFile(dir, name);
    if (!match) {
      continue;
    }

    return {
      filePath: match,
      source,
    };
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

function loadWorkflowFromLookupDirs(
  name: string,
  lookupDirs: NamedWorkflowLookupDir[],
  projectCwd: string,
  lookupCwd: string,
): WorkflowConfig | null {
  const match = findWorkflowInLookupDirs(name, lookupDirs);
  if (!match) {
    return null;
  }

  const trustInfo = resolveWorkflowTrustInfo({
    filePath: match.filePath,
    projectCwd,
    lookupCwd,
    source: match.source,
  });
  const workflow = loadWorkflowFromFile(match.filePath, projectCwd, { trustInfo });
  if (match.source === 'project') {
    validateProjectWorkflowTrustBoundary(workflow, match.filePath, projectCwd);
  }
  return workflow;
}

function getNamedWorkflowLookupDirs(projectCwd: string, _lookupCwd: string): NamedWorkflowLookupDir[] {
  const config = resolveWorkflowConfigValues(projectCwd, ['enableBuiltinWorkflows', 'language', 'disabledBuiltins']);
  const dirs: NamedWorkflowLookupDir[] = [];

  dirs.push({
    dir: resolve(getProjectWorkflowsDir(projectCwd)),
    source: 'project',
  });
  dirs.push({ dir: getGlobalWorkflowsDir(), source: 'user' });

  if (config.enableBuiltinWorkflows !== false) {
    dirs.push({ dir: getBuiltinWorkflowsDir(config.language), disabled: config.disabledBuiltins ?? [], source: 'builtin' });
  }

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

function loadWorkflowFromPath(
  filePath: string,
  basePath: string,
  projectCwd: string,
  lookupCwd: string,
): WorkflowConfig | null {
  const resolvedPath = resolvePath(filePath, basePath);
  return loadWorkflowFromResolvedPath(resolvedPath, projectCwd, lookupCwd);
}

function loadWorkflowFromResolvedPath(resolvedPath: string, projectCwd: string, lookupCwd = projectCwd): WorkflowConfig | null {
  if (!existsSync(resolvedPath)) {
    return null;
  }

  const trustInfo = resolveWorkflowTrustInfo({
    filePath: resolvedPath,
    projectCwd,
    lookupCwd,
  });
  const workflow = loadWorkflowFromFile(resolvedPath, projectCwd, { trustInfo });
  validateProjectWorkflowTrustBoundary(workflow, resolvedPath, projectCwd);
  return workflow;
}

export function loadWorkflow(name: string, projectCwd: string): WorkflowConfig | null {
  return loadWorkflowFromLookupDirs(name, getNamedWorkflowLookupDirs(projectCwd, projectCwd), projectCwd, projectCwd);
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

export function loadWorkflowByIdentifier(
  identifier: string,
  projectCwd: string,
  options?: WorkflowLookupOptions,
): WorkflowConfig | null {
  const lookupCwd = options?.lookupCwd ?? projectCwd;
  const basePath = options?.basePath ?? lookupCwd;
  if (isScopeRef(identifier)) {
    return loadRepertoireWorkflowByRef(identifier, projectCwd);
  }
  if (isWorkflowPath(identifier)) {
    return loadWorkflowFromPath(identifier, basePath, projectCwd, lookupCwd);
  }
  return loadWorkflowFromLookupDirs(
    identifier,
    getNamedWorkflowLookupDirs(projectCwd, lookupCwd),
    projectCwd,
    lookupCwd,
  );
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
