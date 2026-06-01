import { basename, join } from 'node:path';
import {
  PATH_MENTION_PREFIX,
  PATH_MENTION_TERMINATOR,
} from './constants.js';
import {
  addMirroredBuilderPath,
  findBuilderRoot,
  formatRelative,
  isWorkflowFile,
  listFilesRecursive,
  listWorkflowFiles,
  removeMirroredBuilderPath,
} from './files.js';
import { collectWorkflowFacetPathsForApproval } from './workflowGraph.js';
import type { ConversationGoContext } from '../../interactive/conversationLoop.js';
import type { BuilderChangeApproval, BuilderTarget, ResolvedBuilderScope } from './types.js';

export function buildBuilderChangeApproval(options: {
  scope: ResolvedBuilderScope;
  target: BuilderTarget;
  goContext: ConversationGoContext;
}): BuilderChangeApproval {
  const approved = collectExplicitlyApprovedChangePaths(options.scope, options.goContext);
  const approvedWorkflowPaths = [...approved.workflowPaths].sort();
  return {
    target: options.target,
    targetFacetPaths: collectTargetFacetPathsForApproval(options.scope, options.target),
    approvedWorkflowPaths,
    approvedWorkflowFacetPaths: collectWorkflowFacetPathsForApproval(options.scope, approvedWorkflowPaths),
    approvedFacetPaths: [...approved.facetPaths].sort(),
  };
}

function collectTargetFacetPathsForApproval(scope: ResolvedBuilderScope, target: BuilderTarget): string[] {
  if (target.mode !== 'modify') {
    return [];
  }
  return collectWorkflowFacetPathsForApproval(scope, [target.workflowPath]);
}

function collectExplicitlyApprovedChangePaths(
  scope: ResolvedBuilderScope,
  goContext: ConversationGoContext,
): { workflowPaths: Set<string>; facetPaths: Set<string> } {
  const approvedWorkflowPaths = new Set<string>();
  const approvedFacetPaths = new Set<string>();
  const candidates = listBuilderApprovalCandidates(scope);
  let latestAssistantCandidatePaths = new Set<string>();
  const messages = goContext.inlineText
    ? [...goContext.history, { role: 'user' as const, content: goContext.inlineText }]
    : goContext.history;

  for (const message of messages) {
    if (message.role === 'assistant') {
      latestAssistantCandidatePaths = findMentionedApprovalCandidatePaths(scope, candidates, message.content);
      continue;
    }
    if (message.role !== 'user') {
      continue;
    }
    for (const segment of splitApprovalTextSegments(message.content)) {
      const mentioned = findMentionedApprovalCandidatePaths(scope, candidates, segment);
      if (isExplicitRejectionLine(segment.trim().toLowerCase())) {
        const rejected = mentioned.size > 0 ? mentioned : latestAssistantCandidatePaths;
        removeApprovedBuilderCandidatePaths(scope, candidates, approvedWorkflowPaths, approvedFacetPaths, rejected);
        continue;
      }
      const hasMentionedCandidate = mentioned.size > 0;
      if (!isExplicitApprovalLine(segment, hasMentionedCandidate)) {
        continue;
      }
      const approved = hasMentionedCandidate ? mentioned : latestAssistantCandidatePaths;
      for (const candidate of candidates) {
        if (!approved.has(candidate.filePath)) {
          continue;
        }
        if (pathIsRejectedInText(scope, candidate.filePath, segment, candidates.map((item) => item.filePath))) {
          removeApprovedBuilderCandidatePath(scope, candidate, approvedWorkflowPaths, approvedFacetPaths);
          continue;
        }
        addApprovedBuilderCandidatePath(scope, candidate, approvedWorkflowPaths, approvedFacetPaths);
      }
    }
  }
  return { workflowPaths: approvedWorkflowPaths, facetPaths: approvedFacetPaths };
}

