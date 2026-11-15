import { join, resolve, sep } from 'node:path';
import { REPORT_INTERNAL_NAMESPACE } from '../models/reserved-report-names.js';
import { artifactBoundary } from '../../shared/utils/private-path-identity.js';
import type { TaskReviewScope } from './review-scope.js';
import type { WorkflowStep } from '../models/types.js';

export function reviewCheckpointDirectory(reportDir: string): string {
  // Match Git's physical root for filesystem-root aliases such as /var on macOS,
  // without following repository-controlled artifact symlinks.
  return artifactBoundary(join(reportDir, REPORT_INTERNAL_NAMESPACE, 'review-checkpoints')).targetPath;
}

/** Paths are repository-root relative, matching TaskReviewScope. */
export function excludeReviewCheckpointPaths(paths: readonly string[], repositoryRoot: string, reportDir: string): string[] {
  const directory = resolve(reviewCheckpointDirectory(reportDir));
  return paths.filter((path) => {
    const absolute = resolve(repositoryRoot, path);
    return absolute !== directory && !absolute.startsWith(`${directory}${sep}`);
  });
}

export function excludeReviewCheckpointScope(scope: TaskReviewScope, repositoryRoot: string, reportDir: string): TaskReviewScope {
  return scope.kind === 'collected'
    ? { ...scope, paths: excludeReviewCheckpointPaths(scope.paths, repositoryRoot, reportDir) }
    : scope;
}

export interface ReviewCheckpointContext {
  readonly reportDir: string;
  readonly task: string;
  readonly reviewer: string;
  readonly definition: string;
  readonly scope: TaskReviewScope;
}

export function usesReviewCheckpoint(workflowName: string, step: Pick<WorkflowStep, 'name' | 'internalPromptContext'>): boolean {
  const reviewerName = step.internalPromptContext?.kind === 'team_part'
    ? step.internalPromptContext.ownerStepName : step.name;
  return workflowName === 'takt-development-review'
    && ['coding-review', 'ai-antipattern-review', 'architecture-review', 'security-review', 'testing-review'].includes(reviewerName);
}
