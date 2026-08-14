import type {
  WorkflowStep,
  WorkflowState,
  AgentResponse,
  PartDefinition,
  PartResult,
  WorkflowMaxSteps,
  WorkflowResumePointEntry,
} from '../../models/types.js';
import { ParallelLogger } from './parallel-logger.js';
import { incrementStepIteration } from './state-manager.js';
import { createLogger, getErrorMessage } from '../../../shared/utils/index.js';
import { sanitizeSensitiveText } from '../../../shared/utils/sensitiveText.js';
import { truncateUtf8PreservingMarker, truncateUtf8WithMarker } from '../../../shared/utils/text.js';
import {
  AGENT_FAILURE_CATEGORIES,
  MAX_AGENT_FAILURE_MESSAGE_BYTES,
  createProviderStreamParseError,
  isProviderStreamParseError,
} from '../../../shared/types/agent-failure.js';
import { runTeamLeaderExecution } from './team-leader-execution.js';
import { buildTeamLeaderAggregatedContent } from './team-leader-aggregation.js';
import { createPartStep, createTeamLeaderPlanningStep, resolvePartErrorDetail, summarizeParts } from './team-leader-common.js';
import { buildTeamLeaderParallelLoggerOptions, emitTeamLeaderProgressHint } from './team-leader-streaming.js';
import {
  collectUncoveredPartTimeoutIds,
  createTimeoutContinuationFeedback,
  hasFailedTimeoutContinuationResult,
} from './team-leader-timeout-fallback.js';
import type { RunAgentOptions } from '../../../agents/types.js';
import type {
  MorePartsResponse,
} from '../../../agents/decompose-task-usecase.js';
import type { OptionsBuilder } from './OptionsBuilder.js';
import type { StepExecutor } from './StepExecutor.js';
import type {
  WorkflowEngineOptions,
  WorkflowOperationJournalContext,
  PhaseName,
  PhasePromptParts,
} from '../types.js';
import type { RuntimeStepResolution, StepProviderInfo, StepRunResult } from '../types.js';
import {
  buildTeamLeaderErrorPartResult,
  runTeamLeaderPart,
} from './team-leader-part-runner.js';
import { runWithPhaseSpan } from '../observability/workflowSpans.js';
import { buildPhaseExecutionId } from '../../../shared/utils/phaseExecutionId.js';
import { resolveInspectToolsForProvider } from './engine-provider-options.js';
import {
  createRoutingScope,
  resolveAutoRoutingBatch,
  resolveAutoRoutingRuntime,
} from '../auto-routing/resolver.js';
import { buildRoutingWorkSnapshot } from '../auto-routing/snapshot.js';
import { InstructionBuildTransaction } from './instruction-build-transaction.js';
import { recordAgentUsageEvent } from './agent-usage-event.js';
import type { RunPaths } from '../run/run-paths.js';
import type {
  TeamLeaderExecutionPublicationFence,
} from './team-leader-execution-terminal.js';
import { createAbortScope } from './abort-signal.js';
import { isTeamLeaderPartCancellation } from './team-leader-part-cancellation.js';
import type {
  WorkflowStepInactivityDeadline,
  WorkflowStepExecutionDeadlineContext,
} from './step-deadline.js';

const log = createLogger('team-leader-runner');

async function runWithExecutionDeadline<T>(
  context: WorkflowStepExecutionDeadlineContext | undefined,
  deadline: WorkflowStepInactivityDeadline | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  if (context === undefined || deadline === undefined) {
    return operation();
  }
  return context.runWith(deadline, operation);
}

function combineAbortSignals(signals: readonly (AbortSignal | undefined)[]): AbortSignal | undefined {
  const activeSignals = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (activeSignals.length === 0) {
    return undefined;
  }
  if (activeSignals.length === 1) {
    return activeSignals[0];
  }
  return AbortSignal.any(activeSignals);
}

function truncateTeamLeaderFailureContent(text: string): string {
  if (Buffer.byteLength(text, 'utf8') <= MAX_AGENT_FAILURE_MESSAGE_BYTES) {
    return text;
  }

  const markers = text.match(/\[TRUNCATED: [^\]]+\]/gu);
  if (markers === null || markers.length < 2) {
    return truncateUtf8PreservingMarker(text, MAX_AGENT_FAILURE_MESSAGE_BYTES);
  }

  const markerSuffix = markers.join(' ');
  const textWithoutMarkers = text.replace(/\[TRUNCATED: [^\]]+\]/gu, '').trimEnd();
  const textWithMarkersAtEnd = textWithoutMarkers.length === 0
    ? markerSuffix
    : `${textWithoutMarkers} ${markerSuffix}`;
  return truncateUtf8WithMarker(
    textWithMarkersAtEnd,
    MAX_AGENT_FAILURE_MESSAGE_BYTES,
    () => markerSuffix,
  );
}

function selectPrimaryTeamLeaderFailure(failedResults: readonly PartResult[]): PartResult {
  const primaryFailure = failedResults.find(
    (result) => result.response.failureCategory === AGENT_FAILURE_CATEGORIES.PROVIDER_ERROR,
  )
    ?? failedResults.find((result) => result.response.failureCategory !== undefined)
    ?? failedResults[0];
  if (primaryFailure === undefined) {
    throw new Error('Team leader failure aggregation requires at least one failed part');
  }
  return primaryFailure;
}