function findMentionedApprovalCandidatePaths(
  scope: ResolvedBuilderScope,
  candidates: { kind: 'workflow' | 'facet'; filePath: string }[],
  text: string,
): Set<string> {
  const paths = new Set<string>();
  const candidatePaths = candidates.map((candidate) => candidate.filePath);
  for (const candidate of candidates) {
    if (pathIsMentionedInText(scope, candidate.filePath, text, candidatePaths)) {
      paths.add(candidate.filePath);
    }
  }
  return paths;
}

function addApprovedBuilderCandidatePath(
  scope: ResolvedBuilderScope,
  candidate: { kind: 'workflow' | 'facet'; filePath: string },
  approvedWorkflowPaths: Set<string>,
  approvedFacetPaths: Set<string>,
): void {
  const targetSet = candidate.kind === 'workflow' ? approvedWorkflowPaths : approvedFacetPaths;
  addMirroredBuilderPath(scope, targetSet, candidate.filePath);
}

function removeApprovedBuilderCandidatePaths(
  scope: ResolvedBuilderScope,
  candidates: { kind: 'workflow' | 'facet'; filePath: string }[],
  approvedWorkflowPaths: Set<string>,
  approvedFacetPaths: Set<string>,
  rejectedPaths: Set<string>,
): void {
  for (const candidate of candidates) {
    if (rejectedPaths.has(candidate.filePath)) {
      removeApprovedBuilderCandidatePath(scope, candidate, approvedWorkflowPaths, approvedFacetPaths);
    }
  }
}

function removeApprovedBuilderCandidatePath(
  scope: ResolvedBuilderScope,
  candidate: { kind: 'workflow' | 'facet'; filePath: string },
  approvedWorkflowPaths: Set<string>,
  approvedFacetPaths: Set<string>,
): void {
  const targetSet = candidate.kind === 'workflow' ? approvedWorkflowPaths : approvedFacetPaths;
  removeMirroredBuilderPath(scope, targetSet, candidate.filePath);
}

