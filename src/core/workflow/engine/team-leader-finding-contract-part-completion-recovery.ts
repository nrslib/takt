import type {
  AgentResponse,
  FindingContractPartCompletionClaim,
  Language,
  PartDefinition,
  WorkflowStep,
} from '../../models/types.js';
import type { RuntimeStepResolution, StepProviderInfo } from '../types.js';
import type { OptionsBuilder } from './OptionsBuilder.js';
import type { StepExecutor } from './StepExecutor.js';
import { createPartStep } from './team-leader-common.js';
import {
  buildPartScopedSessionKey,
  requestTeamLeaderPartCompletionCorrection,
} from './team-leader-part-runner.js';
import {
  FindingContractPartCompletionValidationError,
  createFindingContractPartCompletionMutationGuard,
  createFindingContractPartCompletionStructuredOutputError,
  validateFindingContractPartCompletion,
  type FindingContractRejectedPartCompletionDigest,
} from '../team-leader-finding-contract-part-completion-validation.js';
import { buildFindingContractPartCompletionRecoveryPrompt } from '../../../agents/team-leader-part-completion-recovery-prompt.js';
import {
  requestValidFindingContractControlOutput,
  type FindingContractRecoveryAdapter,
  type FindingContractRecoveryAttemptEvent,
  type FindingContractRecoveryPromptContext,
} from './team-leader-finding-contract-recovery.js';
import type { FindingContractOperationBoundary } from './team-leader-finding-contract-operation-journal.js';
import type { TeamLeaderExecutionPublicationFence } from './team-leader-execution-terminal.js';
import { FindingContractAttemptUsageRecorder } from './finding-contract-attempt-usage-recorder.js';

type NormalizedPartCompletion = ReturnType<
  StepExecutor['normalizeStructuredOutputWithDiagnostics']
>;

interface PartCompletionRecoveryDependencies {
  readonly optionsBuilder: OptionsBuilder;
  readonly stepExecutor: StepExecutor;
  readonly language: Language | undefined;
  readonly recordUsage: (
    step: string,
    providerInfo: StepProviderInfo,
    success: boolean,
    usage: AgentResponse['providerUsage'],
  ) => void;
}

interface PartCompletionRecoveryInput {
  readonly step: WorkflowStep;
  readonly part: PartDefinition;
  readonly response: AgentResponse;
  readonly runtime?: RuntimeStepResolution;
  readonly updatePersonaSession: (persona: string, sessionId: string | undefined) => void;
  readonly onAttempt?: (
    event: FindingContractRecoveryAttemptEvent<FindingContractRejectedPartCompletionDigest>,
  ) => void;
  readonly operationBoundary?: FindingContractOperationBoundary;
  readonly abortSignal?: AbortSignal;
  readonly publicationFence?: TeamLeaderExecutionPublicationFence;
}

interface ValidatedPartCompletion {
  readonly response: AgentResponse;
  readonly claim: FindingContractPartCompletionClaim;
}

export async function validateOrRecoverFindingContractPartCompletion(
  deps: PartCompletionRecoveryDependencies,
  input: PartCompletionRecoveryInput,
): Promise<ValidatedPartCompletion> {
  const partStep = createPartStep(input.step, input.part);
  const initialNormalized = deps.stepExecutor.normalizeStructuredOutputWithDiagnostics(
    partStep,
    input.response,
    input.runtime,
  );
  const mutationGuard = createFindingContractPartCompletionMutationGuard(
    initialNormalized.response.structuredOutput,
    input.part,
  );
  let initialError: FindingContractPartCompletionValidationError;
  try {
    const claim = validatePartCompletionEnvelope(initialNormalized, input.part, mutationGuard);
    return {
      response: { ...initialNormalized.response, structuredOutput: { ...claim } },
      claim,
    };
  } catch (error) {
    if (!(error instanceof FindingContractPartCompletionValidationError)) throw error;
    initialError = error;
  }

  const accepted = input.operationBoundary?.readAccepted<ValidatedPartCompletion>();
  if (accepted !== undefined) {
    return {
      response: hydrateAgentResponse(accepted.response),
      claim: accepted.claim,
    };
  }
  const resumeState = input.operationBoundary?.recoveryResumeState<
    FindingContractRejectedPartCompletionDigest
  >();
  let latestSessionId = resumeState?.latestSessionId ?? input.response.sessionId;
  const usageRecorder = new FindingContractAttemptUsageRecorder();
  const adapter = createPartCompletionBoundaryAdapter({
    deps,
    input,
    partStep,
    mutationGuard,
    getLatestSessionId: () => latestSessionId,
  });

  return requestValidFindingContractControlOutput({
    abortSignal: input.abortSignal,
    initialValidationError: initialError,
    initialEnvelope: {
      raw: initialNormalized,
      attemptToken: 'part_completion:initial',
      ...(input.response.sessionId === undefined ? {} : { sessionId: input.response.sessionId }),
    },
    resumeState,
    adapter,
    onAttempt: (event) => {
      if (
        event.type === 'late'
        || (
          event.type === 'terminated'
          && input.publicationFence?.state !== undefined
          && input.publicationFence.state !== 'running'
        )
      ) {
        const providerInfo = resolvePartProvider(deps, partStep, input.runtime);
        usageRecorder.record(event.attemptToken, event.envelope?.usage, (usage) => {
          deps.recordUsage(partStep.name, providerInfo, false, usage);
        });
        return;
      }
      input.publicationFence?.assertRunning(`part.recovery.${event.type}`);
      if (
        (event.type === 'rejected' || event.type === 'accepted')
        && event.envelope?.sessionId !== undefined
      ) {
        latestSessionId = event.envelope.sessionId;
        const provider = resolvePartProvider(deps, partStep, input.runtime).provider;
        input.updatePersonaSession(
          buildPartScopedSessionKey(partStep, provider),
          latestSessionId,
        );
      }
      if (event.type !== 'started') {
        const providerInfo = resolvePartProvider(deps, partStep, input.runtime);
        usageRecorder.record(event.attemptToken, event.envelope?.usage, (usage) => {
          deps.recordUsage(partStep.name, providerInfo, event.type === 'accepted', usage);
        });
      }
      input.onAttempt?.(event);
      input.operationBoundary?.recordAttempt(event);
    },
  });
}

