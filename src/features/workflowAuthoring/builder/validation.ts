import { parse as parseYaml, parseDocument } from 'yaml';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WorkflowConfigRawSchema } from '../../../core/models/index.js';
import { sanitizeTerminalText } from '../../../shared/utils/text.js';
import {
  addMirroredBuilderPath,
  findBuilderRoot,
  formatRelative,
  isBuilderManagedContentFile,
  isFacetDirectoryFile,
  isFacetMarkdownFile,
  isWorkflowFile,
} from './files.js';
import { listBuilderTargetWorkflows } from './scope.js';
import { resolveUsedFacetPaths } from './workflowGraph.js';
import type {
  BuilderChangeApproval,
  BuilderFileChangeSummary,
  ResolvedBuilderScope,
} from './types.js';

export function resolveBuilderValidationTargets(options: {
  scope: ResolvedBuilderScope;
  changedWorkflowPaths: string[];
  changedFacetPaths: string[];
}): string[] {
  const targets = new Set(options.changedWorkflowPaths.map((path) => resolve(path)));
  const changedFacets = new Set(options.changedFacetPaths.map((path) => resolve(path)));

  if (changedFacets.size > 0) {
    for (const workflow of listBuilderTargetWorkflows(options.scope)) {
      const raw = WorkflowConfigRawSchema.parse(parseYamlContent(workflow.path));
      const usedFacets = resolveUsedFacetPaths(options.scope, raw, workflow.path);
      if (usedFacets.some((facetPath) => changedFacets.has(resolve(facetPath)))) {
        targets.add(resolve(workflow.path));
      }
    }
  }

  return [...targets].sort();
}

export function findBuilderChangeViolation(
  scope: ResolvedBuilderScope,
  changes: BuilderFileChangeSummary[],
  approval: BuilderChangeApproval,
): string | undefined {
  const workflowParseViolation = findChangedWorkflowParseViolation(changes);
  if (workflowParseViolation) {
    return workflowParseViolation;
  }
  const allowedWorkflowPaths = resolveAllowedBuilderWorkflowPaths(scope, changes, approval);
  const allowedFacetPaths = resolveAllowedBuilderFacetPaths(scope, changes, approval, allowedWorkflowPaths);
  const allowedDirectFacetPaths = resolveAllowedBuilderDirectFacetPaths(scope, approval, allowedWorkflowPaths);
  for (const change of changes) {
    if (change.deleted) {
      return `Workflow builder attempted to delete "${change.filePath}", which is not allowed.`;
    }
    if (!isAllowedBuilderChange(scope, allowedWorkflowPaths, allowedFacetPaths, allowedDirectFacetPaths, change)) {
      return `Workflow builder attempted to change "${change.filePath}" outside the approved workflow/facet scope.`;
    }
  }
  return findDualLanguageChangeViolation(scope, changes);
}

export function buildBuilderValidationFeedback(diagnostics: string[]): string {
  return [
    'Workflow doctor rejected the generated changes. The changes were rolled back.',
    'Fix these diagnostics before returning the next change manifest:',
    ...diagnostics.map((diagnostic) => `- ${sanitizeTerminalText(diagnostic)}`),
  ].join('\n');
}

function findChangedWorkflowParseViolation(changes: BuilderFileChangeSummary[]): string | undefined {
  for (const change of changes) {
    if (!isWorkflowFile(change.filePath) || change.content === undefined || change.deleted) {
      continue;
    }
    try {
      WorkflowConfigRawSchema.parse(parseYaml(change.content));
    } catch (parseError) {
      const message = parseError instanceof Error ? parseError.message : String(parseError);
      return `Workflow builder change "${change.filePath}" is not valid workflow YAML: ${sanitizeTerminalText(message)}`;
    }
  }
  return undefined;
}

function resolveAllowedBuilderWorkflowPaths(
  scope: ResolvedBuilderScope,
  changes: BuilderFileChangeSummary[],
  approval: BuilderChangeApproval,
): Set<string> {
  const paths = new Set<string>();
  if (approval.target.mode === 'modify') {
    addMirroredBuilderPath(scope, paths, approval.target.workflowPath);
  }
  for (const filePath of approval.approvedWorkflowPaths) {
    addMirroredBuilderPath(scope, paths, filePath);
  }
  for (const change of changes) {
    if (!change.created || !isWorkflowFile(change.filePath)) {
      continue;
    }
    if (approval.target.mode === 'modify') {
      continue;
    }
    addMirroredBuilderPath(scope, paths, change.filePath);
  }
  return paths;
}

function resolveAllowedBuilderFacetPaths(
  scope: ResolvedBuilderScope,
  changes: BuilderFileChangeSummary[],
  approval: BuilderChangeApproval,
  allowedWorkflowPaths: Set<string>,
): Set<string> {
  const paths = new Set<string>();
  const unapprovedWorkflowFacetPaths = collectFacetPathsReferencedByUnapprovedWorkflows(scope, allowedWorkflowPaths);
  for (const filePath of approval.targetFacetPaths) {
    addAutoApprovedBuilderFacetPath(scope, paths, filePath, unapprovedWorkflowFacetPaths);
  }
  for (const filePath of approval.approvedWorkflowFacetPaths) {
    addAutoApprovedBuilderFacetPath(scope, paths, filePath, unapprovedWorkflowFacetPaths);
  }
  for (const filePath of approval.approvedFacetPaths) {
    addMirroredBuilderPath(scope, paths, filePath);
  }
  for (const change of changes) {
    if (!change.created || !isFacetDirectoryFile(scope, change.filePath)) {
      continue;
    }
    if (isReferencedByChangedApprovedWorkflow(scope, changes, allowedWorkflowPaths, change.filePath)) {
      addMirroredBuilderPath(scope, paths, change.filePath);
    }
  }
  return paths;
}

