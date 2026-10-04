import type { RunMeta } from '../../../core/workflow/run/run-meta.js';
import type { RunFinalization } from './workflowRunExecution.js';

export interface WorkflowRunForceFailHandle {
  readonly currentStep: string | undefined;
  terminalize(reason: string): Promise<RunFinalization>;
}

export interface WorkflowRunForceFailContext {
  readonly taskName: string;
  readonly meta: RunMeta;
}
