import type {
  WorkflowState,
  WorkflowSystemInput,
} from '../../../core/models/types.js';
import type { SystemStepInputResolutionContext } from '../../../core/workflow/system/system-step-services.js';
import type { IssueListItem } from '../../git/types.js';
import { fetchOpenIssueList } from './system-git-context.js';
import {
  getCachedCandidateSnapshot,
  readResolvedBinding,
  readResolvedBindingNumber,
  readPreviousSelectedNumber,
  selectNextCandidate,
} from './system-selection-helpers.js';

const SAFE_LABEL_CATEGORY_ALIASES: Record<string, string> = {
  automation: 'automation',
  bug: 'bug',
  ci: 'automation',
  dependencies: 'deps',
  deps: 'deps',
  docs: 'docs',
  documentation: 'docs',
  enhancement: 'enhancement',
  feature: 'enhancement',
  infra: 'infra',
  performance: 'performance',
  planning: 'planning',
  quality: 'quality',
  'quality-improvement': 'quality',
  regression: 'bug',
  security: 'security',
  'takt-managed': 'automation',
  test: 'testing',
  testing: 'testing',
  ui: 'ux',
  ux: 'ux',
  '品質改善': 'quality',
};

interface IssueOverlapMetadata {
  categoryCodes: string[];
  keywordSignals: Set<string>;
}

function normalizeLabelCategory(label: string): string | undefined {
  const normalized = label.trim().toLowerCase().replace(/\s+/g, '-');
  return SAFE_LABEL_CATEGORY_ALIASES[normalized] ?? SAFE_LABEL_CATEGORY_ALIASES[label.trim()];
}

function collectTitleKeywordSignals(title: string): Set<string> {
  const signals = new Set<string>();
  const segments = title.toLowerCase().match(/[\p{Letter}\p{Number}]+/gu) ?? [];

  for (const segment of segments) {
    if (/^[a-z0-9]+$/.test(segment)) {
      if (segment.length >= 3) {
        signals.add(segment);
      }
      continue;
    }
    if (segment.length >= 2) {
      signals.add(segment);
    }
    if (segment.length < 3) {
      continue;
    }
    for (let index = 0; index <= segment.length - 3; index += 1) {
      signals.add(segment.slice(index, index + 3));
    }
  }

  return signals;
}

function buildIssueOverlapMetadata(issue: IssueListItem): IssueOverlapMetadata {
  const categoryCodes = issue.labels
    .map(normalizeLabelCategory)
    .filter((label): label is string => label !== undefined);

  return {
    categoryCodes: [...new Set(categoryCodes)].sort(),
    keywordSignals: collectTitleKeywordSignals(issue.title),
  };
}

function countSharedValues<T>(left: Set<T>, right: Set<T>): number {
  let count = 0;
  for (const value of left) {
    if (right.has(value)) {
      count += 1;
    }
  }
  return count;
}

function calculateOverlapScore(
  left: IssueOverlapMetadata,
  right: IssueOverlapMetadata,
): number {
  const sharedCategories = countSharedValues(
    new Set(left.categoryCodes),
    new Set(right.categoryCodes),
  );
  const sharedKeywords = countSharedValues(left.keywordSignals, right.keywordSignals);
  return (sharedCategories * 5) + sharedKeywords;
}

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

function toIssueListSummary(
  issue: IssueListItem,
  candidates: IssueListItem[],
  metadataByNumber: Map<number, IssueOverlapMetadata>,
  selectedIssueMetadata?: IssueOverlapMetadata,
) {
  const currentMetadata = metadataByNumber.get(issue.number);
  if (!currentMetadata) {
    throw new Error(`Missing overlap metadata for issue #${issue.number}`);
  }

  const relatedOpenIssues = candidates
    .filter((candidate) => candidate.number !== issue.number)
    .map((candidate) => {
      const candidateMetadata = metadataByNumber.get(candidate.number);
      if (!candidateMetadata) {
        throw new Error(`Missing overlap metadata for issue #${candidate.number}`);
      }
      return {
        number: candidate.number,
        score: calculateOverlapScore(currentMetadata, candidateMetadata),
      };
    })
    .filter((candidate) => candidate.score > 0);

  const selectedIssueOverlapScore = selectedIssueMetadata
    ? calculateOverlapScore(currentMetadata, selectedIssueMetadata)
    : undefined;

  return {
    number: issue.number,
    category_codes: currentMetadata.categoryCodes,
    related_open_issue_numbers: relatedOpenIssues.map((candidate) => candidate.number),
    related_open_issue_count: relatedOpenIssues.length,
    duplicate_candidate: relatedOpenIssues.length > 0,
    max_related_issue_overlap_score: relatedOpenIssues.reduce(
      (maxScore, candidate) => Math.max(maxScore, candidate.score),
      0,
    ),
    ...(selectedIssueOverlapScore === undefined
      ? {}
      : {
          selected_issue_overlap_score: selectedIssueOverlapScore,
          selected_issue_duplicate_candidate: selectedIssueOverlapScore > 0,
        }),
  };
}

function toSelectedIssueSummary(issue: IssueListItem) {
  return {
    number: issue.number,
    title: issue.title,
  };
}

function selectIssueCandidate(
  candidates: IssueListItem[],
  state: WorkflowState | undefined,
  stepName: string | undefined,
  selectionBinding: string,
) {
  if (!state) {
    throw new Error(`${selectionBinding} requires workflow state`);
  }
  if (!stepName) {
    throw new Error(`${selectionBinding} requires step name`);
  }

  return selectNextCandidate(
    candidates,
    readPreviousSelectedNumber(state, stepName, selectionBinding),
  );
}

function readExcludedIssueNumber(
  selectionBinding: string,
  resolutionContext?: SystemStepInputResolutionContext,
): number | undefined {
  const resolvedBinding = readResolvedBinding(resolutionContext, selectionBinding);
  if (!resolvedBinding) {
    throw new Error(
      `issue_list.exclude_selected_from requires previously resolved issue_selection binding "${selectionBinding}"`,
    );
  }
  return readResolvedBindingNumber(resolutionContext, selectionBinding);
}

export function resolveIssueListInput(
  input: Extract<WorkflowSystemInput, { type: 'issue_list' }>,
  projectCwd: string,
  resolutionContext?: SystemStepInputResolutionContext,
) {
  const candidates = getIssueCandidateSnapshot(projectCwd, resolutionContext);
  const excludedIssueNumber = input.exclude_selected_from
    ? readExcludedIssueNumber(input.exclude_selected_from, resolutionContext)
    : undefined;
  const metadataByNumber = new Map(
    candidates.map((issue) => [issue.number, buildIssueOverlapMetadata(issue)]),
  );
  const selectedIssueMetadata = excludedIssueNumber === undefined
    ? undefined
    : metadataByNumber.get(excludedIssueNumber);
  const trackedIssues = candidates.filter((issue) => issue.number !== excludedIssueNumber);

  return trackedIssues.map((issue) => (
    toIssueListSummary(issue, trackedIssues, metadataByNumber, selectedIssueMetadata)
  ));
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
  const selectedIssue = selectIssueCandidate(candidates, state, stepName, input.as);
  if (!selectedIssue) {
    return { exists: false };
  }

  return {
    exists: true,
    ...toSelectedIssueSummary(selectedIssue),
  };
}