function isReferencedByChangedApprovedWorkflow(
  scope: ResolvedBuilderScope,
  changes: BuilderFileChangeSummary[],
  allowedWorkflowPaths: Set<string>,
  facetPath: string,
): boolean {
  return changes.some((change) => {
    if (
      !isWorkflowFile(change.filePath)
      || !allowedWorkflowPaths.has(resolve(change.filePath))
      || change.content === undefined
    ) {
      return false;
    }
    return workflowContentReferencesFacet(scope, change.filePath, change.content, facetPath);
  });
}

function workflowContentReferencesFacet(
  scope: ResolvedBuilderScope,
  workflowPath: string,
  workflowContent: string,
  facetPath: string,
): boolean {
  const raw = WorkflowConfigRawSchema.parse(parseYaml(workflowContent));
  const usedFacetPaths = resolveUsedFacetPaths(scope, raw, workflowPath).map((path) => resolve(path));
  return usedFacetPaths.includes(resolve(facetPath));
}

function resolveAllowedBuilderDirectFacetPaths(
  scope: ResolvedBuilderScope,
  approval: BuilderChangeApproval,
  allowedWorkflowPaths: Set<string>,
): Set<string> {
  const paths = new Set<string>();
  const unapprovedWorkflowFacetPaths = collectFacetPathsReferencedByUnapprovedWorkflows(scope, allowedWorkflowPaths);
  for (const filePath of approval.targetFacetPaths) {
    addAutoApprovedBuilderFacetPath(scope, paths, filePath, unapprovedWorkflowFacetPaths);
  }
  for (const filePath of approval.approvedWorkflowFacetPaths) {
    addAutoApprovedBuilderFacetPath(scope, paths, filePath, unapprovedWorkflowFacetPaths);
  }
  for (const filePath of approval.approvedFacetPaths) {
    addMirroredBuilderPath(scope, paths, filePath);
  }
  return paths;
}

function addAutoApprovedBuilderFacetPath(
  scope: ResolvedBuilderScope,
  paths: Set<string>,
  filePath: string,
  unapprovedWorkflowFacetPaths: Set<string>,
): void {
  if (!unapprovedWorkflowFacetPaths.has(resolve(filePath))) {
    addMirroredBuilderPath(scope, paths, filePath);
  }
}

function collectFacetPathsReferencedByUnapprovedWorkflows(
  scope: ResolvedBuilderScope,
  allowedWorkflowPaths: Set<string>,
): Set<string> {
  const paths = new Set<string>();
  for (const workflow of listBuilderTargetWorkflows(scope)) {
    if (allowedWorkflowPaths.has(resolve(workflow.path))) {
      continue;
    }
    const raw = parseWorkflowForApprovalScope(workflow.path);
    if (!raw) {
      continue;
    }
    for (const facetPath of resolveUsedFacetPaths(scope, raw, workflow.path)) {
      paths.add(resolve(facetPath));
    }
  }
  return paths;
}

function parseWorkflowForApprovalScope(workflowPath: string): ReturnType<typeof WorkflowConfigRawSchema.parse> | undefined {
  const document = parseDocument(readFileSync(workflowPath, 'utf-8'));
  if (document.errors.length > 0) {
    return undefined;
  }
  const result = WorkflowConfigRawSchema.safeParse(document.toJS());
  return result.success ? result.data : undefined;
}

function findDualLanguageChangeViolation(
  scope: ResolvedBuilderScope,
  changes: BuilderFileChangeSummary[],
): string | undefined {
  if (scope.writeMode !== 'dual-language') {
    return undefined;
  }
  const changedLangsByPath = new Map<string, Set<'en' | 'ja'>>();
  for (const change of changes) {
    const root = findBuilderRoot(scope, change.filePath);
    if (!root?.lang || !isBuilderManagedContentFile(change.filePath)) {
      continue;
    }
    const relativePath = formatRelative(root.rootDir, change.filePath);
    const changedLangs = changedLangsByPath.get(relativePath) ?? new Set<'en' | 'ja'>();
    changedLangs.add(root.lang);
    changedLangsByPath.set(relativePath, changedLangs);
  }
  for (const [relativePath, changedLangs] of changedLangsByPath) {
    if (!changedLangs.has('en') || !changedLangs.has('ja')) {
      return `Builtin workflow builder changes must update both builtins/en and builtins/ja for "${relativePath}".`;
    }
  }
  return undefined;
}

function isAllowedBuilderChange(
  scope: ResolvedBuilderScope,
  allowedWorkflowPaths: Set<string>,
  allowedFacetPaths: Set<string>,
  allowedDirectFacetPaths: Set<string>,
  change: BuilderFileChangeSummary,
): boolean {
  const resolvedFilePath = resolve(change.filePath);
  const root = findBuilderRoot(scope, resolvedFilePath);
  if (!root) {
    return false;
  }
  const relativePath = formatRelative(root.rootDir, resolvedFilePath);
  if (relativePath.startsWith('workflows/') && isWorkflowFile(resolvedFilePath)) {
    return allowedWorkflowPaths.has(resolvedFilePath);
  }
  if (relativePath.startsWith('facets/') && isFacetMarkdownFile(resolvedFilePath)) {
    return allowedFacetPaths.has(resolvedFilePath);
  }
  return isFacetMarkdownFile(resolvedFilePath) && allowedDirectFacetPaths.has(resolvedFilePath);
}

function parseYamlContent(filePath: string): unknown {
  return parseYaml(readFileSync(filePath, 'utf-8'));
}