export interface TeamLeaderRunnerDeps {
  readonly optionsBuilder: OptionsBuilder;
  readonly stepExecutor: StepExecutor;
  readonly engineOptions: WorkflowEngineOptions;
  readonly getAbortSignal?: () => AbortSignal | undefined;
  readonly getCwd: () => string;
  readonly getTask: () => string;
  readonly getState: () => WorkflowState;
  readonly getWorkflowName: () => string;
  readonly getInteractive: () => boolean;
  readonly getRunPaths: () => RunPaths;
  readonly operationJournal?: WorkflowOperationJournalContext;
  readonly observabilityEnabled: boolean;
  readonly observabilityRunId?: string;
  readonly sanitizeObservabilityText?: (text: string) => string;
  readonly getCurrentWorkflowStack?: () => WorkflowResumePointEntry[] | undefined;
  readonly onPhaseStart?: (
    step: WorkflowStep,
    phase: 1 | 2 | 3,
    phaseName: PhaseName,
    instruction: string,
    promptParts: PhasePromptParts,
    phaseExecutionId?: string,
    iteration?: number,
  ) => void;
  readonly onPhaseComplete?: (
    step: WorkflowStep,
    phase: 1 | 2 | 3,
    phaseName: PhaseName,
    content: string,
    status: string,
    error?: string,
    phaseExecutionId?: string,
    iteration?: number,
  ) => void;
  readonly emitEvent: (
    event: 'routing:decision',
    step: WorkflowStep,
    response: AgentResponse,
    instruction: string,
    providerInfo: StepProviderInfo,
    stepType: 'normal' | 'parallel' | 'agent',
    durationMs: number,
    iteration: number,
    workflowName: string,
  ) => void;
}

export class TeamLeaderRunner {
  constructor(
    private readonly deps: TeamLeaderRunnerDeps,
  ) {}

  private resolveAbortSignal(): AbortSignal | undefined {
    return this.deps.getAbortSignal?.() ?? this.deps.engineOptions.abortSignal;
  }

