import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger, getErrorMessage } from '../../../shared/utils/index.js';
import { getRepertoireDir } from '../paths.js';
import { formatWorkflowLoadWarning } from './workflowLoadWarning.js';
import { loadWorkflowFromFile } from './workflowFileLoader.js';
import type { WorkflowConfig } from '../../../core/models/index.js';

const log = createLogger('workflow-discovery');

export type WorkflowSource = 'builtin' | 'user' | 'project' | 'repertoire';

export interface WorkflowDirEntry {
  name: string;
  path: string;
  category?: string;
  source: WorkflowSource;
}

export interface WorkflowWithSource {
  config: WorkflowConfig;
  source: WorkflowSource;
}

interface LoadWorkflowsOptions {
  onWarning?: (message: string) => void;
}

interface WorkflowLookupDir {
  dir: string;
  source: WorkflowSource;
  disabled?: string[];
}

interface ValidatedWorkflowEntry {
  entry: WorkflowDirEntry;
  config: WorkflowConfig;
}

function emitWorkflowLoadWarning(options: LoadWorkflowsOptions | undefined, workflowName: string, error: unknown): void {
  if (options?.onWarning) {
    options.onWarning(formatWorkflowLoadWarning(workflowName, error));
  }
}

export function* iterateWorkflowDir(
  dir: string,
  source: WorkflowSource,
  disabled?: string[],
): Generator<WorkflowDirEntry> {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const entryPath = join(dir, entry);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(entryPath);
    } catch (error) {
      log.debug(`stat failed for ${entryPath}: ${getErrorMessage(error)}`);
      continue;
    }
    if (stat.isFile() && (entry.endsWith('.yaml') || entry.endsWith('.yml'))) {
      const name = entry.replace(/\.ya?ml$/, '');
      if (!disabled?.includes(name)) {
        yield { name, path: entryPath, source };
      }
      continue;
    }
    if (!stat.isDirectory()) continue;
    for (const subEntry of readdirSync(entryPath)) {
      if (!subEntry.endsWith('.yaml') && !subEntry.endsWith('.yml')) continue;
      const subEntryPath = join(entryPath, subEntry);
      try {
        if (!statSync(subEntryPath).isFile()) continue;
      } catch (error) {
        log.debug(`stat failed for ${subEntryPath}: ${getErrorMessage(error)}`);
        continue;
      }
      const qualifiedName = `${entry}/${subEntry.replace(/\.ya?ml$/, '')}`;
      if (!disabled?.includes(qualifiedName)) {
        yield { name: qualifiedName, path: subEntryPath, category: entry, source };
      }
    }
  }
}

export function listWorkflowNamesInDir(
  dir: string,
  source: WorkflowSource,
  disabled?: string[],
): string[] {
  return Array.from(iterateWorkflowDir(dir, source, disabled)).map((entry) => entry.name);
}

export function listBuiltinWorkflowNamesForDir(
  dir: string,
  disabled?: string[],
): string[] {
  return listWorkflowNamesInDir(dir, 'builtin', disabled);
}

function* iterateRepertoireWorkflows(): Generator<WorkflowDirEntry> {
  const repertoireDir = getRepertoireDir();
  if (!existsSync(repertoireDir)) return;
  for (const ownerEntry of readdirSync(repertoireDir)) {
    if (!ownerEntry.startsWith('@')) continue;
    const ownerPath = join(repertoireDir, ownerEntry);
    try {
      if (!statSync(ownerPath).isDirectory()) continue;
    } catch (error) {
      log.debug(`stat failed for owner dir ${ownerPath}: ${getErrorMessage(error)}`);
      continue;
    }
    for (const repoEntry of readdirSync(ownerPath)) {
      const repoPath = join(ownerPath, repoEntry);
      const workflowsDir = join(repoPath, 'workflows');
      try {
        if (!statSync(repoPath).isDirectory() || !existsSync(workflowsDir)) continue;
      } catch (error) {
        log.debug(`stat failed for repo dir ${repoPath}: ${getErrorMessage(error)}`);
        continue;
      }
      for (const workflowFile of readdirSync(workflowsDir)) {
        if (!workflowFile.endsWith('.yaml') && !workflowFile.endsWith('.yml')) continue;
        const workflowPath = join(workflowsDir, workflowFile);
        try {
          if (!statSync(workflowPath).isFile()) continue;
        } catch (error) {
          log.debug(`stat failed for workflow file ${workflowPath}: ${getErrorMessage(error)}`);
          continue;
        }
        yield {
          name: `@${ownerEntry.slice(1)}/${repoEntry}/${workflowFile.replace(/\.ya?ml$/, '')}`,
          path: workflowPath,
          source: 'repertoire',
        };
      }
    }
  }
}

export function listRepertoireWorkflowEntries(): WorkflowDirEntry[] {
  return Array.from(iterateRepertoireWorkflows());
}

export function collectValidatedWorkflowEntries(
  entries: Iterable<WorkflowDirEntry>,
  cwd: string,
  options?: LoadWorkflowsOptions,
): ValidatedWorkflowEntry[] {
  const validatedEntries = new Map<string, ValidatedWorkflowEntry>();
  for (const entry of entries) {
    try {
      validatedEntries.set(entry.name, { entry, config: loadWorkflowFromFile(entry.path, cwd) });
    } catch (error) {
      log.debug('Skipping invalid workflow file', { path: entry.path, error: getErrorMessage(error) });
      emitWorkflowLoadWarning(options, entry.name, error);
    }
  }
  return Array.from(validatedEntries.values());
}

export function loadAllWorkflowsWithSourcesFromDirs(
  cwd: string,
  dirs: WorkflowLookupDir[],
  options?: LoadWorkflowsOptions,
): Map<string, WorkflowWithSource> {
  const workflows = new Map<string, WorkflowWithSource>();
  const entries = dirs.flatMap(({ dir, source, disabled }) => Array.from(iterateWorkflowDir(dir, source, disabled)));
  entries.push(...Array.from(iterateRepertoireWorkflows()));
  for (const { entry, config } of collectValidatedWorkflowEntries(entries, cwd, options)) {
    workflows.set(entry.name, { config, source: entry.source });
  }
  return workflows;
}
