import { executeAgent } from '../../../agents/agent-usecases.js';
import type { RunAgentOptions } from '../../../agents/types.js';
import type { PartDefinition, PartResult, WorkflowStep, AgentResponse } from '../../models/types.js';
import type { RuntimeStepResolution } from '../types.js';
import { buildSessionKey } from '../session-key.js';
import { buildAbortSignal } from './abort-signal.js';
import type { OptionsBuilder } from './OptionsBuilder.js';
import type { ParallelLogger } from './parallel-logger.js';
import { createPartStep } from './team-leader-common.js';
import { buildGitRules } from '../instruction/instruction-context.js';
import { renderFallbackNotice } from '../instruction/fallback-notice.js';
import { getErrorMessage } from '../../../shared/utils/index.js';
import { classifyAbortSignalReason } from '../../../shared/types/agent-failure.js';

function buildTeamLeaderPartInstruction(
  partStep: WorkflowStep,
  part: PartDefinition,
  language: NonNullable<RunAgentOptions['language']>,
  runtime?: RuntimeStepResolution,
): string {
  const gitRules = buildGitRules(partStep.allowGitCommit, language, 'phase1');
  const fallbackNotice = runtime?.fallback
    ? renderFallbackNotice(runtime.fallback, language)
    : '';
  return [gitRules, fallbackNotice, part.instruction]
    .filter((item): item is string => typeof item === 'string' && item.length > 0)
    .join('\n\n');
}

export async function runTeamLeaderPart(
  optionsBuilder: OptionsBuilder,
  step: WorkflowStep,
  leaderWorkflowMeta: RunAgentOptions['workflowMeta'] | undefined,
  part: PartDefinition,
  partIndex: number,
  defaultTimeoutMs: number,
  updatePersonaSession: (persona: string, sessionId: string | undefined) => void,
  parallelLogger: ParallelLogger | undefined,
  runtime?: RuntimeStepResolution,
): Promise<PartResult> {
  const partStep = createPartStep(step, part);
  const partProviderInfo = runtime
    ? optionsBuilder.resolveStepProviderModel(partStep, runtime)
    : optionsBuilder.resolveStepProviderModel(partStep);
  const baseOptions = optionsBuilder.buildAgentOptions(partStep, {
    ...runtime,
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
    const partInstruction = buildTeamLeaderPartInstruction(
      partStep,
      part,
      options.language ?? 'en',
      runtime,
    );
    const response = await executeAgent(partStep.persona, partInstruction, options);
    updatePersonaSession(buildSessionKey(partStep, partProviderInfo.provider), response.sessionId);
    return {
      part,
      providerInfo: partProviderInfo,
      response: {
        ...response,
        persona: partStep.name,
      },
    };
  } catch (error) {
    return buildTeamLeaderErrorPartResult(step, part, error, signal);
  } finally {
    dispose();
  }
}

export function buildTeamLeaderErrorPartResult(
  step: WorkflowStep,
  part: PartDefinition,
  error: unknown,
  abortSignal?: AbortSignal,
): PartResult {
  const message = getErrorMessage(error);
  const failure = abortSignal?.aborted ? classifyAbortSignalReason(abortSignal.reason) : undefined;
  const errorMsg = failure ? failure.reason : message;
  const errorResponse: AgentResponse = {
    persona: `${step.name}.${part.id}`,
    status: 'error',
    content: '',
    timestamp: new Date(),
    error: errorMsg,
    ...(failure ? { failureCategory: failure.category } : {}),
  };
  return { part, response: errorResponse };
}
