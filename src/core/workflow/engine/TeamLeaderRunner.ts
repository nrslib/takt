import type {
  WorkflowStep,
  WorkflowState,
  AgentResponse,
  PartDefinition,
  PartResult,
  WorkflowMaxSteps,
  WorkflowResumePointEntry,
  FindingContractConfig,
} from '../../models/types.js';
import { ParallelLogger } from './parallel-logger.js';
import { incrementStepIteration } from './state-manager.js';
import { createLogger, getErrorMessage } from '../../../shared/utils/index.js';
import { runTeamLeaderExecution } from './team-leader-execution.js';
import {
  buildFindingContractTeamLeaderAggregatedContent,
  buildTeamLeaderAggregatedContent,
  type TeamLeaderArtifactReference,
} from './team-leader-aggregation.js';
import {
  buildTeamLeaderPartFeedbackResult,
  createPartStep,
  createTeamLeaderPlanningStep,
  resolvePartErrorDetail,
  summarizeParts,
} from './team-leader-common.js';
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
  buildPartScopedSessionKey,
  buildTeamLeaderErrorPartResult,
  runTeamLeaderPart,
} from './team-leader-part-runner.js';
import { runWithPhaseSpan } from '../observability/workflowSpans.js';
import { buildPhaseExecutionId } from '../../../shared/utils/phaseExecutionId.js';
import { resolveInspectToolsForProvider } from './engine-provider-options.js';
import { resolveAutoRoutingBatch, resolveAutoRoutingRuntime } from '../auto-routing/resolver.js';
import { InstructionBuildTransaction } from './instruction-build-transaction.js';
import { recordAgentUsageEvent } from './agent-usage-event.js';
import type { FindingLedgerStore } from '../findings/store.js';
import type { RunPaths } from '../run/run-paths.js';
import {
  buildFindingContractPartIndexEntry,
  appendFindingContractPartAssignmentInstruction,
  buildLatestFindingContractDigests,
} from '../team-leader-finding-contract.js';
import {
  type FindingContractRecoveryAttemptEvent,
  type FindingContractRecoveryPromptContext,
} from './team-leader-finding-contract-recovery.js';
import type {
  FindingContractRejectedDecisionDigest,
} from '../team-leader-finding-contract-decision-validation.js';
import type {
  FindingContractRejectedPartCompletionDigest,
} from '../team-leader-finding-contract-part-completion-validation.js';
import type {
  FindingContractRejectedDecompositionDigest,
} from '../team-leader-finding-contract-decomposition-validation.js';
import { buildFindingContractDecisionEvidenceSnapshot } from '../team-leader-finding-contract-evidence.js';
import {
  type FindingContractOperationBoundary,
} from './team-leader-finding-contract-operation-journal.js';
import type {
  TeamLeaderExecutionPublicationFence,
} from './team-leader-execution-terminal.js';
import {
  validateOrRecoverFindingContractPartCompletion,
} from './team-leader-finding-contract-part-completion-recovery.js';
import { FindingContractTeamLeaderCoordinator } from './team-leader-finding-contract-coordinator.js';

const log = createLogger('team-leader-runner');

export interface TeamLeaderRunnerDeps {
  readonly optionsBuilder: OptionsBuilder;
  readonly stepExecutor: StepExecutor;
  readonly engineOptions: WorkflowEngineOptions;
  readonly getCwd: () => string;
  readonly getWorkflowName: () => string;
  readonly getInteractive: () => boolean;
  readonly getRunPaths: () => RunPaths;
  readonly findingContract?: FindingContractConfig;
  readonly findingLedgerStore?: FindingLedgerStore;
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

