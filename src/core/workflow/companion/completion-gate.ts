import type { AgentResponse, WorkflowState, WorkflowStep } from '../../models/types.js';
import { isNormalAgentWorkflowStep } from '../../models/types.js';

/**
 * Prevents a companion step from entering post-execution condition evaluation
 * while its completion review is unresolved. A recorded advisory review
 * failure does not prevent the main workflow from evaluating its conditions.
 * A verified loop escalation is also evidence for ordinary condition judgment.
 */
export function guardCompanionCompletion(
  step: WorkflowStep,
  state: WorkflowState,
  response: AgentResponse,
): AgentResponse {
  if (!isNormalAgentWorkflowStep(step) || step.companion === undefined) {
    return response;
  }

  if (response.status === 'blocked' || response.status === 'error' || response.status === 'rate_limited') {
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
  if (companion.completionVerified !== true && companion.completionFailure !== true) {
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
