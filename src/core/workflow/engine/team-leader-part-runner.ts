import { executeAgent } from '../../../agents/agent-usecases.js';
import type { RunAgentOptions } from '../../../agents/types.js';
import type { AgentWorkflowStep, PartDefinition, PartResult, WorkflowStep, AgentResponse, WorkflowResumePointEntry } from '../../models/types.js';
import type { RuntimeStepResolution } from '../types.js';
import { buildSessionKey } from '../session-key.js';
import { buildAbortSignal } from './abort-signal.js';
import type { OptionsBuilder } from './OptionsBuilder.js';
import type { ParallelLogger } from './parallel-logger.js';
import type { ProviderType } from '../../../shared/types/provider.js';
import { createPartStep } from './team-leader-common.js';
import { buildGitRules } from '../instruction/instruction-context.js';
import { renderFallbackNotice } from '../instruction/fallback-notice.js';
import { getErrorMessage } from '../../../shared/utils/index.js';
import { classifyAbortSignalReason } from '../../../shared/types/agent-failure.js';
import { runWithPhaseSpan } from '../observability/workflowSpans.js';

export interface TeamLeaderPartObservability {
  readonly enabled: boolean;
  readonly runId?: string;
  readonly workflowName: string;
  readonly iteration: number;
  readonly workflowStack?: WorkflowResumePointEntry[];
  readonly sanitizeText?: (text: string) => string;
}

function hasReportPhase(step: WorkflowStep): boolean {
  return step.outputContracts !== undefined && step.outputContracts.length > 0;
}

function buildPartScopedSessionKey(partStep: WorkflowStep, provider: ProviderType | undefined): string {
  const sessionKeyStep: AgentWorkflowStep = {
    kind: 'agent',
    name: partStep.name,
    persona: partStep.name,
    personaDisplayName: partStep.personaDisplayName,
    instruction: partStep.instruction,
  };
  return buildSessionKey(sessionKeyStep, provider);
}

function buildTeamLeaderPartSessionKey(
  step: WorkflowStep,
  partStep: WorkflowStep,
  provider: ProviderType | undefined,
): string {
  const partSessionKey = buildSessionKey(partStep, provider);
  const parentSessionKey = buildSessionKey(step, provider);

  if (hasReportPhase(step) && partSessionKey === parentSessionKey) {
    return buildPartScopedSessionKey(partStep, provider);
  }

  return partSessionKey;
}

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
  observability: TeamLeaderPartObservability,
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
    const response = await runWithPhaseSpan({
      enabled: observability.enabled,
      runId: observability.runId,
      workflowName: observability.workflowName,
      step: partStep,
      iteration: observability.iteration,
      phase: 1,
      phaseName: 'execute',
      instruction: partInstruction,
      workflowStack: observability.workflowStack,
      sanitizeText: observability.sanitizeText,
      providerInfo: partProviderInfo,
    }, () => executeAgent(partStep.persona, partInstruction, options), (result) => ({
      status: result.status,
      content: result.content,
      error: result.error,
      providerUsage: result.providerUsage,
    }));
    updatePersonaSession(buildTeamLeaderPartSessionKey(step, partStep, partProviderInfo.provider), response.sessionId);
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
