import type { InternalAgentSeats } from '../models/config-types.js';
import type { AgentWorkflowStep, WorkflowConfig } from '../models/types.js';
import { internalAgentSeatOverride } from './internal-agent-seat.js';
import {
  COMPLETION_RETRY_JUDGE_NAME,
  COMPLETION_RETRY_SCHEMA_REF,
  buildCompletionRetryOutputSchema,
} from './completion-retry.js';

export function buildCompletionRetryJudgeStep(input: {
  readonly reviewerStepName: string;
  readonly workflowProvider?: WorkflowConfig['provider'];
  readonly workflowModel?: WorkflowConfig['model'];
  readonly internalAgentSeats?: InternalAgentSeats;
}): AgentWorkflowStep {
  const seat = internalAgentSeatOverride(input.internalAgentSeats?.completionRetryJudge);
  return {
    kind: 'agent',
    name: `_completion_retry_judge_${input.reviewerStepName}`,
    personaDisplayName: COMPLETION_RETRY_JUDGE_NAME,
    providerRoutingPersonaKey: COMPLETION_RETRY_JUDGE_NAME,
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
      schemaRef: COMPLETION_RETRY_SCHEMA_REF,
      schema: buildCompletionRetryOutputSchema(),
    },
  };
}