function splitApprovalTextSegments(content: string): string[] {
  return content
    .split(/\r?\n|[,;、。；]/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function isExplicitApprovalLine(line: string, allowActionWords: boolean): boolean {
  const normalized = line.trim().toLowerCase();
  if (isExplicitRejectionLine(normalized)) {
    return false;
  }
  if (isClarificationRequestLine(normalized)) {
    return false;
  }
  const bareApprovalPatterns = [
    /\bok\b/,
    /\byes\b/,
    /\bapprove\b/,
    /\bapproved\b/,
    /\bconfirm\b/,
    /\bconfirmed\b/,
    /承認/,
    /許可/,
    /はい/,
    /良い/,
    /よい/,
  ];
  const actionApprovalPatterns = [
    /\bedit\b/,
    /\bchange\b/,
    /修正/,
    /変更/,
  ];
  return bareApprovalPatterns.some((pattern) => pattern.test(normalized))
    || (allowActionWords && actionApprovalPatterns.some((pattern) => pattern.test(normalized)));
}

function isClarificationRequestLine(normalizedLine: string): boolean {
  return [
    /\bshow\b/,
    /\bexplain\b/,
    /\bdescribe\b/,
    /\bdetail(?:s)?\b/,
    /\bplan\b/,
    /見せて/,
    /説明/,
    /教えて/,
    /内容/,
  ].some((pattern) => pattern.test(normalizedLine));
}

function isExplicitRejectionLine(normalizedLine: string): boolean {
  return [
    /\bnot\s+ok\b/,
    /\bdo\s+not\b/,
    /\bdon't\b/,
    /\bno\b/,
    /\bdeny\b/,
    /\breject\b/,
    /承認しない/,
    /許可しない/,
    /編集しない/,
    /変更しない/,
    /しない/,
    /だめ/,
    /ダメ/,
    /不可/,
  ].some((pattern) => pattern.test(normalizedLine));
}

function pathIsRejectedInText(
  scope: ResolvedBuilderScope,
  filePath: string,
  text: string,
  candidatePaths?: string[],
): boolean {
  const normalizedText = text.toLowerCase();
  const terminator = '(?=$|\\s|[.,;、。；])';
  return [...pathMentionLabels(scope, filePath, candidatePaths)].some((label) => {
    const escapedLabel = escapeRegExp(label.toLowerCase());
    return [
      new RegExp(`\\bbut\\s+not\\s+(?:edit\\s+)?${escapedLabel}${terminator}`),
      new RegExp(`\\bnot\\s+(?:edit\\s+)?${escapedLabel}${terminator}`),
      new RegExp(`\\bskip\\s+${escapedLabel}${terminator}`),
      new RegExp(`\\bdo\\s+not\\s+edit\\s+${escapedLabel}${terminator}`),
      new RegExp(`\\bdon't\\s+edit\\s+${escapedLabel}${terminator}`),
      new RegExp(`\\bdeny\\s+${escapedLabel}${terminator}`),
      new RegExp(`\\breject\\s+${escapedLabel}${terminator}`),
    ].some((pattern) => pattern.test(normalizedText));
  });
}

function listBuilderApprovalCandidates(scope: ResolvedBuilderScope): {
  kind: 'workflow' | 'facet';
  filePath: string;
}[] {
  return scope.roots.flatMap((root) => [
    ...listWorkflowFiles(join(root.rootDir, 'workflows')).map((filePath) => ({
      kind: 'workflow' as const,
      filePath,
    })),
    ...listFilesRecursive(join(root.rootDir, 'facets'), ['.md']).map((filePath) => ({
      kind: 'facet' as const,
      filePath,
    })),
  ]);
}

function pathIsMentionedInText(
  scope: ResolvedBuilderScope,
  filePath: string,
  text: string,
  candidatePaths?: string[],
): boolean {
  const normalizedText = text.toLowerCase();
  return [...pathMentionLabels(scope, filePath, candidatePaths)].some((label) => {
    const escapedLabel = escapeRegExp(label.toLowerCase());
    return new RegExp(`${PATH_MENTION_PREFIX}${escapedLabel}${PATH_MENTION_TERMINATOR}`).test(normalizedText);
  });
}

function pathMentionLabels(scope: ResolvedBuilderScope, filePath: string, candidatePaths?: string[]): Set<string> {
  const root = findBuilderRoot(scope, filePath);
  const labels = new Set([filePath]);
  addUniqueShortPathLabel(scope, labels, filePath, basename(filePath), candidatePaths);
  if (isWorkflowFile(filePath)) {
    addUniqueShortPathLabel(scope, labels, filePath, basename(filePath).replace(/\.ya?ml$/i, ''), candidatePaths);
  }
  if (root) {
    const relativePath = formatRelative(root.rootDir, filePath);
    labels.add(relativePath);
    if (isWorkflowFile(filePath)) {
      labels.add(relativePath.replace(/\.ya?ml$/i, ''));
    }
    if (root.lang) {
      labels.add(`${root.lang}:${relativePath}`);
    }
  }
  return labels;
}

function addUniqueShortPathLabel(
  scope: ResolvedBuilderScope,
  labels: Set<string>,
  filePath: string,
  label: string,
  candidatePaths?: string[],
): void {
  if (!candidatePaths) {
    labels.add(label);
    return;
  }
  const matches = candidatePaths.filter((candidatePath) => candidateShortPathLabels(scope, candidatePath).has(label));
  if (matches.length === 1 && matches[0] === filePath) {
    labels.add(label);
  }
}

function candidateShortPathLabels(scope: ResolvedBuilderScope, filePath: string): Set<string> {
  const labels = new Set([basename(filePath)]);
  if (isWorkflowFile(filePath)) {
    labels.add(basename(filePath).replace(/\.ya?ml$/i, ''));
  }
  const root = findBuilderRoot(scope, filePath);
  if (root?.lang) {
    labels.add(`${root.lang}:${basename(filePath)}`);
  }
  return labels;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