  async runTeamLeaderStep(
    step: WorkflowStep,
    state: WorkflowState,
    task: string,
    maxSteps: WorkflowMaxSteps,
    updatePersonaSession: (persona: string, sessionId: string | undefined) => void,
    runtime?: RuntimeStepResolution,
    activeStepIteration?: number,
  ): Promise<StepRunResult> {
    if (!step.teamLeader) {
      throw new Error(`Step "${step.name}" has no teamLeader configuration`);
    }
    const teamLeaderConfig = step.teamLeader;
    const findingContractMode = teamLeaderConfig.mode === 'finding_contract_fix';
    const parentIteration = state.iteration;
    const attemptState = captureTeamLeaderAttemptState(state, step.name, activeStepIteration);
    const instructionTransaction = new InstructionBuildTransaction();

    const stepIteration = activeStepIteration ?? incrementStepIteration(state, step.name);
    const findingContractCoordinator = findingContractMode
      ? new FindingContractTeamLeaderCoordinator(this.deps, step, stepIteration)
      : undefined;
    const findingContractExecution = findingContractCoordinator?.execution;
    const replayedStepResult = findingContractCoordinator?.readPreparedStepResult();
    if (replayedStepResult !== undefined) {
      state.stepOutputs.set(step.name, replayedStepResult.response);
      state.lastOutput = replayedStepResult.response;
      return replayedStepResult;
    }
    const leaderStep = createTeamLeaderPlanningStep(step);
    const instruction = this.deps.stepExecutor.buildInstruction(
      leaderStep,
      stepIteration,
      state,
      task,
      maxSteps,
      undefined,
      findingContractMode ? { mode: 'omit' } : undefined,
      instructionTransaction,
    );
    const leaderRuntime = await this.resolveLeaderAutoRouting(leaderStep, runtime);
    const leaderProviderInfo = this.deps.optionsBuilder.resolveStepProviderModel(leaderStep, leaderRuntime);
    const { provider: leaderProvider, model: leaderModel } = leaderProviderInfo;
    const leaderBaseOptions = this.deps.optionsBuilder.buildBaseOptions(leaderStep, undefined, leaderRuntime);
    const leaderWorkflowMeta = this.deps.optionsBuilder.buildPhase1WorkflowMeta(
      leaderBaseOptions.workflowMeta,
    );
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
    const emitReplayedDecompositionPhaseStart = (): void => {
      if (didEmitPhaseStart) return;
      const promptParts: PhasePromptParts = {
        systemPrompt: '',
        userInstruction: instruction,
      };
      resolvedPromptParts = promptParts;
      this.deps.onPhaseStart?.(
        leaderStep,
        1,
        'execute',
        instruction,
        promptParts,
        phaseExecutionId,
        parentIteration,
      );
      didEmitPhaseStart = true;
    };
    const structuredCaller = this.deps.engineOptions.structuredCaller;
    if (!structuredCaller) {
      throw new Error('structuredCaller is required for team leader execution');
    }
    const leaderStartedAt = Date.now();
    const buildDecompositionOptions = (
      recoveryRequest?: {
        recoveryContext: FindingContractRecoveryPromptContext<FindingContractRejectedDecompositionDigest>;
        abortSignal: AbortSignal;
      },
    ) => ({
      cwd: this.deps.getCwd(),
      persona: leaderStep.persona,
      personaPath: leaderStep.personaPath,
      model: leaderModel,
      provider: leaderProvider,
      resolvedModel: leaderModel,
      resolvedProvider: leaderProvider,
      language: this.deps.engineOptions.language,
      inspectTools,
      mcpServers: leaderMcpServers,
      workflowMeta: leaderWorkflowMeta,
      childProcessEnv: this.deps.engineOptions.childProcessEnv,
      abortSignal: recoveryRequest?.abortSignal ?? leaderBaseOptions.abortSignal,
      onStream: leaderBaseOptions.onStream,
      onAgentResponse: (response: AgentResponse) => {
        this.recordUsage(
          leaderStep.name,
          leaderProviderInfo,
          response.status === 'done'
            && (recoveryRequest?.abortSignal ?? leaderBaseOptions.abortSignal)?.aborted !== true,
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
      ...(findingContractExecution === undefined
        ? {}
        : {
            findingContract: {
              targetFindingIds: findingContractExecution.targetFindingIds,
              actionableFindings: findingContractExecution.actionableFindings,
              ...(recoveryRequest === undefined
                ? {}
                : { recovery: recoveryRequest.recoveryContext }),
            },
          }),
    });
    const requestDecomposition = (
      recoveryRequest?: {
        recoveryContext: FindingContractRecoveryPromptContext<FindingContractRejectedDecompositionDigest>;
        abortSignal: AbortSignal;
      },
    ) => {
      return structuredCaller.decomposeTask(
        instruction,
        teamLeaderConfig.initialMaxParts,
        buildDecompositionOptions(recoveryRequest),
      );
    };
    const requestRawDecomposition = (
      recoveryRequest: {
        recoveryContext: FindingContractRecoveryPromptContext<FindingContractRejectedDecompositionDigest>;
        abortSignal: AbortSignal;
      },
    ) => {
      return structuredCaller.requestDecompositionRawResponse(
        instruction,
        teamLeaderConfig.initialMaxParts,
        buildDecompositionOptions(recoveryRequest),
      );
    };
    const decomposition = await runWithPhaseSpan(
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
      async () => {
        if (!findingContractMode) return requestDecomposition();
        if (findingContractCoordinator === undefined) {
          throw new Error('Finding Contract coordinator is missing');
        }
        return findingContractCoordinator.recoverDecomposition({
          maxInitialParts: teamLeaderConfig.initialMaxParts,
          abortSignal: leaderBaseOptions.abortSignal,
          requestRaw: ({ recoveryContext, abortSignal }) => (
            requestRawDecomposition({
              recoveryContext,
              abortSignal,
            })
          ),
          onReplay: emitReplayedDecompositionPhaseStart,
        });
      },
      (result) => ({
        status: 'done',
        content: JSON.stringify({ parts: result.parts }, null, 2),
      }),
    ).catch((error) => {
      findingContractCoordinator?.terminate(error);
      throw error;
    });
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
    const routedProviderInfoByPart = await this.resolvePartAutoRouting(step, parts, runtime);

    let currentBatchNumber = 1;
    const batchNumberByPartId = new Map(parts.map((part) => [part.id, currentBatchNumber]));
    const partIndexById = new Map<string, number>();
    let previousFindingContractDecision: { decision: 'continue'; reasoning: string } | undefined;
    const artifactReferences: TeamLeaderArtifactReference[] = [];
    const executionAbortScope = createTeamLeaderExecutionAbortScope(leaderBaseOptions.abortSignal);
    let executionResult: Awaited<ReturnType<typeof runTeamLeaderExecution>>;
    try {
      executionResult = await runTeamLeaderExecution({
        initialParts: parts,
        maxConcurrency: teamLeaderConfig.maxConcurrency,
        findingContractMode,
        abortSignal: executionAbortScope.signal,
        onTerminalError: (error) => {
          try {
            findingContractCoordinator?.beginTermination(error);
          } finally {
            executionAbortScope.abort(error);
          }
        },
      onPartQueued: (part, partIndex) => {
        partIndexById.set(part.id, partIndex);
        parallelLogger?.addSubStep(part.id);
      },
      onPartCompleted: (result) => {
        state.stepOutputs.set(result.response.persona, result.response);
        if (findingContractMode) {
          const partIndex = partIndexById.get(result.part.id);
          const partBatchNumber = batchNumberByPartId.get(result.part.id);
          if (
            findingContractCoordinator === undefined
            || partIndex === undefined
            || partBatchNumber === undefined
          ) {
            throw new Error(`Finding Contract artifact metadata is missing for part "${result.part.id}"`);
          }
          artifactReferences.push(findingContractCoordinator.writeAcceptedPartArtifact(
            partBatchNumber,
            partIndex,
            result,
          ));
        }
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
          parts: summarizeParts(addedParts),
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
        latestBatchResults,
        completedPartResults,
        plannedParts: currentPlannedParts,
        scheduledIds,
      }) => {
        emitTeamLeaderProgressHint(this.deps.engineOptions, 'feedback');
        const feedbackPartResults = findingContractMode
          ? [...latestBatchResults].sort((left, right) => {
              const leftIndex = partIndexById.get(left.part.id);
              const rightIndex = partIndexById.get(right.part.id);
              if (leftIndex === undefined || rightIndex === undefined) {
                throw new Error('Finding Contract feedback part index is missing');
              }
              return leftIndex - rightIndex;
            })
          : currentResults;
        const feedbackResults = feedbackPartResults.map((result) => {
          const findingContractClaim = findingContractMode
            ? buildFindingContractPartIndexEntry(result)
            : undefined;
          return buildTeamLeaderPartFeedbackResult(result, findingContractClaim);
        });
        const findingContractContext = findingContractExecution === undefined
          ? undefined
          : {
              targetFindingIds: [...findingContractExecution.targetFindingIds],
              actionableFindings: findingContractExecution.actionableFindings,
              completedPartIndex: buildLatestFindingContractDigests(
                completedPartResults
                  .map((result) => ({
                    result,
                    index: partIndexById.get(result.part.id),
                  }))
                  .map(({ result, index }) => {
                    if (index === undefined) {
                      throw new Error(`Finding Contract part index is missing: ${result.part.id}`);
                    }
                    return {
                      sequence: index,
                      entry: buildFindingContractPartIndexEntry(result),
                    };
                  }),
              ),
              plannedParts: structuredClone(currentPlannedParts),
              evidence: buildFindingContractDecisionEvidenceSnapshot(
                currentResults,
                findingContractExecution.targetFindingIds,
              ),
              ...(previousFindingContractDecision !== undefined
                ? { previousDecision: previousFindingContractDecision }
                : {}),
            };
        try {
          const buildFeedbackOptions = (
            decisionRequest?: {
              recoveryContext: FindingContractRecoveryPromptContext<FindingContractRejectedDecisionDigest>;
              abortSignal: AbortSignal;
            },
          ) => ({
            cwd: this.deps.getCwd(),
            persona: leaderStep.persona,
            personaPath: leaderStep.personaPath,
            language: this.deps.engineOptions.language,
            model: leaderModel,
            provider: leaderProvider,
            resolvedModel: leaderModel,
            resolvedProvider: leaderProvider,
            mcpServers: leaderMcpServers,
            workflowMeta: leaderWorkflowMeta,
            childProcessEnv: this.deps.engineOptions.childProcessEnv,
            abortSignal: decisionRequest?.abortSignal ?? leaderBaseOptions.abortSignal,
            onStream: leaderBaseOptions.onStream,
            onAgentResponse: (response: AgentResponse) => {
              this.recordUsage(
                leaderStep.name,
                leaderProviderInfo,
                response.status === 'done'
                  && (decisionRequest?.abortSignal ?? leaderBaseOptions.abortSignal)?.aborted !== true,
                response.providerUsage,
              );
            },
            onAgentError: () => {
              this.recordUsage(leaderStep.name, leaderProviderInfo, false);
            },
            ...(findingContractContext === undefined
              ? {}
              : {
                  findingContract: {
                    ...findingContractContext,
                    ...(decisionRequest === undefined
                      ? {}
                      : { recovery: decisionRequest.recoveryContext }),
                  },
                }),
          });
          const feedbackInstruction = findingContractMode
            ? `${step.instruction}\n\n## Original Task\n${task}`
            : instruction;
          const requestFeedback = async (
            decisionRequest?: {
              recoveryContext: FindingContractRecoveryPromptContext<FindingContractRejectedDecisionDigest>;
              abortSignal: AbortSignal;
            },
          ) => structuredCaller.requestMoreParts(
            feedbackInstruction,
            feedbackResults,
            scheduledIds,
            buildFeedbackOptions(decisionRequest),
          );
          const requestRawFeedback = async (
            decisionRequest: {
              recoveryContext: FindingContractRecoveryPromptContext<FindingContractRejectedDecisionDigest>;
              abortSignal: AbortSignal;
            },
          ) => structuredCaller.requestMorePartsRawResponse(
            feedbackInstruction,
            feedbackResults,
            scheduledIds,
            buildFeedbackOptions(decisionRequest),
          );
          let moreParts: MorePartsResponse;
          if (!findingContractMode) {
            moreParts = await requestFeedback();
          } else {
            if (
              findingContractCoordinator === undefined
              || findingContractContext === undefined
            ) {
              throw new Error('Finding Contract feedback coordinator is missing');
            }
            moreParts = await findingContractCoordinator.recoverDecision({
              batchNumber: currentBatchNumber,
              abortSignal: leaderBaseOptions.abortSignal,
              validationContext: {
                targetFindingIds: findingContractContext.targetFindingIds,
                plannedParts: findingContractContext.plannedParts,
                evidence: findingContractContext.evidence,
              },
              requestRaw: ({ recoveryContext, abortSignal }) => requestRawFeedback({
                recoveryContext,
                abortSignal,
              }),
              onRejected: (event) => {
                log.info('Finding Contract Team Leader decision failed validation; regenerating', {
                  step: step.name,
                  attempt: event.attempt,
                  mode: event.mode,
                  strictReason: event.strictReason,
                  issueCodes: event.rejectedOutput?.issues.map((issue) => issue.code),
                  issueFingerprint: event.rejectedOutput?.issueFingerprint,
                  decisionDigest: event.rejectedOutput?.outputDigest.hash,
                });
              },
            });
          }
          if (moreParts.findingContractDecision?.decision === 'continue') {
            previousFindingContractDecision = {
              decision: 'continue',
              reasoning: moreParts.findingContractDecision.reasoning,
            };
            currentBatchNumber += 1;
            for (const part of moreParts.parts) {
              batchNumberByPartId.set(part.id, currentBatchNumber);
            }
          }
          await this.addPartAutoRouting(routedProviderInfoByPart, step, moreParts.parts, runtime);
          return moreParts;
        } catch (error) {
          if (leaderBaseOptions.abortSignal?.aborted) {
            throw error;
          }
          if (findingContractMode) {
            throw error;
          }
          const timeoutFallback = createTimeoutContinuationFeedback({
            partResults: currentResults,
            scheduledIds,
            coveredTimedOutPartIds,
            language: this.deps.engineOptions.language,
          });
          if (timeoutFallback) {
            if (timeoutFallback.parts.length > 0) {
              for (const partId of collectUncoveredPartTimeoutIds(currentResults, coveredTimedOutPartIds)) {
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
        runPart: async (part, partIndex, publicationFence) => this.runSinglePart(
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
        this.buildPartRuntime(runtime, routedProviderInfoByPart.get(part.id)),
        instructionTransaction,
        findingContractExecution === undefined
          ? undefined
          : findingContractCoordinator?.partSummary(part),
        findingContractCoordinator?.boundary(
          `part:${part.id}:completion`,
          'finding_contract_part_completion',
        ),
        findingContractExecution === undefined
          ? undefined
          : (event) => {
              if (findingContractCoordinator === undefined) {
                throw new Error('Finding Contract recovery artifact attempt is missing');
              }
              findingContractCoordinator.recordAttempt(
                `part:${part.id}:completion`,
                event,
              );
            },
        executionAbortScope.signal,
        publicationFence,
        ).catch((error) => {
          if (findingContractMode) throw error;
          return buildTeamLeaderErrorPartResult(step, part, error);
        }),
      });
    } catch (error) {
      findingContractCoordinator?.terminate(error);
      throw error;
    } finally {
      executionAbortScope.dispose();
    }
    const { plannedParts, partResults, findingContractDecision } = executionResult;
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
    const findingContractReplan = findingContractDecision?.decision === 'replan';
    if (!findingContractReplan && (allFailed || timeoutContinuationFailed || failClosedPartError)) {
      const errors = failedResults.map((result) => `${result.part.id}: ${resolvePartErrorDetail(result)}`).join('; ');
      const errorMessage = allFailed
        ? `All team leader parts failed: ${errors}`
        : timeoutContinuationFailed
          ? `Team leader timeout continuation failed: ${errors}`
          : `Team leader part failed: ${errors}`;
      const errorResponse: AgentResponse = {
        persona: step.name,
        status: 'error',
        content: errorMessage,
        error: errorMessage,
        timestamp: new Date(),
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

    if (findingContractMode && findingContractDecision === undefined) {
      throw new Error('Finding Contract Team Leader execution completed without a final decision');
    }
    const aggregatedContent = findingContractDecision !== undefined
      ? buildFindingContractTeamLeaderAggregatedContent(
          findingContractDecision,
          partResults.map(buildFindingContractPartIndexEntry),
          artifactReferences,
        )
      : buildTeamLeaderAggregatedContent(plannedParts, partResults);

    let aggregatedResponse: AgentResponse = {
      persona: step.name,
      status: 'done',
      content: aggregatedContent,
      timestamp: new Date(),
      ...(findingContractDecision !== undefined
        ? {
            structuredOutput: {
              decision: findingContractDecision.decision,
              reasoning: findingContractDecision.reasoning,
              ...(findingContractDecision.decision === 'complete'
                ? { fixCoverage: findingContractDecision.fixCoverage }
                : { blockers: findingContractDecision.blockers }),
            },
          }
        : {}),
    };

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
    );

    state.stepOutputs.set(step.name, aggregatedResponse);
    state.lastOutput = aggregatedResponse;
    if (aggregatedResponse.status === 'rate_limited') {
      rollbackTeamLeaderAttempt(instructionTransaction, state, attemptState, updatePersonaSession);
      return {
        response: aggregatedResponse,
        instruction,
        providerInfo: leaderProviderInfo,
        consumedStepIterations: [],
      };
    }
    this.deps.stepExecutor.persistPreviousResponseSnapshot(
      state,
      step.name,
      stepIteration,
      aggregatedResponse.content,
    );
    this.deps.stepExecutor.emitStepReports(step);

    const result = { response: aggregatedResponse, instruction, providerInfo: leaderProviderInfo };
    return findingContractCoordinator?.prepareStepResult(result) ?? result;
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
      step: {
        name: leaderStep.name,
        tags: leaderStep.tags,
        personaKey: leaderStep.providerRoutingPersonaKey,
        instruction: leaderStep.instruction,
      },
      currentProviderInfo,
      routeWithAi: this.deps.engineOptions.autoRoutingAiRouter?.routeStep,
      logger: log,
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
    runtime?: RuntimeStepResolution,
    instructionTransaction?: InstructionBuildTransaction,
    findingContractSummary?: string,
    operationBoundary?: FindingContractOperationBoundary,
    onFindingContractRecoveryAttempt?: (
      event: FindingContractRecoveryAttemptEvent<FindingContractRejectedPartCompletionDigest>,
    ) => void,
    executionAbortSignal?: AbortSignal,
    publicationFence?: TeamLeaderExecutionPublicationFence,
  ): Promise<PartResult> {
    const startedAt = Date.now();
    let pendingSessionPublication: {
      readonly key: string;
      readonly sessionId: string;
    } | undefined;
    publicationFence?.assertRunning('part.replay');
    const completed = operationBoundary?.readCompleted<PartResult>();
    if (completed !== undefined) {
      return hydratePartResult(completed);
    }
    const applied = operationBoundary?.readApplied<PartResult>();
    let replayedWorker = false;
    let result: PartResult;
    if (applied !== undefined) {
      publicationFence?.assertRunning('part.applied_replay');
      result = hydratePartResult(applied);
      replayedWorker = true;
      if (result.response.sessionId !== undefined) {
        pendingSessionPublication = {
          key: buildPartScopedSessionKey(
            createPartStep(step, part),
            result.providerInfo?.provider,
          ),
          sessionId: result.response.sessionId,
        };
      }
    } else {
      publicationFence?.assertRunning('part.worker_start');
      operationBoundary?.assertWorkerCanStart();
      operationBoundary?.markWorkerStarted();
      publicationFence?.assertRunning('part.provider_call');
      result = await runTeamLeaderPart(
        this.deps.optionsBuilder,
        step,
        leaderWorkflowMeta,
        part,
        partIndex,
        defaultTimeoutMs,
        (key, sessionId) => {
          if (sessionId !== undefined) {
            pendingSessionPublication = { key, sessionId };
          }
        },
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
          const builtInstruction = this.deps.stepExecutor.buildInstruction(
            partStep,
            partIteration,
            state,
            task,
            maxSteps,
            runtime?.fallback,
            findingContractSummary === undefined ? undefined : { mode: 'omit' },
            instructionTransaction,
          );
          if (findingContractSummary === undefined) return builtInstruction;
          const assignedInstruction = appendFindingContractPartAssignmentInstruction(
            builtInstruction,
            part,
            this.deps.engineOptions.language,
            findingContractSummary,
          );
          return this.deps.stepExecutor.buildPhase1Instruction(assignedInstruction, partStep, runtime);
        },
        runtime,
        executionAbortSignal,
      );
      result = {
        ...result,
        durationMs: Math.max(0, result.response.timestamp.getTime() - startedAt),
      };
      if (
        result.response.status === 'rate_limited'
        && publicationFence?.state !== 'terminating'
        && publicationFence?.state !== 'terminated'
      ) {
        operationBoundary?.markProviderFallbackPending(result);
      } else {
        operationBoundary?.markApplied(result);
      }
    }
    if (result.providerInfo && !replayedWorker) {
      this.recordUsage(
        `${step.name}.${part.id}`,
        result.providerInfo,
        result.response.status === 'done',
        result.response.providerUsage,
      );
    }
    if (
      findingContractSummary !== undefined
      && result.response.status !== 'done'
      && result.response.status !== 'rate_limited'
    ) {
      throw new Error(result.response.error ?? result.response.content);
    }
    publicationFence?.assertRunning('part.session');
    if (pendingSessionPublication !== undefined) {
      updatePersonaSession(
        pendingSessionPublication.key,
        pendingSessionPublication.sessionId,
      );
    }
    const recovered = findingContractSummary === undefined || result.response.status !== 'done'
      ? { response: result.response }
      : await validateOrRecoverFindingContractPartCompletion(
          {
            optionsBuilder: this.deps.optionsBuilder,
            stepExecutor: this.deps.stepExecutor,
            language: this.deps.engineOptions.language,
            recordUsage: (partStep, providerInfo, success, usage) => {
              this.recordUsage(partStep, providerInfo, success, usage);
            },
          },
          {
            step,
            part,
            response: result.response,
            runtime,
            updatePersonaSession,
            onAttempt: onFindingContractRecoveryAttempt,
            operationBoundary,
            abortSignal: executionAbortSignal,
            publicationFence,
          },
        );
    const finalResult = {
      ...result,
      response: recovered.response,
      ...('claim' in recovered ? { findingContractClaim: recovered.claim } : {}),
      durationMs: result.durationMs
        ?? Math.max(0, result.response.timestamp.getTime() - startedAt),
    };
    if (finalResult.response.status === 'rate_limited') {
      return finalResult;
    }
    publicationFence?.assertRunning('part.journal_completed');
    operationBoundary?.complete(finalResult);
    return finalResult;
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
      items: parts.map((part) => {
        const partStep = createPartStep(step, part);
        const partResolutionRuntime = this.getPartProviderResolutionRuntime(runtime);
        return {
          id: part.id,
          step: {
            name: partStep.name,
            tags: partStep.tags,
            personaKey: partStep.providerRoutingPersonaKey,
          },
          currentProviderInfo: this.deps.optionsBuilder.resolveStepProviderModelBeforeAutoRouting(partStep, partResolutionRuntime),
        };
      }),
      routeBatchWithAi: this.deps.engineOptions.autoRoutingAiRouter?.routeBatch,
      logger: log,
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

function hydratePartResult(result: PartResult): PartResult {
  return {
    ...result,
    response: hydrateAgentResponse(result.response),
  };
}

function hydrateAgentResponse(response: AgentResponse): AgentResponse {
  const timestamp: unknown = response.timestamp;
  return {
    ...response,
    timestamp: timestamp instanceof Date ? timestamp : new Date(String(timestamp)),
  };
}

function createTeamLeaderExecutionAbortScope(parentSignal: AbortSignal | undefined): {
  readonly signal: AbortSignal;
  readonly abort: (reason: unknown) => void;
  readonly dispose: () => void;
} {
  const controller = new AbortController();
  const onParentAbort = (): void => controller.abort(parentSignal?.reason);
  parentSignal?.addEventListener('abort', onParentAbort, { once: true });
  if (parentSignal?.aborted === true) {
    controller.abort(parentSignal.reason);
  }
  return {
    signal: controller.signal,
    abort: (reason) => controller.abort(reason),
    dispose: () => parentSignal?.removeEventListener('abort', onParentAbort),
  };
}
