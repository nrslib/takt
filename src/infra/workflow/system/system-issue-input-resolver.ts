import type {
  WorkflowState,
  WorkflowSystemInput,
} from '../../../core/models/types.js';
import type { SystemStepInputResolutionContext } from '../../../core/workflow/system/system-step-services.js';
import type { IssueListItem } from '../../git/types.js';
import { fetchOpenIssueList } from './system-git-context.js';
import {
  getCachedCandidateSnapshot,
  readPreviousSelectedNumber,
  selectNextCandidate,
} from './system-selection-helpers.js';

function listMatchingIssues(projectCwd: string): IssueListItem[] {
  const issues = [...fetchOpenIssueList(projectCwd)];
  issues.sort((left, right) => {
    const updatedAtComparison = right.updated_at.localeCompare(left.updated_at);
    if (updatedAtComparison !== 0) {
      return updatedAtComparison;
    }
    return right.number - left.number;
  });
  return issues;
}

function getIssueCandidateSnapshot(
  projectCwd: string,
  resolutionContext?: SystemStepInputResolutionContext,
): IssueListItem[] {
  return getCachedCandidateSnapshot(
    'issue_candidates',
    () => listMatchingIssues(projectCwd),
    resolutionContext,
  );
}

function toIssueListSummary(issue: IssueListItem) {
  return {
    number: issue.number,
    title: issue.title,
  };
}

export function resolveIssueListInput(
  _input: Extract<WorkflowSystemInput, { type: 'issue_list' }>,
  projectCwd: string,
  resolutionContext?: SystemStepInputResolutionContext,
) {
  return getIssueCandidateSnapshot(projectCwd, resolutionContext).map(toIssueListSummary);
}

export function resolveIssueSelectionInput(
  input: Extract<WorkflowSystemInput, { type: 'issue_selection' }>,
  projectCwd: string,
  state: WorkflowState | undefined,
  stepName: string | undefined,
  resolutionContext?: SystemStepInputResolutionContext,
) {
  if (!state) {
    throw new Error('issue_selection requires workflow state');
  }
  if (!stepName) {
    throw new Error('issue_selection requires step name');
  }

  const candidates = getIssueCandidateSnapshot(projectCwd, resolutionContext);
  const selectedIssue = selectNextCandidate(
    candidates,
    readPreviousSelectedNumber(state, stepName, input.as),
  );
  if (!selectedIssue) {
    return { exists: false };
  }

  return {
    exists: true,
    ...toIssueListSummary(selectedIssue),
  };
}
