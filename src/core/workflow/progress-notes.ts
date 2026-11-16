import { join, resolve, sep } from 'node:path';
import { REPORT_INTERNAL_NAMESPACE } from '../models/reserved-report-names.js';
import { artifactBoundary } from '../../shared/utils/private-path-identity.js';
import type { TaskReviewScope } from './review-scope.js';

export function progressNotesDirectory(reportDir: string): string {
  // Match Git's physical root for filesystem-root aliases such as /var on macOS,
  // without following repository-controlled artifact symlinks.
  return artifactBoundary(join(reportDir, REPORT_INTERNAL_NAMESPACE, 'progress-notes')).targetPath;
}

/** Paths are repository-root relative, matching TaskReviewScope. */
export function excludeProgressNotesPaths(paths: readonly string[], repositoryRoot: string, reportDir: string): string[] {
  const directory = resolve(progressNotesDirectory(reportDir));
  return paths.filter((path) => {
    const absolute = resolve(repositoryRoot, path);
    return absolute !== directory && !absolute.startsWith(`${directory}${sep}`);
  });
}

export function excludeProgressNotesScope(scope: TaskReviewScope, repositoryRoot: string, reportDir: string): TaskReviewScope {
  return scope.kind === 'collected'
    ? { ...scope, paths: excludeProgressNotesPaths(scope.paths, repositoryRoot, reportDir) }
    : scope;
}

export function composeRecoveryInstruction(recoveryBase: string, task: string): string {
  const baseBlocks = new Set(recoveryBase.split('\n\n').map((block) => block.trim()));
  const additionalBlocks: string[] = [];
  for (const candidate of task.split('\n\n')) {
    const block = candidate.trim();
    if (block.length > 0 && !baseBlocks.has(block)) {
      additionalBlocks.push(candidate);
    }
  }
  return [recoveryBase, ...additionalBlocks].filter((block) => block.length > 0).join('\n\n');
}

interface ProgressNotesStep {
  readonly reportDir: string;
  readonly task: string;
  readonly stepName: string;
  readonly definition: string;
}

/**
 * Attached to every workflow step's Phase 1 options within a run. Its presence makes the call eligible
 * for compaction recovery even when no notes can be stored.
 *
 * Only a step that cannot edit can tie its notes to the unchanged source revision, so only it carries
 * a scope: the one its Phase 1 instruction was built with. An editing step changes that revision
 * itself; its notes follow the step identity.
 */
export type ProgressNotesRequest = ProgressNotesStep & (
  | { readonly bindsSourceRevision: true; readonly scope: TaskReviewScope }
  | { readonly bindsSourceRevision: false }
);