  async runTeamLeaderStep(
    step: WorkflowStep,
    state: WorkflowState,
    task: string,
    maxSteps: WorkflowMaxSteps,
    updatePersonaSession: (persona: string, sessionId: string | undefined) => void,
    runtime?: RuntimeStepResolution,
    activeStepIteration?: number,
    executionDeadlineContext?: WorkflowStepExecutionDeadlineContext,
  ): Promise<StepRunResult> {
    if (!step.teamLeader) {
      throw new Error(`Step "${step.name}" has no teamLeader configuration`);
    }
    const teamLeaderConfig = step.teamLeader;
    const parentIteration = state.iteration;
    const attemptState = captureTeamLeaderAttemptState(state, step.name, activeStepIteration);
    const instructionTransaction = new InstructionBuildTransaction();

    const stepIteration = activeStepIteration ?? incrementStepIteration(state, step.name);
    const leaderStep = createTeamLeaderPlanningStep(step);
    const instruction = this.deps.stepExecutor.buildInstruction(
      leaderStep,
      stepIteration,
      state,
      task,
      maxSteps,
      runtime?.fallback,
      instructionTransaction,
    );
    const leaderRuntime = await this.resolveLeaderAutoRouting(leaderStep, runtime);
    const leaderProviderInfo = this.deps.optionsBuilder.resolveStepProviderModel(leaderStep, leaderRuntime);
    const { provider: leaderProvider, model: leaderModel } = leaderProviderInfo;
    const leaderDeadline = executionDeadlineContext?.begin('team-leader:leader', leaderProviderInfo);
    const leaderBaseOptions = this.deps.optionsBuilder.buildBaseOptions(
      leaderStep,
      undefined,
      leaderRuntime,
    );
    const leaderWorkflowMeta = this.deps.optionsBuilder.buildPhase1WorkflowMeta(
      leaderBaseOptions.workflowMeta,
    );
    const leaderAbortSignal = combineAbortSignals([
      leaderBaseOptions.abortSignal,
      leaderDeadline?.signal,
    ]);
    const inspectTools = resolveInspectToolsForProvider(teamLeaderConfig.inspectTools, leaderProvider);
    const leaderMcpServers = this.deps.optionsBuilder.resolveMcpServersForStep(leaderStep, leaderProvider);

    emitTeamLeaderProgressHint(this.deps.engineOptions, 'decompose');
    let didEmitPhaseStart = false;
    let resolvedPromptParts: PhasePromptParts | undefined;
    const phaseExecutionId = buildPhaseExecutionId({
      step: leaderStep.name,
      iteration: parentIteration,
      phase: 1,
      sequence: 1,
    });
    const structuredCaller = this.deps.engineOptions.structuredCaller;
    if (!structuredCaller) {
      throw new Error('structuredCaller is required for team leader execution');
    }
    const leaderStartedAt = Date.now();
    const buildDecompositionOptions = () => ({
      cwd: this.deps.getCwd(),
      persona: leaderStep.persona,
      personaPath: leaderStep.personaPath,
      workflowBundleResourceRoot: this.deps.engineOptions.workflowBundleResourceRoot,
      model: leaderModel,
      provider: leaderProvider,
      resolvedModel: leaderModel,
      resolvedProvider: leaderProvider,
      resolvedProviderOptions: leaderProviderInfo.providerOptions,
      permissionMode: leaderProviderInfo.permissionMode,
      projectCwd: this.deps.engineOptions.projectCwd,
      language: this.deps.engineOptions.language,
      inspectTools,
      mcpServers: leaderMcpServers,
      workflowMeta: leaderWorkflowMeta,
      childProcessEnv: this.deps.engineOptions.childProcessEnv,
      failureDir: leaderBaseOptions.failureDir,
      abortSignal: leaderAbortSignal,
      onStream: leaderBaseOptions.onStream,
      onActivity: leaderBaseOptions.onActivity,
      onAgentResponse: (response: AgentResponse) => {
        this.recordUsage(
          leaderStep.name,
          leaderProviderInfo,
          response.status === 'done'
            && leaderBaseOptions.abortSignal?.aborted !== true,
          response.providerUsage,
        );
      },
      onAgentError: () => {
        this.recordUsage(leaderStep.name, leaderProviderInfo, false);
      },
      onPromptResolved: (promptParts: PhasePromptParts) => {
        if (didEmitPhaseStart) return;
        resolvedPromptParts = promptParts;
        this.deps.onPhaseStart?.(
          leaderStep,
          1,
          'execute',
          promptParts.userInstruction,
          promptParts,
          phaseExecutionId,
          parentIteration,
        );
        didEmitPhaseStart = true;
      },
    });
    const requestDecomposition = () => {
      return structuredCaller.decomposeTask(
        instruction,
        teamLeaderConfig.initialMaxParts,
        buildDecompositionOptions(),
      );
    };
    const decomposition = await runWithExecutionDeadline(
      executionDeadlineContext,
      leaderDeadline,
      () => runWithPhaseSpan(
        {
          enabled: this.deps.observabilityEnabled,
          runId: this.deps.observabilityRunId,
          workflowName: this.deps.getWorkflowName(),
          step: leaderStep,
          iteration: parentIteration,
          phase: 1,
          phaseName: 'execute',
          instruction,
          phaseExecutionId,
          workflowStack: this.deps.getCurrentWorkflowStack?.(),
          sanitizeText: this.deps.sanitizeObservabilityText,
          providerInfo: leaderProviderInfo,
          getPromptParts: () => resolvedPromptParts,
        },
        requestDecomposition,
        (result) => ({
          status: 'done',
          content: JSON.stringify({ parts: result.parts }, null, 2),
        }),
      ),
    );
    const parts = decomposition.parts;
    if (!didEmitPhaseStart) {
      throw new Error(`Missing prompt parts for phase start: ${leaderStep.name}:1`);
    }
    const leaderResponse: AgentResponse = {
      persona: leaderStep.persona ?? leaderStep.name,
      status: 'done',
      content: JSON.stringify({ parts }, null, 2),
      timestamp: new Date(),
    };
    this.deps.onPhaseComplete?.(leaderStep, 1, 'execute', leaderResponse.content, leaderResponse.status, leaderResponse.error, phaseExecutionId, parentIteration);
    this.emitLeaderRoutingDecisionEvent(
      leaderStep,
      leaderResponse,
      instruction,
      leaderProviderInfo,
      Math.max(0, Date.now() - leaderStartedAt),
      parentIteration,
    );
    this.recordRoutingResult(
      createRoutingScope({
        workflow: this.deps.getWorkflowName(),
        parentStep: step.name,
        workItem: 'leader',
      }),
      leaderProviderInfo,
      leaderResponse,
    );
    log.debug('Team leader decomposed parts', {
      step: step.name,
      partCount: parts.length,
      partIds: parts.map((part) => part.id),
    });
    log.info('Team leader decomposition completed', {
      step: step.name,
      partCount: parts.length,
      parts: summarizeParts(parts),
    });

    const parallelLogger = this.deps.engineOptions.onStream
      ? new ParallelLogger(buildTeamLeaderParallelLoggerOptions(
        this.deps.engineOptions,
        step.name,
        stepIteration,
        parts.map((part) => part.id),
        state.iteration,
        maxSteps,
      ))
      : undefined;
    const coveredTimedOutPartIds = new Set<string>();
    const routedProviderInfoByPart = await runWithExecutionDeadline(
      executionDeadlineContext,
      leaderDeadline,
      () => this.resolvePartAutoRouting(step, parts, runtime),
    );

    const executionAbortScope = createAbortScope(leaderBaseOptions.abortSignal);
    let executionResult: Awaited<ReturnType<typeof runTeamLeaderExecution>>;
    try {
      executionResult = await runWithExecutionDeadline(
        executionDeadlineContext,
        leaderDeadline,
        () => runTeamLeaderExecution({
        initialParts: parts,
        maxConcurrency: teamLeaderConfig.maxConcurrency,
        abortSignal: executionAbortScope.signal,
        onTerminalError: (error) => {
          executionAbortScope.abort(error);
        },
      onPartQueued: (part) => {
        parallelLogger?.addSubStep(part.id);
      },
      onPartCompleted: (result) => {
        const acceptedResult = structuredClone(result) as PartResult;
        state.stepOutputs.set(acceptedResult.response.persona, acceptedResult.response);
      },
      onPlanningDone: ({ reason, plannedParts: plannedCount, completedParts }) => {
        log.info('Team leader marked planning as done', {
          step: step.name,
          plannedParts: plannedCount,
          completedParts,
          reasoning: reason,
        });
      },
      onPlanningNoNewParts: ({ reason, plannedParts: plannedCount, completedParts }) => {
        log.info('Team leader returned no new unique parts; stop planning', {
          step: step.name,
          plannedParts: plannedCount,
          completedParts,
          reasoning: reason,
        });
      },
      onPartsAdded: ({ parts: addedParts, reason, totalPlanned }) => {
        log.info('Team leader added new parts', {
          step: step.name,
          addedCount: addedParts.length,
          totalPlannedAfterAdd: totalPlanned,
          parts: summarizeParts(structuredClone(addedParts) as PartDefinition[]),
          reasoning: reason,
        });
      },
      onPlanningError: (error) => {
        log.info('Team leader feedback failed; stop adding new parts', {
          step: step.name,
          detail: getErrorMessage(error),
        });
      },
      requestMoreParts: async ({
        partResults: currentResults,
        latestBatchResults: _latestBatchResults,
        completedPartResults: _completedPartResults,
        plannedParts: _currentPlannedParts,
        scheduledIds,
        cancellablePartIds,
        abortSignal: feedbackAbortSignal,
      }) => {
        const currentResultsCopy = structuredClone(currentResults) as PartResult[];
        const scheduledIdsCopy = [...scheduledIds];
        const cancellablePartIdsCopy = [...cancellablePartIds];
        emitTeamLeaderProgressHint(this.deps.engineOptions, 'feedback');
        const feedbackResults = currentResultsCopy.map((result) => ({
          id: result.part.id,
          title: result.part.title,
          status: result.response.status,
          content: result.response.status === 'error'
            ? `[ERROR] ${resolvePartErrorDetail(result)}`
            : result.response.content,
        }));
        const feedbackSignal = leaderDeadline?.signal === undefined
          ? feedbackAbortSignal
          : AbortSignal.any([feedbackAbortSignal, leaderDeadline.signal]);
        try {
          const buildFeedbackOptions = (abortSignal: AbortSignal) => ({
            cwd: this.deps.getCwd(),
            persona: leaderStep.persona,
            personaPath: leaderStep.personaPath,
            workflowBundleResourceRoot: this.deps.engineOptions.workflowBundleResourceRoot,
            language: this.deps.engineOptions.language,
            model: leaderModel,
            provider: leaderProvider,
            resolvedModel: leaderModel,
            resolvedProvider: leaderProvider,
            resolvedProviderOptions: leaderProviderInfo.providerOptions,
            permissionMode: leaderProviderInfo.permissionMode,
            projectCwd: this.deps.engineOptions.projectCwd,
            mcpServers: leaderMcpServers,
            workflowMeta: leaderWorkflowMeta,
            childProcessEnv: this.deps.engineOptions.childProcessEnv,
            failureDir: leaderBaseOptions.failureDir,
            cancellablePartIds: cancellablePartIdsCopy,
            abortSignal,
            onStream: leaderBaseOptions.onStream,
            onActivity: leaderBaseOptions.onActivity,
            onAgentResponse: (response: AgentResponse) => {
              this.recordUsage(
                leaderStep.name,
                leaderProviderInfo,
                response.status === 'done' && !abortSignal.aborted,
                response.providerUsage,
              );
            },
            onAgentError: () => {
              this.recordUsage(leaderStep.name, leaderProviderInfo, false);
            },
          });
          const feedbackInstruction = instruction;
          const requestFeedback = async (abortSignal: AbortSignal) => structuredCaller.requestMoreParts(
            feedbackInstruction,
            feedbackResults,
            scheduledIdsCopy,
            buildFeedbackOptions(abortSignal),
          );
          const moreParts: MorePartsResponse = await requestFeedback(feedbackSignal);
          await this.addPartAutoRouting(routedProviderInfoByPart, step, moreParts.parts, runtime);
          return moreParts;
        } catch (error) {
          if (feedbackSignal.aborted) {
            throw error;
          }
          if (isProviderStreamParseError(error)) {
            throw error;
          }
          const timeoutFallback = createTimeoutContinuationFeedback({
            partResults: currentResultsCopy,
            scheduledIds: scheduledIdsCopy,
            coveredTimedOutPartIds,
            language: this.deps.engineOptions.language,
          });
          if (timeoutFallback) {
            if (timeoutFallback.parts.length > 0) {
              for (const partId of collectUncoveredPartTimeoutIds(currentResultsCopy, coveredTimedOutPartIds)) {
                coveredTimedOutPartIds.add(partId);
              }
            }
            log.info('Team leader feedback failed; using timeout continuation fallback', {
              step: step.name,
              detail: getErrorMessage(error),
              parts: summarizeParts(timeoutFallback.parts),
            });
            await this.addPartAutoRouting(routedProviderInfoByPart, step, timeoutFallback.parts, runtime);
            return timeoutFallback;
          }
          throw error;
        }
      },
        runPart: async (part, partIndex, publicationFence, partAbortSignal) => {
          const partRuntime = this.buildPartRuntime(runtime, routedProviderInfoByPart.get(part.id));
          const partStep = createPartStep(step, part);
          const partProviderInfo = this.deps.optionsBuilder.resolveStepProviderModel(partStep, partRuntime);
          const partDeadline = executionDeadlineContext?.begin(`team-leader:part:${part.id}`, partProviderInfo);
          return runWithExecutionDeadline(
            executionDeadlineContext,
            partDeadline,
            () => this.runSinglePart(
              step,
              leaderWorkflowMeta,
              part,
              partIndex,
              parentIteration,
              state,
              task,
              maxSteps,
              teamLeaderConfig.timeoutMs,
              updatePersonaSession,
              parallelLogger,
              partRuntime,
              partProviderInfo,
              instructionTransaction,
              partAbortSignal,
              publicationFence,
              partDeadline?.signal,
            ),
          ).catch((error) => {
          if (isTeamLeaderPartCancellation(error)) throw error;
          if (isProviderStreamParseError(error)) throw error;
          return buildTeamLeaderErrorPartResult(step, part, error);
          });
        },
        }),
      );
    } finally {
      executionAbortScope.dispose();
    }
    const { plannedParts, partResults } = executionResult;
    this.recordPartRoutingResults(step, partResults, routedProviderInfoByPart);
    this.emitPartRoutingDecisionEvents(step, partResults, routedProviderInfoByPart, parentIteration);

    const rateLimitedResult = partResults.find((result) => result.response.status === 'rate_limited');
    if (rateLimitedResult) {
      const rateLimitedResponse: AgentResponse = {
        ...rateLimitedResult.response,
        persona: step.name,
      };
      rollbackTeamLeaderAttempt(instructionTransaction, state, attemptState, updatePersonaSession);
      return {
        response: rateLimitedResponse,
        instruction,
        providerInfo: rateLimitedResult.providerInfo,
        consumedStepIterations: [],
      };
    }

    const failedResults = partResults.filter((result) => result.response.status === 'error');
    const allFailed = failedResults.length === partResults.length;
    const timeoutContinuationFailed = hasFailedTimeoutContinuationResult(partResults);
    const failClosedPartError = teamLeaderConfig.failOnPartError === true && failedResults.length > 0;
    if (allFailed || timeoutContinuationFailed || failClosedPartError) {
      const errors = failedResults.map((result) => `${result.part.id}: ${resolvePartErrorDetail(result)}`).join('; ');
      const errorMessage = allFailed
        ? `All team leader parts failed: ${errors}`
        : timeoutContinuationFailed
          ? `Team leader timeout continuation failed: ${errors}`
          : `Team leader part failed: ${errors}`;
      const primaryFailure = selectPrimaryTeamLeaderFailure(failedResults);
      const boundedError = truncateTeamLeaderFailureContent(
        sanitizeSensitiveText(resolvePartErrorDetail(primaryFailure)),
      );
      const boundedContent = truncateTeamLeaderFailureContent(
        sanitizeSensitiveText(errorMessage),
      );
      const errorResponse: AgentResponse = {
        persona: step.name,
        status: 'error',
        content: boundedContent,
        error: boundedError,
        timestamp: new Date(),
        ...(primaryFailure.response.failureCategory === undefined
          ? {}
          : { failureCategory: primaryFailure.response.failureCategory }),
      };
      state.stepOutputs.set(step.name, errorResponse);
      state.lastOutput = errorResponse;
      return {
        response: errorResponse,
        instruction,
      };
    }

    if (parallelLogger) {
      parallelLogger.printSummary(
        step.name,
        partResults.map((result) => ({ name: result.part.id, condition: undefined })),
      );
    }

    const aggregatedContent = buildTeamLeaderAggregatedContent(plannedParts, partResults);

    let aggregatedResponse: AgentResponse = {
      persona: step.name,
      status: 'done',
      content: aggregatedContent,
      timestamp: new Date(),
    };

    let terminalOperation: StepRunResult['terminalOperation'];
    aggregatedResponse = await this.deps.stepExecutor.applyPostExecutionPhases(
      step,
      state,
      stepIteration,
      aggregatedResponse,
      updatePersonaSession,
      leaderRuntime,
      (providerInfo, success, usage) => {
        this.recordUsage(step.name, providerInfo, success, usage);
      },
      (operation) => {
        terminalOperation = operation;
      },
    );

    state.stepOutputs.set(step.name, aggregatedResponse);
    state.lastOutput = aggregatedResponse;
    if (aggregatedResponse.status === 'rate_limited') {
      rollbackTeamLeaderAttempt(instructionTransaction, state, attemptState, updatePersonaSession);
      return {
        response: aggregatedResponse,
        instruction,
        providerInfo: leaderProviderInfo,
        ...(terminalOperation !== undefined ? { terminalOperation } : {}),
        consumedStepIterations: [],
      };
    }
    this.deps.stepExecutor.persistPreviousResponseSnapshot(
      state,
      step.name,
      stepIteration,
      aggregatedResponse.content,
    );
    this.deps.stepExecutor.emitStepReports(
      step,
      {
        iteration: parentIteration,
        resumeStepName: step.name,
        stepIteration,
        providerInfo: leaderProviderInfo,
      },
    );

    const result: StepRunResult = {
      response: aggregatedResponse,
      instruction,
      providerInfo: leaderProviderInfo,
      ...(terminalOperation !== undefined ? { terminalOperation } : {}),
    };
    return result;
  }

