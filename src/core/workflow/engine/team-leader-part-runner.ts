import { executeAgent } from '../../../agents/agent-usecases.js';
import type { RunAgentOptions } from '../../../agents/types.js';
import type { AgentWorkflowStep, NormalAgentWorkflowStep, PartDefinition, PartResult, WorkflowStep, AgentResponse, WorkflowResumePointEntry } from '../../models/types.js';
import type { RuntimeStepResolution } from '../types.js';
import { buildSessionKey } from '../session-key.js';
import { buildAbortSignal } from './abort-signal.js';
import type { OptionsBuilder } from './OptionsBuilder.js';
import type { ParallelLogger } from './parallel-logger.js';
import type { ProviderType } from '../../../shared/types/provider.js';
import { createPartStep } from './team-leader-common.js';
import { getErrorMessage } from '../../../shared/utils/index.js';
import type { StepProviderInfo } from '../types.js';
import {
  classifyAbortSignalReason,
  isAgentFailureError,
} from '../../../shared/types/agent-failure.js';
import { hasWorkflowStepCallTimeoutGuard } from './step-deadline.js';
import { runWithPhaseSpan } from '../observability/workflowSpans.js';
import { isTeamLeaderPartCancellation } from './team-leader-part-cancellation.js';
import {
  ExplicitPartFailureError,
  OperationRecoveryError,
} from '../operations/operation-recovery-error.js';
import type { CompanionStepRuntime } from '../companion/step-runtime.js';

export interface TeamLeaderPartObservability {
  readonly enabled: boolean;
  readonly runId?: string;
  readonly workflowName: string;
  readonly iteration: number;
  readonly workflowStack?: WorkflowResumePointEntry[];
  readonly sanitizeText?: (text: string) => string;
}

export interface TeamLeaderPartExecutionOptions {
  readonly forceNewSession: boolean;
  readonly skipCompanionReview?: boolean;
  readonly onDispatch?: RunAgentOptions['onDispatch'];
  readonly composeOptions?: (options: RunAgentOptions) => RunAgentOptions;
  readonly deadlineSignal?: AbortSignal;
  readonly providerInfo: StepProviderInfo;
  readonly createCompanionRuntime?: (
    partStep: NormalAgentWorkflowStep,
    abortSignal: AbortSignal,
  ) => Promise<CompanionStepRuntime | undefined>;
  readonly completeCompanionReview?: (input: {
    readonly partStep: NormalAgentWorkflowStep;
    readonly initialResponse: AgentResponse;
    readonly agentOptions: RunAgentOptions;
    readonly companionRuntime: CompanionStepRuntime;
    readonly abortSignal: AbortSignal;
  }) => Promise<AgentResponse>;
}

