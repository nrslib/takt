import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { WorkflowConfigRawSchema } from '../../../core/models/index.js';
import { getProjectWorkflowsDir, getRepertoireDir, isPathSafe } from '../paths.js';
import { resolveWorkflowConfigValue } from '../resolveWorkflowConfigValue.js';
import { validateDoctorGraph } from './workflowDoctorGraph.js';
import { validateWorkflowReferences } from './workflowDoctorRefValidator.js';
import type { WorkflowDiagnostic, WorkflowDoctorReport } from './workflowDoctorTypes.js';
import { formatWorkflowLoadWarning } from './workflowLoadWarning.js';
import { isMissingWorkflowCallArgError } from './workflowCallableArgResolver.js';
import {
  findWorkflowInLookupDirs,
  getNamedWorkflowLookupDirs,
} from './workflowLookupDirectories.js';
import { isWorkflowPath, validateWorkflowCallContracts } from './workflowResolver.js';
import { loadWorkflowFileWithResolutionOptions } from './workflowResolvedLoader.js';
import { getWorkflowTrustInfo, type WorkflowTrustSource } from './workflowTrustSource.js';
import { validateWorkflowExecutionTrustBoundary } from './workflowTrustBoundary.js';
import {
  type FacetResolutionContext,
  type WorkflowSections,
  resolveSectionMap,
} from './resource-resolver.js';

export type { WorkflowDiagnostic, WorkflowDoctorReport } from './workflowDoctorTypes.js';

type RawWorkflow = ReturnType<typeof WorkflowConfigRawSchema.parse>;

export interface WorkflowDoctorTarget {
  filePath: string;
  lookupCwd?: string;
  source?: WorkflowTrustSource;
}

