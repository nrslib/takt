import type {
  WorkflowPrListWhere,
  WorkflowState,
  WorkflowSystemInput,
} from '../../../core/models/types.js';
import { stringifyWorkflowPrListWhere } from '../../../core/models/workflow-types.js';
import type {
  SystemStepGitProvider,
  SystemStepInputResolutionContext,
  SystemStepPrListItem,
} from '../../../core/workflow/system/system-step-services.js';
import { fetchOpenPrList } from './system-git-context.js';
import { matchesPrWhere } from '../../../core/workflow/system/pr-matcher.js';
import {
  getCachedCandidateSnapshot,
  readPreviousSelectedNumber,
  selectNextCandidate,
} from './system-selection-helpers.js';


function listMatchingPrs(
  projectCwd: string,
  where: WorkflowPrListWhere | undefined,
  gitProvider?: SystemStepGitProvider,
): SystemStepPrListItem[] {
  const openPrs = fetchOpenPrList(projectCwd, gitProvider);
  const filtered = openPrs.filter((pr) => matchesPrWhere(pr, where));
  filtered.sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  return filtered;
}

function getPrCandidateSnapshot(
  projectCwd: string,
  where: WorkflowPrListWhere | undefined,
  gitProvider: SystemStepGitProvider | undefined,
  resolutionContext?: SystemStepInputResolutionContext,
): SystemStepPrListItem[] {
  const cacheKey = `pr_candidates:${stringifyWorkflowPrListWhere(where)}`;
  return getCachedCandidateSnapshot(
    cacheKey,
    () => listMatchingPrs(projectCwd, where, gitProvider),
    resolutionContext,
  );
}

function toPrSummary({
  number,
  author,
  base_branch,
  head_branch,
  managed_by_takt,
  labels,
  same_repository,
  draft,
}: SystemStepPrListItem) {
  return {
    number,
    author,
    base_branch,
    head_branch,
    managed_by_takt,
    labels,
    same_repository,
    draft,
  };
}

export function resolvePrListInput(
  input: Extract<WorkflowSystemInput, { type: 'pr_list' }>,
  projectCwd: string,
  gitProvider?: SystemStepGitProvider,
  resolutionContext?: SystemStepInputResolutionContext,
) {
  return getPrCandidateSnapshot(projectCwd, input.where, gitProvider, resolutionContext).map(toPrSummary);
}

export function resolvePrSelectionInput(
  input: Extract<WorkflowSystemInput, { type: 'pr_selection' }>,
  projectCwd: string,
  gitProvider: SystemStepGitProvider | undefined,
  state: WorkflowState | undefined,
  stepName: string | undefined,
  resolutionContext?: SystemStepInputResolutionContext,
) {
  if (!state) {
    throw new Error('pr_selection requires workflow state');
  }
  if (!stepName) {
    throw new Error('pr_selection requires step name');
  }

  const candidates = getPrCandidateSnapshot(projectCwd, input.where, gitProvider, resolutionContext);
  const selectedPr = selectNextCandidate(
    candidates,
    readPreviousSelectedNumber(state, stepName, input.as),
  );
  if (!selectedPr) {
    return { exists: false };
  }

  return {
    exists: true,
    ...toPrSummary(selectedPr),
  };
}
