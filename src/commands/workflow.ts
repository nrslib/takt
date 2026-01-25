/**
 * Workflow switching command
 */

import { listWorkflows, loadWorkflow, getBuiltinWorkflow } from '../config/index.js';
import { getCurrentWorkflow, setCurrentWorkflow } from '../config/paths.js';
import { info, success, error } from '../utils/ui.js';
import { selectOption } from '../prompt/index.js';

/**
 * Get all available workflow options
 */
function getAllWorkflowOptions(cwd: string): { label: string; value: string }[] {
  const current = getCurrentWorkflow(cwd);
  const workflows = listWorkflows();

  const options: { label: string; value: string }[] = [];

  // Add all workflows
  for (const name of workflows) {
    const isCurrent = name === current;
    const label = isCurrent ? `${name} (current)` : name;
    options.push({ label, value: name });
  }

  return options;
}

/**
 * Switch to a different workflow
 * @returns true if switch was successful
 */
export async function switchWorkflow(cwd: string, workflowName?: string): Promise<boolean> {
  // No workflow specified - show selection prompt
  if (!workflowName) {
    const current = getCurrentWorkflow(cwd);
    info(`Current workflow: ${current}`);

    const options = getAllWorkflowOptions(cwd);
    const selected = await selectOption('Select workflow:', options);

    if (!selected) {
      info('Cancelled');
      return false;
    }

    workflowName = selected;
  }

  // Check if workflow exists
  const config = getBuiltinWorkflow(workflowName) || loadWorkflow(workflowName);

  if (!config) {
    error(`Workflow "${workflowName}" not found`);
    return false;
  }

  // Save to project config
  setCurrentWorkflow(cwd, workflowName);
  success(`Switched to workflow: ${workflowName}`);

  return true;
}
