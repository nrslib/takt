import { getAllParallelSubSteps, type WorkflowConfig, type WorkflowStep } from '../../core/models/index.js';
import { loadWorkflowByIdentifier, resolveWorkflowCallTarget } from '../../infra/config/index.js';
import { getWorkflowSourcePath } from '../../infra/config/loaders/workflowSourceMetadata.js';

export function validateGoalWorkflow(identifier: string, cwd: string): void {
  const workflow = loadWorkflowByIdentifier(identifier, cwd);
  if (workflow === null) throw new Error(`Workflow not found: ${identifier}`);
  const visited = new Set<string>();
  const visitWorkflow = (config: WorkflowConfig): void => {
    const key = JSON.stringify([getWorkflowSourcePath(config), config]);
    if (visited.has(key)) return;
    visited.add(key);
    for (const step of config.steps) visitStep(config, step);
  };
  const visitStep = (config: WorkflowConfig, step: WorkflowStep): void => {
    if (step.kind === 'system' && step.effects?.some((effect) => effect.type === 'merge_pr' || effect.type === 'close_pr')) {
      throw new Error('Goal workflows cannot merge or close pull requests');
    }
    if (step.kind === 'workflow_call') {
      const target = resolveWorkflowCallTarget(config, step, cwd, cwd);
      if (target === null) throw new Error(`Workflow call target not found: ${step.call}`);
      visitWorkflow(target);
    }
    if (step.parallel !== undefined) {
      for (const child of getAllParallelSubSteps(step.parallel)) visitStep(config, child);
    }
  };
  visitWorkflow(workflow);
}
