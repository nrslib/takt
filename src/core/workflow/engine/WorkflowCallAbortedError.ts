import type { WorkflowStepFailureSummary } from '../types.js';

export class WorkflowCallAbortedError extends Error {
  constructor(readonly failure: WorkflowStepFailureSummary) {
    super(failure.reason);
    this.name = 'WorkflowCallAbortedError';
  }
}