  private async resolveLeaderAutoRouting(
    leaderStep: WorkflowStep,
    runtime: RuntimeStepResolution | undefined,
  ): Promise<RuntimeStepResolution | undefined> {
    if (!this.deps.engineOptions.autoRouting || runtime?.fallback) {
      return runtime;
    }

    const currentProviderInfo = this.deps.optionsBuilder.resolveStepProviderModelBeforeAutoRouting(leaderStep, runtime);
    const autoRuntime = await resolveAutoRoutingRuntime({
      autoRouting: this.deps.engineOptions.autoRouting,
      scope: createRoutingScope({
        workflow: this.deps.getWorkflowName(),
        parentStep: leaderStep.name,
        workItem: 'leader',
      }),
      step: {
        name: leaderStep.name,
        tags: leaderStep.tags,
        personaKey: leaderStep.providerRoutingPersonaKey,
        instruction: leaderStep.instruction,
      },
      snapshot: buildRoutingWorkSnapshot({
        goal: this.deps.getTask(),
        userInputs: this.deps.getState().userInputs,
        retryNote: this.deps.engineOptions.retryNote,
        step: {
          name: leaderStep.name,
          tags: leaderStep.tags ?? [],
          personaKey: leaderStep.providerRoutingPersonaKey,
          instruction: leaderStep.instruction,
          stepType: 'agent',
          edit: leaderStep.edit,
          passPreviousResponse: leaderStep.passPreviousResponse === true,
        },
        lastOutput: this.deps.getState().lastOutput?.content,
        sensitiveValues: this.deps.engineOptions.routingSensitiveValues,
      }),
      currentProviderInfo,
      estimator: this.deps.engineOptions.autoRoutingEstimator,
      runtime: this.deps.engineOptions.routingRuntime,
      logger: log,
      abortSignal: this.resolveAbortSignal(),
      ...this.deps.optionsBuilder.buildDeadlineActivityCallbacks(
        `team-leader:auto-routing:${leaderStep.name}`,
      ),
    });
    if (!autoRuntime) {
      return runtime;
    }
    return {
      ...runtime,
      ...autoRuntime,
    };
  }

