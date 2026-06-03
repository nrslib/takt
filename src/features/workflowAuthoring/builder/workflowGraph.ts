import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import {
  getGlobalConfigDir,
  getRepertoireDir,
  resolveWorkflowConfigValue,
} from '../../../infra/config/index.js';
import type { WorkflowConfig } from '../../../core/models/index.js';
import { resolveWorkflowCallTarget } from '../../../infra/config/loaders/workflowCallResolver.js';
import {
  collectWorkflowCallReferences,
  collectWorkflowUsedFacetReferences,
  type WorkflowFacetReference,
} from '../../../infra/config/loaders/workflowDoctorRefValidator.js';
import { getWorkflowSourcePath } from '../../../infra/config/loaders/workflowSourceMetadata.js';
import { loadWorkflowByIdentifierForWorkflowCall } from '../../../infra/config/loaders/workflowResolver.js';
import {
  isResourcePath,
  resolveFacetPath,
  resolveResourcePath,
  type FacetResolutionContext,
} from '../../../infra/config/loaders/resource-resolver.js';
import { FACET_SECTION_TO_DIR } from './constants.js';
import {
  addMirroredBuilderPath,
  findBuilderRoot,
  loadRawWorkflow,
  workflowNameForPath,
} from './files.js';
import { listBuilderTargetWorkflows } from './scope.js';
import type { RawWorkflow, RelatedWorkflowCandidate, ResolvedBuilderScope } from './types.js';

export function buildRelatedWorkflowAnalysis(options: {
  scope: ResolvedBuilderScope;
  targetWorkflowPath: string;
}): { candidates: RelatedWorkflowCandidate[]; diagnostics: string[] } {
  const target = loadRawWorkflow(options.targetWorkflowPath);
  const targetName = workflowNameForPath(options.targetWorkflowPath);
  const targetFacets = new Set(resolveUsedFacetPaths(options.scope, target, options.targetWorkflowPath));
  const targetCalls = resolveWorkflowCallPaths(options.scope, options.targetWorkflowPath, target);
  const candidates = new Map<string, RelatedWorkflowCandidate>();
  const diagnostics = [...targetCalls.diagnostics];

  for (const workflow of listBuilderTargetWorkflows(options.scope)) {
    if (resolve(workflow.path) === resolve(options.targetWorkflowPath)) {
      continue;
    }
    const raw = loadRawWorkflow(workflow.path);
    const workflowFacets = resolveUsedFacetPaths(options.scope, raw, workflow.path);
    if (workflowFacets.some((facetPath) => targetFacets.has(facetPath))) {
      addCandidate(candidates, {
        relation: 'shared_facet',
        workflowPath: workflow.path,
        reason: 'Shares at least one facet with the selected workflow.',
      });
    }
    if (targetCalls.paths.has(resolve(workflow.path))) {
      addCandidate(candidates, {
        relation: 'workflow_call_child',
        workflowPath: workflow.path,
        reason: 'Selected workflow calls this workflow.',
      });
    }
    const workflowCalls = resolveWorkflowCallPaths(options.scope, workflow.path, raw);
    diagnostics.push(...workflowCalls.diagnostics);
    if (workflowCalls.paths.has(resolve(options.targetWorkflowPath))) {
      addCandidate(candidates, {
        relation: 'workflow_call_parent',
        workflowPath: workflow.path,
        reason: `Workflow calls "${targetName}".`,
      });
    }
    if (sharesNamePrefix(targetName, workflow.name)) {
      addCandidate(candidates, {
        relation: 'similar_name',
        workflowPath: workflow.path,
        reason: `Workflow name is similar to "${targetName}".`,
      });
    }
  }

  return {
    candidates: [...candidates.values()].sort((a, b) => a.workflowPath.localeCompare(b.workflowPath)),
    diagnostics,
  };
}

export function resolveUsedFacetPaths(scope: ResolvedBuilderScope, raw: RawWorkflow, workflowPath: string): string[] {
  const workflowDir = dirname(workflowPath);
  const paths = new Set<string>();
  for (const reference of collectWorkflowUsedFacetReferences(raw)) {
    const resolvedPath = resolveFacetReferencePath(scope, raw, workflowPath, workflowDir, reference);
    if (resolvedPath) {
      paths.add(resolvedPath);
    }
  }
  return [...paths].sort();
}

export function collectWorkflowFacetPathsForApproval(
  scope: ResolvedBuilderScope,
  workflowPaths: string[],
): string[] {
  const paths = new Set<string>();
  for (const workflowPath of workflowPaths) {
    if (!existsSync(workflowPath)) {
      continue;
    }
    for (const facetPath of resolveUsedFacetPaths(scope, loadRawWorkflow(workflowPath), workflowPath)) {
      addMirroredBuilderPath(scope, paths, facetPath);
    }
  }
  return [...paths].sort();
}

