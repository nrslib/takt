import type { WorkflowPrListWhere } from '../../models/workflow-system-input-types.js';
import type { SystemStepPrListItem } from './system-step-services.js';

function matchesSimpleWildcard(value: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(value);
}

export function matchesPrWhere(pr: SystemStepPrListItem, where?: WorkflowPrListWhere): boolean {
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