  private async runSinglePart(
    step: WorkflowStep,
    leaderWorkflowMeta: RunAgentOptions['workflowMeta'] | undefined,
    part: PartDefinition,
    partIndex: number,
    parentIteration: number,
    state: WorkflowState,
    task: string,
    maxSteps: WorkflowMaxSteps,
    defaultTimeoutMs: number,
    updatePersonaSession: (persona: string, sessionId: string | undefined) => void,
    parallelLogger: ParallelLogger | undefined,
    runtime: RuntimeStepResolution | undefined,
    providerInfo: StepProviderInfo,
    instructionTransaction?: InstructionBuildTransaction,
    executionAbortSignal?: AbortSignal,
    publicationFence?: TeamLeaderExecutionPublicationFence,
    deadlineSignal?: AbortSignal,
  ): Promise<PartResult> {
    publicationFence?.assertRunning('part.worker_start');
    const startedAt = Date.now();
    const result = await runTeamLeaderPart(
      this.deps.optionsBuilder,
      step,
      leaderWorkflowMeta,
      part,
      partIndex,
      defaultTimeoutMs,
      updatePersonaSession,
      parallelLogger,
      {
        enabled: this.deps.observabilityEnabled,
        runId: this.deps.observabilityRunId,
        workflowName: this.deps.getWorkflowName(),
        iteration: parentIteration,
        workflowStack: this.deps.getCurrentWorkflowStack?.(),
        sanitizeText: this.deps.sanitizeObservabilityText,
      },
      (partStep) => {
        const partIteration = incrementStepIteration(state, partStep.name);
        return this.deps.stepExecutor.buildInstruction(
          partStep,
          partIteration,
          state,
          task,
          maxSteps,
          runtime?.fallback,
          instructionTransaction,
        );
      },
      runtime,
      executionAbortSignal,
      {
        forceNewSession: false,
        deadlineSignal,
        providerInfo,
      },
    );
    publicationFence?.assertRunning('part.completed');
    if (result.providerInfo !== undefined) {
      this.recordUsage(
        `${step.name}.${part.id}`,
        result.providerInfo,
        result.response.status === 'done',
        result.response.providerUsage,
      );
    }
    if (result.response.failureCategory === AGENT_FAILURE_CATEGORIES.PROVIDER_STREAM_PARSE_ERROR) {
      throw createProviderStreamParseError(resolvePartErrorDetail(result));
    }
    return {
      ...result,
      durationMs: Math.max(0, result.response.timestamp.getTime() - startedAt),
    };
  }