function resolveWorkflowCallPaths(
  scope: ResolvedBuilderScope,
  workflowPath: string,
  raw: RawWorkflow,
): { paths: Set<string>; diagnostics: string[] } {
  const paths = new Set<string>();
  const diagnostics: string[] = [];
  const refs = collectWorkflowCallReferences(raw);
  if (refs.length === 0) {
    return { paths, diagnostics };
  }
  const parentWorkflow = loadWorkflowForBuilderCallGraph(scope, workflowPath);
  if (parentWorkflow) {
    for (const ref of refs) {
      const callPath = resolveWorkflowCallPath(scope, workflowPath, parentWorkflow, ref.call, ref.stepName);
      if (callPath) {
        paths.add(resolve(callPath));
      } else {
        diagnostics.push(formatWorkflowCallDiagnostic(scope, workflowPath, ref.stepName, ref.call));
      }
    }
  }
  return { paths, diagnostics };
}

function loadWorkflowForBuilderCallGraph(scope: ResolvedBuilderScope, workflowPath: string): WorkflowConfig | null {
  return loadWorkflowByIdentifierForWorkflowCall(workflowPath, scope.projectDir, {
    basePath: dirname(workflowPath),
    lookupCwd: scope.projectDir,
  });
}

function resolveWorkflowCallPath(
  scope: ResolvedBuilderScope,
  workflowPath: string,
  parentWorkflow: WorkflowConfig,
  ref: string,
  stepName: string,
): string | undefined {
  const workflow = resolveWorkflowCallTarget(
    parentWorkflow,
    resolveBuilderWorkflowCallIdentifier(scope, ref),
    stepName,
    scope.projectDir,
    scope.projectDir,
    { sourcePath: workflowPath },
  );
  const sourcePath = workflow ? getWorkflowSourcePath(workflow) : undefined;
  if (sourcePath && findBuilderRoot(scope, sourcePath)) {
    return sourcePath;
  }
  return undefined;
}

function resolveBuilderWorkflowCallIdentifier(scope: ResolvedBuilderScope, ref: string): string {
  return resolveGlobalConfigWorkflowPath(scope, ref) ?? ref;
}

function formatWorkflowCallDiagnostic(
  scope: ResolvedBuilderScope,
  workflowPath: string,
  stepName?: string,
  ref?: string,
): string {
  const details = stepName && ref
    ? ` step "${stepName}" call "${ref}"`
    : '';
  return `Unresolved workflow_call in ${workflowNameForPath(workflowPath)} (${formatBuilderWorkflowPath(scope, workflowPath)})${details}.`;
}

function formatBuilderWorkflowPath(scope: ResolvedBuilderScope, workflowPath: string): string {
  const root = findBuilderRoot(scope, workflowPath);
  if (!root) {
    return 'outside selected scope';
  }
  const prefix = root.lang ? `${root.lang}:` : '';
  return `${prefix}${workflowNameForPath(workflowPath)}`;
}

function resolveGlobalConfigWorkflowPath(scope: ResolvedBuilderScope, ref: string): string | undefined {
  const prefix = '~/.takt/';
  if (!ref.startsWith(prefix)) {
    return undefined;
  }
  const filePath = resolve(getGlobalConfigDir(), ref.slice(prefix.length));
  return existsSync(filePath) && findBuilderRoot(scope, filePath) ? filePath : undefined;
}

function resolveFacetReferencePath(
  scope: ResolvedBuilderScope,
  raw: RawWorkflow,
  workflowPath: string,
  workflowDir: string,
  reference: WorkflowFacetReference,
): string | undefined {
  const mapped = raw[reference.section]?.[reference.ref];
  if (mapped) {
    const resolvedPath = isResourcePath(mapped) || mapped.endsWith('.md')
      ? resolveResourcePath(mapped, workflowDir)
      : undefined;
    return resolveScopedFacetPath(scope, resolvedPath);
  }
  if (isResourcePath(reference.ref)) {
    return resolveScopedFacetPath(scope, resolveResourcePath(reference.ref, workflowDir));
  }
  return resolveScopedFacetPath(scope, resolveFacetPath(
    reference.ref,
    FACET_SECTION_TO_DIR[reference.section],
    buildBuilderFacetResolutionContext(scope, workflowPath),
  ));
}

function resolveScopedFacetPath(scope: ResolvedBuilderScope, filePath: string | undefined): string | undefined {
  return filePath && findBuilderRoot(scope, filePath) ? filePath : undefined;
}

function buildBuilderFacetResolutionContext(
  scope: ResolvedBuilderScope,
  workflowPath: string,
): FacetResolutionContext {
  const root = findBuilderRoot(scope, workflowPath);
  return {
    lang: root?.lang ?? resolveWorkflowConfigValue(scope.projectDir, 'language'),
    workflowDir: dirname(workflowPath),
    projectDir: scope.projectDir,
    repertoireDir: getRepertoireDir(),
  };
}

function addCandidate(
  candidates: Map<string, RelatedWorkflowCandidate>,
  candidate: RelatedWorkflowCandidate,
): void {
  const key = `${candidate.relation}:${candidate.workflowPath}`;
  if (!candidates.has(key)) {
    candidates.set(key, candidate);
  }
}

function sharesNamePrefix(a: string, b: string): boolean {
  const aPrefix = a.split('-')[0] ?? '';
  const bPrefix = b.split('-')[0] ?? '';
  return aPrefix.length > 0 && aPrefix === bPrefix && a !== b;
}
