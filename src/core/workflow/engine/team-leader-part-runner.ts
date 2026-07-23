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
import { getErrorMessage } from '../../../shared/utils/index.js';
import { classifyAbortSignalReason } from '../../../shared/types/agent-failure.js';
import { runWithPhaseSpan } from '../observability/workflowSpans.js';
import { buildSessionlessPartCompletionInspectionOptions } from './team-leader-part-completion-inspection.js';
import type {
  FindingContractControlValidationIssue,
} from '../team-leader-finding-contract-control-validation.js';

export interface TeamLeaderPartObservability {
  readonly enabled: boolean;
  readonly runId?: string;
  readonly workflowName: string;
  readonly iteration: number;
  readonly workflowStack?: WorkflowResumePointEntry[];
  readonly sanitizeText?: (text: string) => string;
}

export function buildPartScopedSessionKey(partStep: WorkflowStep, provider: ProviderType | undefined): string {
  const sessionKeyStep: AgentWorkflowStep = {
    kind: 'agent',
    name: partStep.name,
    persona: partStep.name,
    personaDisplayName: partStep.personaDisplayName,
    instruction: partStep.instruction,
  };
  return buildSessionKey(sessionKeyStep, provider);
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
  buildInstruction: (partStep: WorkflowStep) => string,
  runtime?: RuntimeStepResolution,
  executionAbortSignal?: AbortSignal,
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
  const { signal, dispose } = buildAbortSignal(
    defaultTimeoutMs,
    executionAbortSignal ?? baseOptions.abortSignal,
  );
  const options = parallelLogger
    ? {
      ...baseOptions,
      abortSignal: signal,
      onStream: optionsBuilder.buildProviderStream(
        partStep,
        partProviderInfo.provider,
        partProviderInfo.model,
        parallelLogger.createStreamHandler(part.id, partIndex),
      ),
    }
    : {
      ...baseOptions,
      abortSignal: signal,
    };

  try {
    const partInstruction = buildInstruction(partStep);
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
    if (response.sessionId !== undefined) {
      updatePersonaSession(buildPartScopedSessionKey(partStep, partProviderInfo.provider), response.sessionId);
    }
    return {
      part,
      providerInfo: partProviderInfo,
      response: {
        ...response,
        persona: partStep.name,
      },
    };
  } catch (error) {
    return {
      ...buildTeamLeaderErrorPartResult(step, part, error, signal),
      providerInfo: partProviderInfo,
    };
  } finally {
    dispose();
  }
}

export async function requestTeamLeaderPartCompletionCorrection(
  optionsBuilder: OptionsBuilder,
  step: WorkflowStep,
  part: PartDefinition,
  instruction: string,
  sessionId: string | undefined,
  abortSignal: AbortSignal,
  issues: readonly FindingContractControlValidationIssue[],
  runtime?: RuntimeStepResolution,
): Promise<AgentResponse> {
  const partStep = createPartStep(step, part);
  const schemaOptions = optionsBuilder.buildAgentOptions(partStep, runtime);
  let correctionOptions: RunAgentOptions;
  if (sessionId === undefined) {
    const newSessionOptions = optionsBuilder.buildNewSessionReportOptions(
      partStep,
      { allowedTools: [], maxTurns: undefined },
      runtime,
    );
    const inspectionOptions = buildSessionlessPartCompletionInspectionOptions(
      part,
      newSessionOptions.cwd,
      newSessionOptions.resolvedProvider,
      issues,
    );
    correctionOptions = {
      ...newSessionOptions,
      ...inspectionOptions,
    };
  } else {
    correctionOptions = optionsBuilder.buildResumeOptions(
      partStep,
      sessionId,
      { maxTurns: undefined },
      runtime,
    );
  }
  const response = await executeAgent(partStep.persona, instruction, {
    ...correctionOptions,
    abortSignal,
    outputSchema: schemaOptions.outputSchema,
  });
  return {
    ...response,
    persona: partStep.name,
  };
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
