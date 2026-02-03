/**
 * Workflow resolution — 3-layer lookup logic.
 *
 * Resolves workflow names and paths to concrete WorkflowConfig objects,
 * using the priority chain: project-local → user → builtin.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import type { WorkflowConfig } from '../../../core/models/index.js';
import { getGlobalWorkflowsDir, getBuiltinWorkflowsDir, getProjectConfigDir } from '../paths.js';
import { getLanguage, getDisabledBuiltins, getBuiltinWorkflowsEnabled } from '../global/globalConfig.js';
import { createLogger, getErrorMessage } from '../../../shared/utils/index.js';
import { loadWorkflowFromFile } from './workflowParser.js';

const log = createLogger('workflow-resolver');

export type WorkflowSource = 'builtin' | 'user' | 'project';

export interface WorkflowWithSource {
  config: WorkflowConfig;
  source: WorkflowSource;
}

export function listBuiltinWorkflowNames(options?: { includeDisabled?: boolean }): string[] {
  const lang = getLanguage();
  const dir = getBuiltinWorkflowsDir(lang);
  const disabled = options?.includeDisabled ? undefined : getDisabledBuiltins();
  const names = new Set<string>();
  for (const entry of iterateWorkflowDir(dir, 'builtin', disabled)) {
    names.add(entry.name);
  }
  return Array.from(names);
}

/** Get builtin workflow by name */
export function getBuiltinWorkflow(name: string): WorkflowConfig | null {
  if (!getBuiltinWorkflowsEnabled()) return null;
  const lang = getLanguage();
  const disabled = getDisabledBuiltins();
  if (disabled.includes(name)) return null;

  const builtinDir = getBuiltinWorkflowsDir(lang);
  const yamlPath = join(builtinDir, `${name}.yaml`);
  if (existsSync(yamlPath)) {
    return loadWorkflowFromFile(yamlPath);
  }
  return null;
}

/**
 * Resolve a path that may be relative, absolute, or home-directory-relative.
 */