  private recordUsage(
    step: string,
    providerInfo: StepProviderInfo,
    success: boolean,
    usage?: AgentResponse['providerUsage'],
  ): void {
    recordAgentUsageEvent(
      this.deps.engineOptions,
      step,
      'team_leader',
      providerInfo,
      success,
      usage,
    );
  }

  private emitPartRoutingDecisionEvents(
    step: WorkflowStep,
    partResults: PartResult[],
    routedProviderInfoByPart: Map<string, StepProviderInfo>,
    iteration: number,
  ): void {
    for (const result of partResults) {
      const providerInfo = routedProviderInfoByPart.get(result.part.id);
      if (providerInfo?.autoRoutingDecision === undefined) {
        continue;
      }
      const partStep = createPartStep(step, result.part);
      this.deps.emitEvent(
        'routing:decision',
        partStep,
        result.response,
        result.part.instruction,
        providerInfo,
        'agent',
        result.durationMs ?? 0,
        iteration,
        this.deps.getWorkflowName(),
      );
    }
  }

  private recordPartRoutingResults(
    step: WorkflowStep,
    partResults: PartResult[],
    routedProviderInfoByPart: Map<string, StepProviderInfo>,
  ): void {
    for (const result of partResults) {
      this.recordRoutingResult(
        createRoutingScope({
          workflow: this.deps.getWorkflowName(),
          parentStep: step.name,
          workItem: result.part.id,
        }),
        routedProviderInfoByPart.get(result.part.id),
        result.response,
      );
    }
  }

