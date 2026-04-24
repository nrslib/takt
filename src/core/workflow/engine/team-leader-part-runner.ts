import { executeAgent } from '../../../agents/agent-usecases.js';
import type { RunAgentOptions } from '../../../agents/types.js';
import type { PartDefinition, PartResult, WorkflowStep, AgentResponse } from '../../models/types.js';
import { buildSessionKey } from '../session-key.js';
import { buildAbortSignal } from './abort-signal.js';
import type { OptionsBuilder } from './OptionsBuilder.js';
import type { ParallelLogger } from './parallel-logger.js';
import { createPartStep } from './team-leader-common.js';
import { getErrorMessage } from '../../../shared/utils/index.js';

export async function runTeamLeaderPart(
  optionsBuilder: OptionsBuilder,
  step: WorkflowStep,
  leaderWorkflowMeta: RunAgentOptions['workflowMeta'] | undefined,
  part: PartDefinition,
  partIndex: number,
  defaultTimeoutMs: number,
  updatePersonaSession: (persona: string, sessionId: string | undefined) => void,
  parallelLogger: ParallelLogger | undefined,
): Promise<PartResult> {
  const partStep = createPartStep(step, part);
  const partProviderInfo = optionsBuilder.resolveStepProviderModel(partStep);
  const baseOptions = optionsBuilder.buildAgentOptions(partStep, {
    providerInfo: partProviderInfo,
    teamLeaderPart: {
      partAllowedTools: step.teamLeader?.partAllowedTools,
      processSafety: leaderWorkflowMeta?.processSafety,
    },
  });
  const { signal, dispose } = buildAbortSignal(defaultTimeoutMs, baseOptions.abortSignal);
  const options = parallelLogger
    ? {
      ...baseOptions,
      abortSignal: signal,
      onStream: parallelLogger.createStreamHandler(part.id, partIndex),
    }
    : {
      ...baseOptions,
      abortSignal: signal,
    };

  try {
    const response = await executeAgent(partStep.persona, part.instruction, options);
    updatePersonaSession(buildSessionKey(partStep, partProviderInfo.provider), response.sessionId);
    return {
      part,
      response: {
        ...response,
        persona: partStep.name,
      },
    };
  } finally {
    dispose();
  }
}

export function buildTeamLeaderErrorPartResult(
  step: WorkflowStep,
  part: PartDefinition,
  error: unknown,
): PartResult {
  const errorMsg = getErrorMessage(error);
  const errorResponse: AgentResponse = {
    persona: `${step.name}.${part.id}`,
    status: 'error',
    content: '',
    timestamp: new Date(),
    error: errorMsg,
  };
  return { part, response: errorResponse };
}
