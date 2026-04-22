import type { WorkflowState } from '../../../core/models/types.js';
import type { SystemStepInputResolutionContext } from '../../../core/workflow/system/system-step-services.js';

interface NumberedCandidate {
  number: number;
}

export function getCachedCandidateSnapshot<T>(
  cacheKey: string,
  loadCandidates: () => T[],
  resolutionContext?: SystemStepInputResolutionContext,
): T[] {
  if (!resolutionContext) {
    return loadCandidates();
  }

  const cached = resolutionContext.cache.get(cacheKey);
  if (cached) {
    return cached as T[];
  }

  const candidates = loadCandidates();
  resolutionContext.cache.set(cacheKey, candidates);
  return candidates;
}

export function readPreviousSelectedNumber(
  state: WorkflowState,
  stepName: string,
  bindingName: string,
): number | undefined {
  const context = state.systemContexts.get(stepName);
  if (!context || typeof context !== 'object') {
    return undefined;
  }

  const selectedItem = (context as Record<string, unknown>)[bindingName];
  if (!selectedItem || typeof selectedItem !== 'object') {
    return undefined;
  }

  const number = (selectedItem as Record<string, unknown>).number;
  return typeof number === 'number' ? number : undefined;
}

export function selectNextCandidate<T extends NumberedCandidate>(
  candidates: T[],
  previousNumber: number | undefined,
): T | undefined {
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
