import type { WorkflowMeta, WorkflowProcessSafetyMeta } from '../../../agents/types.js';

function attachWorkflowProcessSafety(
  workflowMeta: WorkflowMeta | undefined,
  processSafety: WorkflowProcessSafetyMeta | undefined,
): WorkflowMeta | undefined {
  if (!workflowMeta || workflowMeta.processSafety || !processSafety) {
    return workflowMeta;
  }

  return {
    ...workflowMeta,
    processSafety,
  };
}

export function buildPhase1WorkflowMeta(
  workflowMeta: WorkflowMeta | undefined,
  processSafety: WorkflowProcessSafetyMeta | undefined,
): WorkflowMeta | undefined {
  return attachWorkflowProcessSafety(workflowMeta, processSafety);
}
