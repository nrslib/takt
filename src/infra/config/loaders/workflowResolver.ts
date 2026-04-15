/**
 * Workflow resolution.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { isScopeRef, parseScopeRef } from 'faceted-prompting';
import type { WorkflowConfig } from '../../../core/models/index.js';
import { validateWorkflowCallContracts as validateWorkflowCallContractsImpl } from './workflowCallContractValidator.js';
import { buildWorkflowDiscoveryConfig, loadValidatedWorkflowDiscoveryEntry } from './workflowDiscoveryLoader.js';
import {
  findWorkflowInLookupDirs,
  getBuiltinWorkflowPath,
  getNamedWorkflowLookupDirs,
  getWorkflowDirs,
  listBuiltinWorkflowNames as listBuiltinWorkflowNamesImpl,
  resolveWorkflowFile,
  type NamedWorkflowLookupDir,
} from './workflowLookupDirectories.js';
import { loadWorkflowFileWithResolutionOptions } from './workflowResolvedLoader.js';
import { getRepertoireDir } from '../paths.js';
import { type WorkflowTrustInfo } from './workflowTrustSource.js';
import {
  collectValidatedWorkflowEntries,
  iterateWorkflowDir,
  listRepertoireWorkflowEntries,
  loadAllWorkflowsWithSourcesFromDirs,
  type WorkflowDirEntry,
  type WorkflowDiscoveryConfig,
  type WorkflowDiscoveryWithSource,
  type WorkflowWithSource,
} from './workflowDiscovery.js';

interface LoadWorkflowsOptions {
  onWarning?: (message: string) => void;
}

export interface WorkflowLookupOptions {
  basePath?: string;
  lookupCwd?: string;
}

interface InternalWorkflowLookupOptions extends WorkflowLookupOptions {
  callableArgs?: Record<string, string | string[]>;
  parentTrustInfo?: WorkflowTrustInfo;
  skipWorkflowCallContractValidation?: boolean;
}

export type {
  WorkflowDirEntry,
  WorkflowDiscoveryConfig,
  WorkflowDiscoveryWithSource,
  WorkflowSource,
  WorkflowWithSource,
} from './workflowDiscovery.js';
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

function loadWorkflowFromLookupDirs(
  name: string,
  lookupDirs: NamedWorkflowLookupDir[],
  projectCwd: string,
  lookupCwd: string,
  callableArgs?: Record<string, string | string[]>,
  parentTrustInfo?: WorkflowTrustInfo,
): WorkflowConfig | null {
  const match = findWorkflowInLookupDirs(name, lookupDirs);
  if (!match) {
    return null;
  }

  return loadWorkflowFileWithResolutionOptions(match.filePath, {
    projectCwd,
    lookupCwd,
    source: match.source,
    callableArgs,
    parentTrustInfo,
  });
}

export function listBuiltinWorkflowNames(cwd: string, options?: { includeDisabled?: boolean }): string[] {
  return listBuiltinWorkflowNamesImpl(cwd, options);
}

export function getBuiltinWorkflow(name: string, projectCwd: string): WorkflowConfig | null {
  const yamlPath = getBuiltinWorkflowPath(name, projectCwd);
  if (!yamlPath) {
    return null;
  }
  const workflow = existsSync(yamlPath)
    ? loadWorkflowFromResolvedPath(yamlPath, projectCwd, projectCwd)
    : null;
  return finalizeLoadedWorkflow(workflow, projectCwd, projectCwd);
}

function loadWorkflowFromPath(
  filePath: string,
  basePath: string,
  projectCwd: string,
  lookupCwd: string,
  callableArgs?: Record<string, string | string[]>,
  parentTrustInfo?: WorkflowTrustInfo,
): WorkflowConfig | null {
  const resolvedPath = resolvePath(filePath, basePath);
  return loadWorkflowFromResolvedPath(resolvedPath, projectCwd, lookupCwd, callableArgs, parentTrustInfo);
}

function loadWorkflowFromResolvedPath(
  resolvedPath: string,
  projectCwd: string,
  lookupCwd = projectCwd,
  callableArgs?: Record<string, string | string[]>,
  parentTrustInfo?: WorkflowTrustInfo,
): WorkflowConfig | null {
  if (!existsSync(resolvedPath)) {
    return null;
  }

  return loadWorkflowFileWithResolutionOptions(resolvedPath, {
    projectCwd,
    lookupCwd,
    callableArgs,
    parentTrustInfo,
  });
}

function finalizeLoadedWorkflow(
  workflow: WorkflowConfig | null,
  projectCwd: string,
  lookupCwd: string,
  skipWorkflowCallContractValidation = false,
  allowPathBasedCalls = true,
): WorkflowConfig | null {
  if (!workflow || skipWorkflowCallContractValidation) {
    return workflow;
  }

  validateWorkflowCallContracts(workflow, projectCwd, lookupCwd, { allowPathBasedCalls });
  return workflow;
}

function loadWorkflowForDiscovery(entry: WorkflowDirEntry, cwd: string): WorkflowConfig {
  return loadWorkflowFileWithResolutionOptions(entry.path, {
    projectCwd: cwd,
    lookupCwd: cwd,
    source: entry.source,
    loadMode: 'discovery',
  });
}

function loadWorkflowForRuntime(entry: WorkflowDirEntry, cwd: string): WorkflowConfig {
  return loadWorkflowFileWithResolutionOptions(entry.path, {
    projectCwd: cwd,
    lookupCwd: cwd,
    source: entry.source,
  });
}

function validateLoadedWorkflowEntryContracts(
  workflow: WorkflowConfig,
  cwd: string,
  allowPathBasedCalls: boolean,
): void {
  validateWorkflowCallContracts(workflow, cwd, cwd, { allowPathBasedCalls });
}

function loadValidatedWorkflowEntry(entry: WorkflowDirEntry, cwd: string): WorkflowDiscoveryConfig {
  return loadValidatedWorkflowDiscoveryEntry(entry, cwd, {
    loadWorkflowForDiscovery,
    validateWorkflowCallContracts: (workflow, projectCwd, options) => {
      validateLoadedWorkflowEntryContracts(
        workflow,
        options?.lookupCwd ?? projectCwd,
        options?.allowPathBasedCalls ?? true,
      );
    },
  });
}

function loadValidatedWorkflowConfigEntry(entry: WorkflowDirEntry, cwd: string): WorkflowConfig {
  const workflow = loadWorkflowForRuntime(entry, cwd);
  validateLoadedWorkflowEntryContracts(workflow, cwd, true);
  return workflow;
}

function loadValidatedStandaloneWorkflowEntry(
  entry: WorkflowDirEntry,
  cwd: string,
): WorkflowDiscoveryConfig {
  return buildWorkflowDiscoveryConfig(loadValidatedWorkflowConfigEntry(entry, cwd));
}

export function loadWorkflow(name: string, projectCwd: string): WorkflowConfig | null {
  const workflow = loadWorkflowFromLookupDirs(
    name,
    getNamedWorkflowLookupDirs(projectCwd),
    projectCwd,
    projectCwd,
  );
  return finalizeLoadedWorkflow(workflow, projectCwd, projectCwd);
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

function loadRepertoireWorkflowByRef(
  identifier: string,
  projectCwd: string,
  callableArgs?: Record<string, string | string[]>,
  parentTrustInfo?: WorkflowTrustInfo,
): WorkflowConfig | null {
  const scopeRef = parseScopeRef(identifier);
  const workflowsDir = join(getRepertoireDir(), `@${scopeRef.owner}`, scopeRef.repo, 'workflows');
  const filePath = resolveWorkflowFile(workflowsDir, scopeRef.name);
  return filePath
    ? loadWorkflowFileWithResolutionOptions(filePath, {
      projectCwd,
      lookupCwd: projectCwd,
      source: 'repertoire',
      callableArgs,
      parentTrustInfo,
    })
    : null;
}

export function validateWorkflowCallContracts(
  workflow: WorkflowConfig,
  projectCwd: string,
  lookupCwd = projectCwd,
  options?: { allowPathBasedCalls?: boolean },
): void {
  validateWorkflowCallContractsImpl(workflow, projectCwd, {
    isWorkflowPath,
    loadWorkflowByIdentifierForWorkflowCall,
  }, {
    lookupCwd,
    allowPathBasedCalls: options?.allowPathBasedCalls,
  });
}

function loadWorkflowByIdentifierInternal(
  identifier: string,
  projectCwd: string,
  options?: InternalWorkflowLookupOptions,
): WorkflowConfig | null {
  const lookupCwd = options?.lookupCwd ?? projectCwd;
  const basePath = options?.basePath ?? lookupCwd;
  const workflow = isScopeRef(identifier)
    ? loadRepertoireWorkflowByRef(identifier, projectCwd, options?.callableArgs, options?.parentTrustInfo)
    : isWorkflowPath(identifier)
      ? loadWorkflowFromPath(
        identifier,
        basePath,
        projectCwd,
        lookupCwd,
        options?.callableArgs,
        options?.parentTrustInfo,
      )
      : loadWorkflowFromLookupDirs(
        identifier,
        getNamedWorkflowLookupDirs(projectCwd),
        projectCwd,
        lookupCwd,
        options?.callableArgs,
        options?.parentTrustInfo,
      );

  return finalizeLoadedWorkflow(
    workflow,
    projectCwd,
    lookupCwd,
    options?.skipWorkflowCallContractValidation === true,
  );
}

export function loadWorkflowByIdentifier(
  identifier: string,
  projectCwd: string,
  options?: WorkflowLookupOptions,
): WorkflowConfig | null {
  return loadWorkflowByIdentifierInternal(identifier, projectCwd, options);
}

export function loadWorkflowByIdentifierForWorkflowCall(
  identifier: string,
  projectCwd: string,
  options: InternalWorkflowLookupOptions,
): WorkflowConfig | null {
  return loadWorkflowByIdentifierInternal(identifier, projectCwd, options);
}

export function loadAllWorkflowsWithSources(
  cwd: string,
  options?: LoadWorkflowsOptions,
): Map<string, WorkflowWithSource<WorkflowConfig>> {
  return loadAllWorkflowsWithSourcesFromDirs(
    cwd,
    getWorkflowDirs(cwd),
    options,
    loadValidatedWorkflowConfigEntry,
    true,
  );
}

export function loadAllWorkflowDiscoveryWithSources(
  cwd: string,
  options?: LoadWorkflowsOptions,
): Map<string, WorkflowDiscoveryWithSource> {
  return loadAllWorkflowsWithSourcesFromDirs(
    cwd,
    getWorkflowDirs(cwd),
    options,
    loadValidatedWorkflowEntry,
  );
}

export function loadAllStandaloneWorkflowsWithSources(
  cwd: string,
  options?: LoadWorkflowsOptions,
): Map<string, WorkflowDiscoveryWithSource> {
  return loadAllWorkflowsWithSourcesFromDirs(
    cwd,
    getWorkflowDirs(cwd),
    options,
    loadValidatedStandaloneWorkflowEntry,
  );
}

export function listWorkflowEntries(cwd: string, options?: LoadWorkflowsOptions): WorkflowDirEntry[] {
  const dirs = getWorkflowDirs(cwd);
  const entries = dirs.flatMap(({ dir, source, disabled }) => Array.from(iterateWorkflowDir(dir, source, disabled)));
  entries.push(...listRepertoireWorkflowEntries());
  return collectValidatedWorkflowEntries(entries, cwd, options, loadValidatedWorkflowEntry).map(({ entry }) => entry);
}

export function listStandaloneWorkflowEntries(cwd: string, options?: LoadWorkflowsOptions): WorkflowDirEntry[] {
  const dirs = getWorkflowDirs(cwd);
  const entries = dirs.flatMap(({ dir, source, disabled }) => Array.from(iterateWorkflowDir(dir, source, disabled)));
  entries.push(...listRepertoireWorkflowEntries());
  return collectValidatedWorkflowEntries(entries, cwd, options, loadValidatedStandaloneWorkflowEntry)
    .map(({ entry }) => entry);
}

export function loadAllWorkflows(cwd: string, options?: LoadWorkflowsOptions): Map<string, WorkflowConfig> {
  return new Map(
    Array.from(loadAllWorkflowsWithSources(cwd, options).entries()).map(([name, entry]) => [name, entry.config]),
  );
}

export function loadAllWorkflowDiscovery(
  cwd: string,
  options?: LoadWorkflowsOptions,
): Map<string, WorkflowDiscoveryConfig> {
  return new Map(
    Array.from(loadAllWorkflowDiscoveryWithSources(cwd, options).entries()).map(([name, entry]) => [name, entry.config]),
  );
}

export function loadAllStandaloneWorkflows(
  cwd: string,
  options?: LoadWorkflowsOptions,
): Map<string, WorkflowDiscoveryConfig> {
  return new Map(
    Array.from(loadAllStandaloneWorkflowsWithSources(cwd, options).entries()).map(([name, entry]) => [name, entry.config]),
  );
}

export function listWorkflows(cwd: string, options?: LoadWorkflowsOptions): string[] {
  return listWorkflowEntries(cwd, options).map((entry) => entry.name).sort();
}
