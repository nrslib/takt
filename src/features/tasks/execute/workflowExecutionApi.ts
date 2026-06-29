import { isAbsolute } from 'node:path';
import { executeWorkflow, executeWorkflowForRun, type WorkflowRunContext } from './workflowExecution.js';
import { executeTaskWorkflow } from './taskWorkflowExecution.js';
import type { ExecuteTaskOptions, WorkflowExecutionResult } from './types.js';

export type WorkflowExecutionRequest = ExecuteTaskOptions;
export type WorkflowExecutionRunContext = WorkflowRunContext;

function requireNonEmpty(value: string, fieldName: string): void {
  if (!value.trim()) {
    throw new Error(`${fieldName} is required`);
  }
}

function requireAbsolutePath(value: string, fieldName: string): void {
  requireNonEmpty(value, fieldName);
  if (!isAbsolute(value)) {
    throw new Error(`${fieldName} must be an absolute path`);
  }
}

export async function runWorkflowExecution(
  request: WorkflowExecutionRequest,
  runContext?: WorkflowExecutionRunContext,
): Promise<WorkflowExecutionResult> {
  requireAbsolutePath(request.cwd, 'cwd');
  requireAbsolutePath(request.projectCwd, 'projectCwd');
  requireNonEmpty(request.workflowIdentifier, 'workflowIdentifier');
  requireNonEmpty(request.task, 'task');

  if (runContext) {
    return executeTaskWorkflow(
      request,
      (workflowConfig, task, cwd, options) =>
        executeWorkflowForRun(workflowConfig, task, cwd, options, runContext),
    );
  }

  return executeTaskWorkflow(request, executeWorkflow);
}