  private recordRoutingResult(
    scope: string,
    providerInfo: StepProviderInfo | undefined,
    response: AgentResponse,
  ): void {
    const routingRuntime = this.deps.engineOptions.routingRuntime;
    if (
      routingRuntime === undefined
      || providerInfo?.autoRoutingDecision === undefined
      || !routingRuntime.hasResolution(scope)
    ) {
      return;
    }
    routingRuntime.recordExecutionResult({
      scope,
      status: response.status === 'done' ? 'done' : 'failed',
    });
  }

  private emitLeaderRoutingDecisionEvent(
    leaderStep: WorkflowStep,
    response: AgentResponse,
    instruction: string,
    providerInfo: StepProviderInfo,
    durationMs: number,
    iteration: number,
  ): void {
    if (providerInfo.autoRoutingDecision === undefined) {
      return;
    }
    this.deps.emitEvent(
      'routing:decision',
      leaderStep,
      response,
      instruction,
      providerInfo,
      'agent',
      durationMs,
      iteration,
      this.deps.getWorkflowName(),
    );
  }

  private buildPartRuntime(
    runtime: RuntimeStepResolution | undefined,
    providerInfo: StepProviderInfo | undefined,
  ): RuntimeStepResolution | undefined {
    if (providerInfo === undefined) {
      return runtime;
    }
    return {
      ...runtime,
      providerInfo,
    };
  }

  private async resolvePartAutoRouting(
    step: WorkflowStep,
    parts: PartDefinition[],
    runtime: RuntimeStepResolution | undefined,
  ): Promise<Map<string, StepProviderInfo>> {
    const result = new Map<string, StepProviderInfo>();
    await this.addPartAutoRouting(result, step, parts, runtime);
    return result;
  }

  private async addPartAutoRouting(
    result: Map<string, StepProviderInfo>,
    step: WorkflowStep,
    parts: PartDefinition[],
    runtime: RuntimeStepResolution | undefined,
  ): Promise<void> {
    if (!this.deps.engineOptions.autoRouting || runtime?.fallback || parts.length === 0) {
      return;
    }

    const routed = await resolveAutoRoutingBatch({
      autoRouting: this.deps.engineOptions.autoRouting,
      concurrency: step.teamLeader?.maxConcurrency,
      items: parts.map((part) => {
        const partStep = createPartStep(step, part);
        const partResolutionRuntime = this.getPartProviderResolutionRuntime(runtime);
        return {
          id: part.id,
          scope: createRoutingScope({
            workflow: this.deps.getWorkflowName(),
            parentStep: step.name,
            workItem: part.id,
          }),
          step: {
            name: partStep.name,
            tags: partStep.tags,
            personaKey: partStep.providerRoutingPersonaKey,
            instruction: partStep.instruction,
          },
          snapshot: buildRoutingWorkSnapshot({
            goal: this.deps.getTask(),
            userInputs: this.deps.getState().userInputs,
            retryNote: this.deps.engineOptions.retryNote,
            step: {
              name: partStep.name,
              tags: partStep.tags ?? [],
              personaKey: partStep.providerRoutingPersonaKey,
              instruction: partStep.instruction,
              stepType: 'agent',
              edit: partStep.edit,
              passPreviousResponse: partStep.passPreviousResponse === true,
            },
            part: { title: part.title, instruction: part.instruction },
            lastOutput: this.deps.getState().lastOutput?.content,
            sensitiveValues: this.deps.engineOptions.routingSensitiveValues,
          }),
          currentProviderInfo: this.deps.optionsBuilder.resolveStepProviderModelBeforeAutoRouting(partStep, partResolutionRuntime),
        };
      }),
      estimator: this.deps.engineOptions.autoRoutingEstimator,
      runtime: this.deps.engineOptions.routingRuntime,
      logger: log,
      abortSignal: this.resolveAbortSignal(),
      ...this.deps.optionsBuilder.buildDeadlineActivityCallbacks(
        `team-parts:auto-routing:${step.name}`,
      ),
    });

    for (const [partId, providerInfo] of routed.entries()) {
      result.set(partId, providerInfo);
    }
  }

