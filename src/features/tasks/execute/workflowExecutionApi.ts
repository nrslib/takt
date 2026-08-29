import { isAbsolute } from 'node:path';
import { executeWorkflow, executeWorkflowForRun, type WorkflowRunContext } from './workflowExecution.js';
import { executeTaskWorkflow } from './taskWorkflowExecution.js';
import {
  createLoopAnalysisScheduler,
  LOOP_ANALYSIS_WORKFLOW,
} from './loopAnalysis.js';
import type {
  ExecuteTaskOptions,
  WorkflowExecutionOptions,
  WorkflowExecutionResult,
} from './types.js';

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
  return runWorkflowExecutionInternal(request, runContext, false);
}

export async function runLoopAnalysisWorkflowExecution(
  request: WorkflowExecutionRequest,
): Promise<WorkflowExecutionResult> {
  return runWorkflowExecutionInternal(request, undefined, true);
}

async function runWorkflowExecutionInternal(
  request: WorkflowExecutionRequest,
  runContext: WorkflowExecutionRunContext | undefined,
  isLoopAnalysisRun: boolean,
): Promise<WorkflowExecutionResult> {
  requireAbsolutePath(request.cwd, 'cwd');
  requireAbsolutePath(request.projectCwd, 'projectCwd');
  if (request.workflowResourceRoot !== undefined) {
    requireAbsolutePath(request.workflowResourceRoot, 'workflowResourceRoot');
  }
  requireNonEmpty(request.workflowIdentifier, 'workflowIdentifier');
  requireNonEmpty(request.task, 'task');

  const withLoopAnalysis = (
    workflowName: string,
    options: WorkflowExecutionOptions,
  ): WorkflowExecutionOptions => {
    const isLoopAnalysisWorkflow = isLoopAnalysisRun || workflowName === LOOP_ANALYSIS_WORKFLOW;
    if (isLoopAnalysisWorkflow) {
      return options;
    }
    // Central Web UI runs own all runtime artifacts under the state locator.
    // The legacy background loop-analysis worker still assumes project-local
    // session/config storage, so do not silently launch that fallback here.
    if (options.runPathsDirectory !== undefined) {
      return options;
    }
    const loopAnalysisScheduler = createLoopAnalysisScheduler({
      projectCwd: request.projectCwd,
      ...(options.loopAnalysisPublication === undefined
        ? {}
        : { publication: options.loopAnalysisPublication }),
    });
    return loopAnalysisScheduler === undefined
      ? options
      : { ...options, loopAnalysisScheduler };
  };

  return executeTaskWorkflow(
    request,
    runContext === undefined
      ? (workflowConfig, task, cwd, options) => executeWorkflow(
          workflowConfig,
          task,
          cwd,
          withLoopAnalysis(workflowConfig.name, options),
        )
      : (workflowConfig, task, cwd, options) => executeWorkflowForRun(
          workflowConfig,
          task,
          cwd,
          withLoopAnalysis(workflowConfig.name, options),
          runContext,
        ),
  );
}
