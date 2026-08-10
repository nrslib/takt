import type { AgentResponse, WorkflowState, WorkflowStep } from '../../models/types.js';
import { isNormalAgentWorkflowStep } from '../../models/types.js';

/**
 * Prevents a companion step from entering post-execution condition evaluation
 * while its completion review is unresolved or could not be verified. A
 * verified loop escalation is evidence for the step's ordinary condition
 * judgment, not a request for user intervention.
 */
export function guardCompanionCompletion(
  step: WorkflowStep,
  state: WorkflowState,
  response: AgentResponse,
): AgentResponse {
  if (!isNormalAgentWorkflowStep(step) || step.companion === undefined) {
    return response;
  }

  const companion = state.companion;
  if (companion === undefined) {
    // A malformed direct invocation (or an old resume snapshot) must not let
    // an unverified companion step reach condition evaluation. Valid workflow
    // configurations reject companion + Finding Contract reviewer steps at
    // validation time; this branch remains a fail-closed runtime boundary.
    return {
      ...response,
      status: 'blocked',
    };
  }
  if (companion.completionVerified !== true) {
    return {
      ...response,
      status: 'blocked',
    };
  }
  if (companion.escalated || companion.openMustFixCount === 0) {
    return response;
  }

  return {
    ...response,
    status: 'blocked',
  };
}
