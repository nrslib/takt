import { getAllParallelSubSteps, type WorkflowConfig, type WorkflowStep } from '../../core/models/workflow-types.js';
import { loadWorkflowByIdentifier } from '../../infra/config/index.js';
import { resolveWorkflowCallTarget } from '../../infra/config/loaders/workflowCallResolver.js';
import { getWorkflowSourcePath } from '../../infra/config/loaders/workflowSourceMetadata.js';
import { safeExternalErrorMessage } from '../../shared/utils/safeExternalErrorMessage.js';
import { assertCwdAllowedByMcpRoot, errorResult, type McpOperationDependencies } from './operations.js';
import { pagedResult } from './response.js';
import type { GetWorkflowInput } from './schemas.js';

function allSteps(steps: readonly WorkflowStep[]): WorkflowStep[] {
  return steps.flatMap((step) => [step, ...(step.parallel === undefined ? [] : allSteps(getAllParallelSubSteps(step.parallel)))]);
}

function callTarget(workflow: WorkflowConfig, step: Extract<WorkflowStep, { kind: 'workflow_call' }>, cwd: string): WorkflowConfig {
  const child = resolveWorkflowCallTarget(workflow, step, cwd);
  if (child === null) throw new Error(`Workflow not found: ${step.call}`);
  return child;
}

function workflowCallSummary(workflow: WorkflowConfig, step: Extract<WorkflowStep, { kind: 'workflow_call' }>, getInput: GetWorkflowInput) {
  try {
    const child = callTarget(workflow, step, getInput.cwd);
    return { name: child.name, path: getWorkflowSourcePath(child), getInput };
  } catch (error) {
    return { call: step.call, error: safeExternalErrorMessage(error) };
  }
}

export function getTaktWorkflow(input: GetWorkflowInput, deps: McpOperationDependencies) {
  try {
    assertCwdAllowedByMcpRoot(input.cwd, deps.allowedProjectRoot);
    let workflow = loadWorkflowByIdentifier(input.workflow, input.cwd);
    if (workflow === null) throw new Error(`Workflow not found: ${input.workflow}`);
    const callPath = input.callPath ?? [];
    for (const index of callPath) {
      const step = allSteps(workflow.steps)[index];
      if (step?.kind !== 'workflow_call') throw new Error(`Workflow call not found at step index: ${index}`);
      workflow = callTarget(workflow, step, input.cwd);
    }
    const steps = allSteps(workflow.steps);
    const offset = input.offset ?? 0;
    const selected = steps.slice(offset, offset + (input.limit ?? 50)).map((step, index) => {
      return {
        name: step.name, description: step.description, kind: step.kind ?? 'agent',
        ...(step.kind === 'system' ? { wait: step.wait, system_inputs: step.systemInputs, effects: step.effects } : {}),
        rules: step.rules,
        ...(step.kind === 'workflow_call' ? { workflow_call: workflowCallSummary(workflow, step, {
          cwd: input.cwd, workflow: input.workflow, callPath: [...callPath, offset + index],
        }) } : {}),
      };
    });
    return pagedResult('steps', selected, steps.length, offset, false, {
      name: workflow.name, path: getWorkflowSourcePath(workflow), description: workflow.description,
      initialStep: workflow.initialStep,
    });
  } catch (error) { return errorResult('Workflow read failed', error); }
}