function resolvePath(pathInput: string, basePath: string): string {
  if (pathInput.startsWith('~')) {
    const home = homedir();
    return resolve(home, pathInput.slice(1).replace(/^\//, ''));
  }
  if (isAbsolute(pathInput)) {
    return pathInput;
  }
  return resolve(basePath, pathInput);
}

/**
 * Load workflow from a file path.
 */
function loadWorkflowFromPath(
  filePath: string,
  basePath: string,
): WorkflowConfig | null {
  const resolvedPath = resolvePath(filePath, basePath);
  if (!existsSync(resolvedPath)) {
    return null;
  }
  return loadWorkflowFromFile(resolvedPath);
}

/**
 * Resolve a workflow YAML file path by trying both .yaml and .yml extensions.
 * For category/name identifiers (e.g. "frontend/react"), resolves to
 * {workflowsDir}/frontend/react.yaml (or .yml).
 */
function resolveWorkflowFile(workflowsDir: string, name: string): string | null {
  for (const ext of ['.yaml', '.yml']) {
    const filePath = join(workflowsDir, `${name}${ext}`);
    if (existsSync(filePath)) return filePath;
  }
  return null;
}

/**
 * Load workflow by name (name-based loading only, no path detection).
 * Supports category/name identifiers (e.g. "frontend/react").
 *
 * Priority:
 * 1. Project-local workflows → .takt/workflows/{name}.yaml
 * 2. User workflows → ~/.takt/workflows/{name}.yaml
 * 3. Builtin workflows → resources/global/{lang}/workflows/{name}.yaml
 */
export function loadWorkflow(
  name: string,
  projectCwd: string,
): WorkflowConfig | null {
  const projectWorkflowsDir = join(getProjectConfigDir(projectCwd), 'workflows');
  const projectMatch = resolveWorkflowFile(projectWorkflowsDir, name);
  if (projectMatch) {
    return loadWorkflowFromFile(projectMatch);
  }

  const globalWorkflowsDir = getGlobalWorkflowsDir();
  const globalMatch = resolveWorkflowFile(globalWorkflowsDir, name);
  if (globalMatch) {
    return loadWorkflowFromFile(globalMatch);
  }

  return getBuiltinWorkflow(name);
}

/**
 * Check if a workflow identifier looks like a file path (vs a workflow name).
 */
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

/**
 * Load workflow by identifier (auto-detects name vs path).
 */
export function loadWorkflowByIdentifier(
  identifier: string,
  projectCwd: string,
): WorkflowConfig | null {
  if (isWorkflowPath(identifier)) {
    return loadWorkflowFromPath(identifier, projectCwd);
  }
  return loadWorkflow(identifier, projectCwd);
}

/**
 * Get workflow description by identifier.
 * Returns the workflow name and description (if available).
 */
export function getWorkflowDescription(
  identifier: string,
  projectCwd: string,
): { name: string; description: string } {
  const workflow = loadWorkflowByIdentifier(identifier, projectCwd);
  if (!workflow) {
    return { name: identifier, description: '' };
  }
  return {
    name: workflow.name,
    description: workflow.description ?? '',
  };
}

/** Entry for a workflow file found in a directory */
export interface WorkflowDirEntry {
  /** Workflow name (e.g. "react") */
  name: string;
  /** Full file path */
  path: string;
  /** Category (subdirectory name), undefined for root-level workflows */
  category?: string;
  /** Workflow source (builtin, user, project) */
  source: WorkflowSource;
}

/**
 * Iterate workflow YAML files in a directory, yielding name, path, and category.
 * Scans root-level files (no category) and 1-level subdirectories (category = dir name).
 * Shared by both loadAllWorkflows and listWorkflows to avoid DRY violation.
 */
function* iterateWorkflowDir(
  dir: string,
  source: WorkflowSource,
  disabled?: string[],
): Generator<WorkflowDirEntry> {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const entryPath = join(dir, entry);
    const stat = statSync(entryPath);

    if (stat.isFile() && (entry.endsWith('.yaml') || entry.endsWith('.yml'))) {
      const workflowName = entry.replace(/\.ya?ml$/, '');
      if (disabled?.includes(workflowName)) continue;
      yield { name: workflowName, path: entryPath, source };
      continue;
    }

    // 1-level subdirectory scan: directory name becomes the category
    if (stat.isDirectory()) {
      const category = entry;
      for (const subEntry of readdirSync(entryPath)) {
        if (!subEntry.endsWith('.yaml') && !subEntry.endsWith('.yml')) continue;
        const subEntryPath = join(entryPath, subEntry);
        if (!statSync(subEntryPath).isFile()) continue;
        const workflowName = subEntry.replace(/\.ya?ml$/, '');
        const qualifiedName = `${category}/${workflowName}`;
        if (disabled?.includes(qualifiedName)) continue;
        yield { name: qualifiedName, path: subEntryPath, category, source };
      }
    }
  }
}

/** Get the 3-layer directory list (builtin → user → project-local) */
function getWorkflowDirs(cwd: string): { dir: string; source: WorkflowSource; disabled?: string[] }[] {
  const disabled = getDisabledBuiltins();
  const lang = getLanguage();
  const dirs: { dir: string; source: WorkflowSource; disabled?: string[] }[] = [];
  if (getBuiltinWorkflowsEnabled()) {
    dirs.push({ dir: getBuiltinWorkflowsDir(lang), disabled, source: 'builtin' });
  }
  dirs.push({ dir: getGlobalWorkflowsDir(), source: 'user' });
  dirs.push({ dir: join(getProjectConfigDir(cwd), 'workflows'), source: 'project' });
  return dirs;
}

/**
 * Load all workflows with source metadata.
 *
 * Priority (later entries override earlier):
 *   1. Builtin workflows
 *   2. User workflows (~/.takt/workflows/)
 *   3. Project-local workflows (.takt/workflows/)
 */
export function loadAllWorkflowsWithSources(cwd: string): Map<string, WorkflowWithSource> {
  const workflows = new Map<string, WorkflowWithSource>();

  for (const { dir, source, disabled } of getWorkflowDirs(cwd)) {
    for (const entry of iterateWorkflowDir(dir, source, disabled)) {
      try {
        workflows.set(entry.name, { config: loadWorkflowFromFile(entry.path), source: entry.source });
      } catch (err) {
        log.debug('Skipping invalid workflow file', { path: entry.path, error: getErrorMessage(err) });
      }
    }
  }

  return workflows;
}

/**
 * Load all workflows with descriptions (for switch command).
 *
 * Priority (later entries override earlier):
 *   1. Builtin workflows
 *   2. User workflows (~/.takt/workflows/)
 *   3. Project-local workflows (.takt/workflows/)
 */
export function loadAllWorkflows(cwd: string): Map<string, WorkflowConfig> {
  const workflows = new Map<string, WorkflowConfig>();
  const withSources = loadAllWorkflowsWithSources(cwd);
  for (const [name, entry] of withSources) {
    workflows.set(name, entry.config);
  }
  return workflows;
}

/**
 * List available workflow names (builtin + user + project-local, excluding disabled).
 * Category workflows use qualified names like "frontend/react".
 */
export function listWorkflows(cwd: string): string[] {
  const workflows = new Set<string>();

  for (const { dir, source, disabled } of getWorkflowDirs(cwd)) {
    for (const entry of iterateWorkflowDir(dir, source, disabled)) {
      workflows.add(entry.name);
    }
  }

  return Array.from(workflows).sort();
}

/**
 * List available workflows with category information for UI display.
 * Returns entries grouped by category for 2-stage selection.
 *
 * Root-level workflows (no category) and category names are presented
 * at the same level. Selecting a category drills into its workflows.
 */
export function listWorkflowEntries(cwd: string): WorkflowDirEntry[] {
  // Later entries override earlier (project-local > user > builtin)
  const workflows = new Map<string, WorkflowDirEntry>();

  for (const { dir, source, disabled } of getWorkflowDirs(cwd)) {
    for (const entry of iterateWorkflowDir(dir, source, disabled)) {
      workflows.set(entry.name, entry);
    }
  }

  return Array.from(workflows.values());
}
