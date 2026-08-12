import type { InternalAgentSeats } from '../models/config-types.js';
import type { AgentWorkflowStep, WorkflowConfig } from '../models/types.js';
import { internalAgentSeatOverride } from './internal-agent-seat.js';
import {
  REVIEW_COMPLETION_JUDGE_NAME,
  REVIEW_COMPLETION_SCHEMA_REF,
  buildReviewCompletionOutputSchema,
} from './review-completion.js';

export function buildReviewCompletionJudgeStep(input: {
  readonly reviewerStepName: string;
  readonly workflowProvider?: WorkflowConfig['provider'];
  readonly workflowModel?: WorkflowConfig['model'];
  readonly internalAgentSeats?: InternalAgentSeats;
}): AgentWorkflowStep {
  const seat = internalAgentSeatOverride(input.internalAgentSeats?.reviewCompletionJudge);
  return {
    kind: 'agent',
    name: `_review_completion_judge_${input.reviewerStepName}`,
    personaDisplayName: REVIEW_COMPLETION_JUDGE_NAME,
    providerRoutingPersonaKey: REVIEW_COMPLETION_JUDGE_NAME,
    ...(seat ?? {
      provider: input.workflowProvider,
      providerSpecified: false,
      model: input.workflowModel,
      modelSpecified: false,
    }),
    instruction: '',
    session: 'refresh',
    edit: false,
    structuredOutput: {
      schemaRef: REVIEW_COMPLETION_SCHEMA_REF,
      schema: buildReviewCompletionOutputSchema(),
    },
  };
}
