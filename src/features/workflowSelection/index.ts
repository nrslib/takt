import { info, warn } from '../../shared/ui/index.js';
import {
  loadAllStandaloneWorkflowsWithSources,
  listStandaloneWorkflowEntries,
  getWorkflowCategories,
  resolveIgnoredWorkflows,
  buildCategorizedWorkflows,
} from '../../infra/config/index.js';
import { DEFAULT_WORKFLOW_NAME } from '../../shared/constants.js';
export {
  buildWorkflowSelectionItems,
  buildTopLevelSelectOptions,
  parseCategorySelection,
  buildCategoryWorkflowOptions,
  applyBookmarks,
  warnMissingWorkflows,
  type WorkflowSelectionItem,
  type SelectionOption,
} from './options.js';
import { selectWorkflowFromCategorizedWorkflows } from './categorizedSelection.js';
import { selectWorkflowFromEntries } from './entrySelection.js';
import { warnMissingWorkflows } from './options.js';

export interface SelectWorkflowOptions {
  fallbackToDefault?: boolean;
}

export async function selectWorkflow(
  cwd: string,
  options?: SelectWorkflowOptions,
): Promise<string | null> {
  const fallbackToDefault = options?.fallbackToDefault !== false;
  const categoryConfig = getWorkflowCategories(cwd);

  if (categoryConfig) {
    const allWorkflows = loadAllStandaloneWorkflowsWithSources(cwd, { onWarning: warn });
    if (allWorkflows.size === 0) {
      if (fallbackToDefault) {
        info(`No workflows found. Using default workflow: ${DEFAULT_WORKFLOW_NAME}`);
        return DEFAULT_WORKFLOW_NAME;
      }
      info('No workflows found.');
      return null;
    }
    const categorized = buildCategorizedWorkflows(allWorkflows, categoryConfig, resolveIgnoredWorkflows(cwd));
    warnMissingWorkflows(categorized.missingWorkflows.filter((missing) => missing.source === 'user'));
    return selectWorkflowFromCategorizedWorkflows(categorized);
  }

  const entries = listStandaloneWorkflowEntries(cwd, { onWarning: warn });
  if (entries.length === 0) {
    if (fallbackToDefault) {
      info(`No workflows found. Using default workflow: ${DEFAULT_WORKFLOW_NAME}`);
      return DEFAULT_WORKFLOW_NAME;
    }
    info('No workflows found.');
    return null;
  }

  return selectWorkflowFromEntries(entries);
}