function resolveInputPath(input: string, baseDir: string): string {
  if (input.startsWith('~')) {
    return resolve(homedir(), input.slice(1).replace(/^\//, ''));
  }
  if (isAbsolute(input)) {
    return input;
  }
  return resolve(baseDir, input);
}

function resolveNamedWorkflowTarget(name: string, projectDir: string): WorkflowDoctorTarget | undefined {
  const match = findWorkflowInLookupDirs(name, getNamedWorkflowLookupDirs(projectDir));
  if (!match) {
    return undefined;
  }

  return {
    filePath: match.filePath,
    source: match.source,
  };
}

function findWorkflowLookupCwd(filePath: string, projectDir: string): string | undefined {
  const resolvedProjectDir = resolve(projectDir);
  const resolvedFilePath = resolve(filePath);
  let currentDir = dirname(resolvedFilePath);
  while (true) {
    if (currentDir.endsWith(join('.takt', 'workflows'))) {
      const workflowOwner = dirname(dirname(currentDir));
      if (resolve(workflowOwner) === resolvedProjectDir) {
        return resolvedProjectDir;
      }

      const configuredWorktreeDir = resolveWorkflowConfigValue(projectDir, 'worktreeDir');
      const configuredWorktreeRoot = configuredWorktreeDir
        ? [isAbsolute(configuredWorktreeDir) ? configuredWorktreeDir : resolve(projectDir, configuredWorktreeDir)]
        : [];
      const worktreeBaseDirs = [
        join(projectDir, '.takt', 'worktrees'),
        join(projectDir, '..', 'takt-worktrees'),
        ...configuredWorktreeRoot,
      ].map((dir) => resolve(dir));

      if (worktreeBaseDirs.some((baseDir) => isPathSafe(baseDir, workflowOwner))) {
        return resolve(workflowOwner);
      }

      return undefined;
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      return undefined;
    }
    currentDir = parentDir;
  }
}

function collectWorkflowFiles(rootDir: string): string[] {
  if (!existsSync(rootDir)) {
    return [];
  }
  const results: string[] = [];
  for (const entry of readdirSync(rootDir)) {
    const entryPath = join(rootDir, entry);
    const stat = statSync(entryPath);
    if (stat.isDirectory()) {
      results.push(...collectWorkflowFiles(entryPath));
      continue;
    }
    if (entry.endsWith('.yaml') || entry.endsWith('.yml')) {
      results.push(entryPath);
    }
  }
  return results;
}

function resolvePathWorkflowTarget(target: string, projectDir: string): WorkflowDoctorTarget {
  const filePath = resolveInputPath(target, projectDir);
  const lookupCwd = findWorkflowLookupCwd(filePath, projectDir);
  return lookupCwd ? { filePath, lookupCwd } : { filePath };
}

export function resolveWorkflowDoctorTargets(targets: string[], projectDir: string): WorkflowDoctorTarget[] {
  if (targets.length === 0) {
    return collectWorkflowFiles(getProjectWorkflowsDir(projectDir)).map((filePath) => ({
      filePath,
      source: 'project',
    }));
  }

  return targets.map((target) => {
    if (isWorkflowPath(target)) {
      return resolvePathWorkflowTarget(target, projectDir);
    }

    const resolvedTarget = resolveNamedWorkflowTarget(target, projectDir);
    if (!resolvedTarget) {
      throw new Error(`Workflow not found: ${target}`);
    }
    return resolvedTarget;
  });
}

function buildContext(projectDir: string, filePath: string): FacetResolutionContext {
  return {
    lang: resolveWorkflowConfigValue(projectDir, 'language'),
    workflowDir: dirname(filePath),
    projectDir,
    repertoireDir: getRepertoireDir(),
  };
}

function buildSections(raw: RawWorkflow, workflowDir: string): WorkflowSections {
  return {
    personas: raw.personas,
    resolvedInstructions: resolveSectionMap(raw.instructions, workflowDir),
    resolvedKnowledge: resolveSectionMap(raw.knowledge, workflowDir),
    resolvedPolicies: resolveSectionMap(raw.policies, workflowDir),
    resolvedReportFormats: resolveSectionMap(raw.report_formats, workflowDir),
  };
}

function shouldIgnoreDoctorLoadError(raw: RawWorkflow, error: unknown): boolean {
  return raw.subworkflow?.callable === true && isMissingWorkflowCallArgError(error);
}

function loadWorkflowForDoctorValidation(
  filePath: string,
  projectDir: string,
  raw: RawWorkflow,
  options?: {
    lookupCwd?: string;
    source?: WorkflowTrustSource;
  },
) {
  const lookupCwd = options?.lookupCwd ?? projectDir;
  try {
    return loadWorkflowFileWithResolutionOptions(filePath, {
      projectCwd: projectDir,
      lookupCwd,
      source: options?.source,
    });
  } catch (error) {
    if (!shouldIgnoreDoctorLoadError(raw, error)) {
      throw error;
    }
    return loadWorkflowFileWithResolutionOptions(filePath, {
      projectCwd: projectDir,
      lookupCwd,
      source: options?.source,
      loadMode: 'discovery',
    });
  }
}

export function inspectWorkflowFile(
  filePath: string,
  projectDir: string,
  options?: {
    lookupCwd?: string;
    source?: WorkflowTrustSource;
  },
): WorkflowDoctorReport {
  try {
    const raw = WorkflowConfigRawSchema.parse(parseYaml(readFileSync(filePath, 'utf-8')));
    const lookupCwd = options?.lookupCwd ?? projectDir;
    try {
      const workflow = loadWorkflowForDoctorValidation(filePath, projectDir, raw, options);
      if (getWorkflowTrustInfo(workflow, projectDir).source !== 'builtin') {
        validateWorkflowExecutionTrustBoundary(workflow, projectDir);
      }
      validateWorkflowCallContracts(workflow, projectDir, lookupCwd, { allowPathBasedCalls: false });
    } catch (error) {
      return {
        diagnostics: [{ level: 'error', message: formatWorkflowLoadWarning(basename(filePath), error) }],
        filePath,
      };
    }

    const context = buildContext(projectDir, filePath);
    const sections = buildSections(raw, context.workflowDir!);
    const diagnostics: WorkflowDiagnostic[] = [];
    validateWorkflowReferences(raw, sections, context, diagnostics);
    validateDoctorGraph(raw, diagnostics);

    return {
      diagnostics,
      filePath,
    };
  } catch (error) {
    return {
      diagnostics: [{ level: 'error', message: formatWorkflowLoadWarning(basename(filePath), error) }],
      filePath,
    };
  }
}