function createPartCompletionBoundaryAdapter(input: {
  readonly deps: PartCompletionRecoveryDependencies;
  readonly input: PartCompletionRecoveryInput;
  readonly partStep: WorkflowStep;
  readonly mutationGuard: ReturnType<typeof createFindingContractPartCompletionMutationGuard>;
  readonly getLatestSessionId: () => string | undefined;
}): FindingContractRecoveryAdapter<
  NormalizedPartCompletion,
  ValidatedPartCompletion,
  FindingContractRejectedPartCompletionDigest
> {
  return {
    boundaryKind: 'part_completion',
    requestOnce: async ({ recoveryContext, abortSignal, attemptToken }) => {
      const response = await requestCorrection(input, recoveryContext, abortSignal);
      const normalized = input.deps.stepExecutor.normalizeStructuredOutputWithDiagnostics(
        input.partStep,
        response,
        input.input.runtime,
      );
      return {
        raw: normalized,
        attemptToken,
        ...(response.sessionId === undefined ? {} : { sessionId: response.sessionId }),
        ...(response.providerUsage === undefined ? {} : { usage: response.providerUsage }),
      };
    },
    validate: (envelope) => {
      const claim = validatePartCompletionEnvelope(
        envelope.raw,
        input.input.part,
        input.mutationGuard,
      );
      const sessionId = envelope.sessionId ?? input.getLatestSessionId();
      return {
        response: {
          ...envelope.raw.response,
          structuredOutput: { ...claim },
          ...(sessionId === undefined ? {} : { sessionId }),
        },
        claim,
      };
    },
  };
}

async function requestCorrection(
  adapter: Parameters<typeof createPartCompletionBoundaryAdapter>[0],
  recoveryContext: FindingContractRecoveryPromptContext<FindingContractRejectedPartCompletionDigest>,
  abortSignal: AbortSignal,
): Promise<AgentResponse> {
  const rejection = recoveryContext.latestRejection;
  if (rejection === undefined) {
    throw new Error(`Part "${adapter.input.part.id}" completion recovery requires validation diagnostics`);
  }
  return requestTeamLeaderPartCompletionCorrection(
    adapter.deps.optionsBuilder,
    adapter.input.step,
    adapter.input.part,
    buildFindingContractPartCompletionRecoveryPrompt(
      adapter.input.part,
      recoveryContext,
      adapter.deps.language,
    ),
    adapter.getLatestSessionId(),
    abortSignal,
    rejection.issues,
    adapter.input.runtime,
  );
}

function validatePartCompletionEnvelope(
  normalized: NormalizedPartCompletion,
  part: PartDefinition,
  mutationGuard: ReturnType<typeof createFindingContractPartCompletionMutationGuard>,
): FindingContractPartCompletionClaim {
  if (normalized.invalidDetail !== undefined) {
    throw createFindingContractPartCompletionStructuredOutputError(
      part,
      normalized.invalidDetail,
      normalized.invalidKind ?? 'model_output',
      normalized.response.structuredOutput ?? normalized.response.content,
      normalized.invalidIssues,
    );
  }
  return validateFindingContractPartCompletion(
    normalized.response.structuredOutput,
    part,
    mutationGuard,
  );
}

function resolvePartProvider(
  deps: PartCompletionRecoveryDependencies,
  partStep: WorkflowStep,
  runtime: RuntimeStepResolution | undefined,
): StepProviderInfo {
  return deps.optionsBuilder.resolveStepProviderModel(partStep, runtime);
}

function hydrateAgentResponse(response: AgentResponse): AgentResponse {
  const timestamp: unknown = response.timestamp;
  return {
    ...response,
    timestamp: timestamp instanceof Date ? timestamp : new Date(String(timestamp)),
  };
}