export function buildPartScopedSessionKey(
  partStep: WorkflowStep,
  resolvedTarget: { provider: ProviderType | undefined; model: string | undefined },
): string {
  const sessionKeyStep: AgentWorkflowStep = {
    kind: 'agent',
    name: partStep.name,
    persona: partStep.name,
    personaDisplayName: partStep.personaDisplayName,
    instruction: partStep.instruction,
  };
  return buildSessionKey(sessionKeyStep, resolvedTarget);
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
  executionOptions?: TeamLeaderPartExecutionOptions,
): Promise<PartResult> {
  const partStep = createPartStep(step, part);
  const partStepForExecution = executionOptions?.skipCompanionReview === true
    ? { ...partStep, companion: undefined }
    : partStep;
  const partProviderInfo = executionOptions?.providerInfo
    ?? (runtime
      ? optionsBuilder.resolveStepProviderModel(partStepForExecution, runtime)
      : optionsBuilder.resolveStepProviderModel(partStepForExecution));
  const resolvedBaseOptions = optionsBuilder.buildAgentOptions(partStepForExecution, {
    ...runtime,
    providerInfo: partProviderInfo,
    teamLeaderPart: {
      partAllowedTools: step.teamLeader?.partAllowedTools,
      processSafety: leaderWorkflowMeta?.processSafety,
    },
  });
  const baseOptions = executionOptions?.forceNewSession === true
    ? { ...resolvedBaseOptions, sessionId: undefined }
    : resolvedBaseOptions;
  const deadlineSignal = executionOptions?.deadlineSignal;
  let signal: AbortSignal;
  let dispose: () => void;
  if (deadlineSignal === undefined) {
    const legacyDeadline = buildAbortSignal(
      defaultTimeoutMs,
      executionAbortSignal ?? baseOptions.abortSignal,
    );
    signal = legacyDeadline.signal;
    dispose = legacyDeadline.dispose;
  } else {
    const legacyDeadline = !hasWorkflowStepCallTimeoutGuard(
      partProviderInfo.provider,
      partProviderInfo.providerOptions,
    )
      ? buildAbortSignal(defaultTimeoutMs, executionAbortSignal ?? baseOptions.abortSignal)
      : undefined;
    const signals = [executionAbortSignal, deadlineSignal, legacyDeadline?.signal].filter(
      (candidate): candidate is AbortSignal => candidate !== undefined,
    );
    signal = signals.length === 1 ? signals[0]! : AbortSignal.any(signals);
    dispose = legacyDeadline?.dispose ?? (() => {});
  }
  const baseRunOptions = parallelLogger
    ? {
      ...baseOptions,
      abortSignal: signal,
      onDispatch: executionOptions?.onDispatch,
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
      onDispatch: executionOptions?.onDispatch,
    };
  try {
    const companionRuntime = await executionOptions?.createCompanionRuntime?.(partStepForExecution, signal);
    using activeCompanionRuntime = companionRuntime;
    activeCompanionRuntime?.beginReviewAttempt();
    const teamComposedOptions = executionOptions?.composeOptions?.(baseRunOptions) ?? baseRunOptions;
    const options = activeCompanionRuntime?.composeOptions(teamComposedOptions) ?? teamComposedOptions;
    const partInstruction = buildInstruction(partStepForExecution);
    const initialResponse = await runWithPhaseSpan({
      enabled: observability.enabled,
      runId: observability.runId,
      workflowName: observability.workflowName,
      step: partStepForExecution,
      iteration: observability.iteration,
      phase: 1,
      phaseName: 'execute',
      instruction: partInstruction,
      workflowStack: observability.workflowStack,
      sanitizeText: observability.sanitizeText,
      providerInfo: partProviderInfo,
    }, async () => {
      try {
        const result = await executeAgent(partStepForExecution.persona, partInstruction, options);
        if (isTeamLeaderPartCancellation(signal.reason)) {
          throw signal.reason;
        }
        return result;
      } catch (error) {
        if (isTeamLeaderPartCancellation(signal.reason)) {
          throw signal.reason;
        }
        throw error;
      }
    }, (result) => ({
      status: result.status,
      content: result.content,
      error: result.error,
      providerUsage: result.providerUsage,
    }), (error) => (
      isTeamLeaderPartCancellation(error)
        ? { status: 'cancelled' }
        : undefined
    ));
    const response = initialResponse.status === 'done'
      && activeCompanionRuntime !== undefined
      && executionOptions?.completeCompanionReview !== undefined
      ? await executionOptions.completeCompanionReview({
          partStep,
          initialResponse,
          agentOptions: options,
          companionRuntime: activeCompanionRuntime,
          abortSignal: signal,
        })
      : initialResponse;
    if (response.sessionId !== undefined) {
      updatePersonaSession(
        buildPartScopedSessionKey(partStepForExecution, {
          provider: partProviderInfo.provider,
          model: partProviderInfo.model,
        }),
        response.sessionId,
      );
    }
    return {
      part,
      providerInfo: partProviderInfo,
      response: {
        ...response,
        persona: partStepForExecution.name,
      },
    };
  } catch (error) {
    if (error instanceof OperationRecoveryError) {
      throw error;
    }
    if (isTeamLeaderPartCancellation(error)) {
      throw error;
    }
    if (isTeamLeaderPartCancellation(signal.reason)) {
      throw signal.reason;
    }
    return {
      ...buildTeamLeaderErrorPartResult(step, part, error, signal),
      providerInfo: partProviderInfo,
    };
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
  const errorMsg = failure ? failure.reason : isAgentFailureError(error) ? error.reason : message;
  const errorResponse: AgentResponse = {
    persona: `${step.name}.${part.id}`,
    status: 'error',
    content: '',
    timestamp: new Date(),
    error: errorMsg,
    ...(failure
      ? { failureCategory: failure.category }
      : isAgentFailureError(error)
        ? { failureCategory: error.failureCategory }
        : {}),
  };
  return { part, response: errorResponse };
}

export function createExplicitPartFailure(
  boundaryId: string,
  result: PartResult,
): ExplicitPartFailureError {
  return new ExplicitPartFailureError(
    result.response.error ?? result.response.content,
    { boundaryId },
  );
}
