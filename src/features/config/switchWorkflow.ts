/**
 * Workflow switching command
 */

import {
  listWorkflowEntries,
  loadAllWorkflowsWithSources,
  getWorkflowCategories,
  buildCategorizedWorkflows,
  loadWorkflow,
  getCurrentWorkflow,
  setCurrentWorkflow,
} from '../../infra/config/index.js';
import { info, success, error } from '../../shared/ui/index.js';
import {
  warnMissingWorkflows,
  selectWorkflowFromCategorizedWorkflows,
  selectWorkflowFromEntries,
} from '../workflowSelection/index.js';

/**
 * Switch to a different workflow
 * @returns true if switch was successful
 */
export async function switchWorkflow(cwd: string, workflowName?: string): Promise<boolean> {
  // No workflow specified - show selection prompt
  if (!workflowName) {
    const current = getCurrentWorkflow(cwd);
    info(`Current workflow: ${current}`);

    const categoryConfig = getWorkflowCategories(cwd);
    let selected: string | null;
    if (categoryConfig) {
      const allWorkflows = loadAllWorkflowsWithSources(cwd);
      if (allWorkflows.size === 0) {
        info('No workflows found.');
        selected = null;
      } else {
        const categorized = buildCategorizedWorkflows(allWorkflows, categoryConfig);
        warnMissingWorkflows(categorized.missingWorkflows);
        selected = await selectWorkflowFromCategorizedWorkflows(categorized, current);
      }
    } else {
      const entries = listWorkflowEntries(cwd);
      selected = await selectWorkflowFromEntries(entries, current);
    }

    if (!selected) {
      info('Cancelled');
      return false;
    }

    workflowName = selected;
  }

  // Check if workflow exists
  const config = loadWorkflow(workflowName, cwd);

  if (!config) {
    error(`Workflow "${workflowName}" not found`);
    return false;
  }

  // Save to project config
  setCurrentWorkflow(cwd, workflowName);
  success(`Switched to workflow: ${workflowName}`);

  return true;
}
