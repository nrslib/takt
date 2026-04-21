import type {
  WorkflowPrListWhere,
  WorkflowState,
  WorkflowSystemInput,
} from '../../../core/models/types.js';
import { stringifyWorkflowPrListWhere } from '../../../core/models/workflow-types.js';
import type { SystemStepInputResolutionContext } from '../../../core/workflow/system/system-step-services.js';
import type { PrListItem } from '../../git/types.js';
import { fetchOpenPrList } from './system-git-context.js';

function matchesSimpleWildcard(value: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(value);
}

function matchesPrWhere(pr: PrListItem, where?: WorkflowPrListWhere): boolean {
  if (where?.author !== undefined && pr.author !== where.author) {
    return false;
  }
  if (where?.base_branch !== undefined && pr.base_branch !== where.base_branch) {
    return false;
  }
  if (where?.head_branch !== undefined && !matchesSimpleWildcard(pr.head_branch, where.head_branch)) {
    return false;
  }
  if (where?.managed_by_takt !== undefined && pr.managed_by_takt !== where.managed_by_takt) {
    return false;
  }
  if (where?.labels !== undefined && !where.labels.every((label) => pr.labels.includes(label))) {
    return false;
  }
  if (where?.same_repository !== undefined && pr.same_repository !== where.same_repository) {
    return false;
  }
  if (where?.draft !== undefined && pr.draft !== where.draft) {
    return false;
  }
  return true;
}

function listMatchingPrs(projectCwd: string, where?: WorkflowPrListWhere): PrListItem[] {
  const openPrs = fetchOpenPrList(projectCwd);
  const filtered = openPrs.filter((pr) => matchesPrWhere(pr, where));
  filtered.sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  return filtered;
}

function getPrCandidateSnapshot(
  projectCwd: string,
  where: WorkflowPrListWhere | undefined,
  resolutionContext?: SystemStepInputResolutionContext,
): PrListItem[] {
  if (!resolutionContext) {
    return listMatchingPrs(projectCwd, where);
  }

  const cacheKey = `pr_candidates:${stringifyWorkflowPrListWhere(where)}`;
  const cached = resolutionContext.cache.get(cacheKey);
  if (cached) {
    return cached as PrListItem[];
  }

  const candidates = listMatchingPrs(projectCwd, where);
  resolutionContext.cache.set(cacheKey, candidates);
  return candidates;
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
}: PrListItem) {
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

function readPreviousSelectedPrNumber(
  state: WorkflowState,
  stepName: string,
  bindingName: string,
): number | undefined {
  const context = state.systemContexts.get(stepName);
  if (!context || typeof context !== 'object') {
    return undefined;
  }

  const selectedPr = (context as Record<string, unknown>)[bindingName];
  if (!selectedPr || typeof selectedPr !== 'object') {
    return undefined;
  }

  const number = (selectedPr as Record<string, unknown>).number;
  return typeof number === 'number' ? number : undefined;
}

function selectNextPr(candidates: PrListItem[], previousNumber: number | undefined): PrListItem | undefined {
  if (candidates.length === 0) {
    return undefined;
  }
  if (previousNumber === undefined) {
    return candidates[0];
  }

  const previousIndex = candidates.findIndex((candidate) => candidate.number === previousNumber);
  if (previousIndex === -1) {
    return candidates[0];
  }

  return candidates[(previousIndex + 1) % candidates.length];
}

export function resolvePrListInput(
  input: Extract<WorkflowSystemInput, { type: 'pr_list' }>,
  projectCwd: string,
  resolutionContext?: SystemStepInputResolutionContext,
) {
  return getPrCandidateSnapshot(projectCwd, input.where, resolutionContext).map(toPrSummary);
}

export function resolvePrSelectionInput(
  input: Extract<WorkflowSystemInput, { type: 'pr_selection' }>,
  projectCwd: string,
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

  const candidates = getPrCandidateSnapshot(projectCwd, input.where, resolutionContext);
  const selectedPr = selectNextPr(
    candidates,
    readPreviousSelectedPrNumber(state, stepName, input.as),
  );
  if (!selectedPr) {
    return { exists: false };
  }

  return {
    exists: true,
    ...toPrSummary(selectedPr),
  };
}
