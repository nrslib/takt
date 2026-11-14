import { join, resolve, sep } from 'node:path';
import { REPORT_INTERNAL_NAMESPACE } from '../models/reserved-report-names.js';
import type { TaskReviewScope } from './review-scope.js';

export function reviewCheckpointDirectory(reportDir: string): string {
  return join(reportDir, REPORT_INTERNAL_NAMESPACE, 'review-checkpoints');
}

export function excludeReviewCheckpointPaths(paths: readonly string[], cwd: string, reportDir: string): string[] {
  const directory = resolve(reviewCheckpointDirectory(reportDir));
  return paths.filter((path) => {
    const absolute = resolve(cwd, path);
    return absolute !== directory && !absolute.startsWith(`${directory}${sep}`);
  });
}

export function excludeReviewCheckpointScope(scope: TaskReviewScope, cwd: string, reportDir: string): TaskReviewScope {
  return scope.kind === 'collected'
    ? { ...scope, paths: excludeReviewCheckpointPaths(scope.paths, cwd, reportDir) }
    : scope;
}

export interface ReviewCheckpointContext {
  readonly reportDir: string;
  readonly task: string;
  readonly reviewer: string;
  readonly definition: string;
  readonly scope: TaskReviewScope;
}

export function usesReviewCheckpoint(workflowName: string, stepName: string): boolean {
  return workflowName === 'takt-development-review'
    && ['coding-review', 'ai-antipattern-review', 'architecture-review', 'security-review', 'testing-review'].includes(stepName);
}