  private getPartProviderResolutionRuntime(
    runtime: RuntimeStepResolution | undefined,
  ): RuntimeStepResolution | undefined {
    if (runtime?.fallback || runtime?.providerInfo?.providerSource === 'promotion') {
      return runtime;
    }
    return undefined;
  }
}

interface TeamLeaderAttemptState {
  readonly lastOutput: WorkflowState['lastOutput'];
  readonly previousResponseSourcePath: WorkflowState['previousResponseSourcePath'];
  readonly pendingFallback: WorkflowState['pendingFallback'];
  readonly rateLimitFallbackState: WorkflowState['rateLimitFallbackState'];
  readonly stepOutputs: Map<string, AgentResponse>;
  readonly personaSessions: Map<string, string>;
  readonly stepIterations: Map<string, number>;
}

function captureTeamLeaderAttemptState(
  state: WorkflowState,
  stepName: string,
  activeStepIteration?: number,
): TeamLeaderAttemptState {
  const stepIterations = new Map(state.stepIterations);
  if (activeStepIteration !== undefined) {
    if (stepIterations.get(stepName) !== activeStepIteration) {
      throw new Error(
        `Active step iteration mismatch for "${stepName}": expected ${activeStepIteration}`,
      );
    }
    const previousStepIteration = activeStepIteration - 1;
    if (previousStepIteration > 0) {
      stepIterations.set(stepName, previousStepIteration);
    } else {
      stepIterations.delete(stepName);
    }
  }
  return {
    lastOutput: state.lastOutput,
    previousResponseSourcePath: state.previousResponseSourcePath,
    pendingFallback: state.pendingFallback,
    rateLimitFallbackState: state.rateLimitFallbackState,
    stepOutputs: new Map(state.stepOutputs),
    personaSessions: new Map(state.personaSessions),
    stepIterations,
  };
}

function rollbackTeamLeaderAttempt(
  instructionTransaction: InstructionBuildTransaction,
  state: WorkflowState,
  snapshot: TeamLeaderAttemptState,
  updatePersonaSession: (persona: string, sessionId: string | undefined) => void,
): void {
  const errors: Error[] = [];

  collectRollbackError(errors, 'instruction snapshot rollback', () => instructionTransaction.rollback());
  restorePersonaSessions(state, snapshot.personaSessions, updatePersonaSession, errors);
  collectRollbackError(errors, 'non-session attempt state rollback', () => {
    restoreNonSessionAttemptState(state, snapshot);
  });
  verifyPersonaSessions(state, snapshot.personaSessions, errors);

  if (errors.length > 0) {
    throw new AggregateError(errors, 'Team leader attempt rollback failed');
  }
}

function restoreNonSessionAttemptState(
  state: WorkflowState,
  snapshot: TeamLeaderAttemptState,
): void {
  state.lastOutput = snapshot.lastOutput;
  state.previousResponseSourcePath = snapshot.previousResponseSourcePath;
  state.pendingFallback = snapshot.pendingFallback;
  state.rateLimitFallbackState = snapshot.rateLimitFallbackState;
  state.stepOutputs.clear();
  for (const [name, response] of snapshot.stepOutputs) {
    state.stepOutputs.set(name, response);
  }
  state.stepIterations.clear();
  for (const [name, iteration] of snapshot.stepIterations) {
    state.stepIterations.set(name, iteration);
  }
}

function restorePersonaSessions(
  state: WorkflowState,
  originalSessions: ReadonlyMap<string, string>,
  updatePersonaSession: (persona: string, sessionId: string | undefined) => void,
  errors: Error[],
): void {
  const sessionKeys = new Set([...state.personaSessions.keys(), ...originalSessions.keys()]);
  for (const sessionKey of sessionKeys) {
    const currentSessionId = state.personaSessions.get(sessionKey);
    const originalSessionId = originalSessions.get(sessionKey);
    if (currentSessionId !== originalSessionId) {
      collectRollbackError(errors, `session "${sessionKey}" rollback`, () => {
        updatePersonaSession(sessionKey, originalSessionId);
      });
    }
  }
}

function verifyPersonaSessions(
  state: WorkflowState,
  originalSessions: ReadonlyMap<string, string>,
  errors: Error[],
): void {
  if (state.personaSessions.size !== originalSessions.size) {
    errors.push(new Error('Team leader session rollback did not restore the captured session keys'));
  }
  for (const [sessionKey, originalSessionId] of originalSessions) {
    if (state.personaSessions.get(sessionKey) !== originalSessionId) {
      errors.push(new Error(`Team leader session rollback did not restore session "${sessionKey}"`));
    }
  }
}

function collectRollbackError(errors: Error[], stage: string, operation: () => void): void {
  try {
    operation();
  } catch (error) {
    errors.push(new Error(`Team leader attempt rollback failed during ${stage}`, { cause: error }));
  }
}
