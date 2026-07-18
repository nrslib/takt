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
import type { OptionsBuilder } from './OptionsBuilder.js';
import type { StepExecutor } from './StepExecutor.js';
import type { WorkflowEngineOptions, PhaseName, PhasePromptParts } from '../types.js';
import type { RuntimeStepResolution, StepProviderInfo, StepRunResult } from '../types.js';
import { buildTeamLeaderErrorPartResult, runTeamLeaderPart } from './team-leader-part-runner.js';
import { runWithPhaseSpan } from '../observability/workflowSpans.js';
import { buildPhaseExecutionId } from '../../../shared/utils/phaseExecutionId.js';
import { isPlanningBudgetError } from './team-leader-budget-errors.js';
import { resolveInspectToolsForProvider } from './engine-provider-options.js';
import { resolveAutoRoutingBatch, resolveAutoRoutingRuntime } from '../auto-routing/resolver.js';
import { recordDelegatedAgentUsage } from './delegated-agent-usage.js';

const log = createLogger('team-leader-runner');

export interface TeamLeaderRunnerDeps {
  readonly optionsBuilder: OptionsBuilder;
  readonly stepExecutor: StepExecutor;
  readonly engineOptions: WorkflowEngineOptions;
  readonly getCwd: () => string;
  readonly getWorkflowName: () => string;
  readonly getInteractive: () => boolean;
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
  ): Promise<StepRunResult> {
    if (!step.teamLeader) {
      throw new Error(`Step "${step.name}" has no teamLeader configuration`);
    }
    const teamLeaderConfig = step.teamLeader;
    const parentIteration = state.iteration;

    const stepIteration = incrementStepIteration(state, step.name);
    const leaderStep = createTeamLeaderPlanningStep(step);
    const instruction = this.deps.stepExecutor.buildInstruction(
      leaderStep,
      stepIteration,
      state,
      task,
      maxSteps,
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
    const structuredCaller = this.deps.engineOptions.structuredCaller;
    if (!structuredCaller) {
      throw new Error('structuredCaller is required for team leader execution');
    }
    const leaderStartedAt = Date.now();
    let parts: PartDefinition[];
    let leaderProviderUsage: AgentResponse['providerUsage'];
    let didRecordLeaderUsage = false;
    try {
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
        () => structuredCaller.decomposeTask(instruction, teamLeaderConfig.maxTotalParts, {
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
          abortSignal: leaderBaseOptions.abortSignal,
          onStream: leaderBaseOptions.onStream,
          onAgentResponse: (response) => {
            didRecordLeaderUsage = true;
            this.recordUsage(
              leaderStep.name,
              leaderProviderInfo,
              response.status === 'done',
              response.providerUsage,
            );
          },
          onAgentError: () => {
            didRecordLeaderUsage = true;
            this.recordUsage(leaderStep.name, leaderProviderInfo, false);
          },
          onPromptResolved: (promptParts) => {
            if (didEmitPhaseStart) return;
            resolvedPromptParts = promptParts;
            this.deps.onPhaseStart?.(leaderStep, 1, 'execute', promptParts.userInstruction, promptParts, phaseExecutionId, parentIteration);
            didEmitPhaseStart = true;
          },
        }), (result) => ({
          status: 'done',
          content: JSON.stringify({ parts: result.parts }, null, 2),
        }),
      );
      parts = decomposition.parts;
      leaderProviderUsage = decomposition.providerUsage;
      if (!didRecordLeaderUsage) {
        didRecordLeaderUsage = true;
        this.recordUsage(leaderStep.name, leaderProviderInfo, true, leaderProviderUsage);
      }
    } catch (error) {
      if (!didRecordLeaderUsage) {
        this.recordUsage(leaderStep.name, leaderProviderInfo, false);
      }
      throw error;
    }
    if (!didEmitPhaseStart) {
      throw new Error(`Missing prompt parts for phase start: ${leaderStep.name}:1`);
    }
    const leaderResponse: AgentResponse = {
      persona: leaderStep.persona ?? leaderStep.name,
      status: 'done',
      content: JSON.stringify({ parts }, null, 2),
      timestamp: new Date(),
      ...(leaderProviderUsage !== undefined ? { providerUsage: leaderProviderUsage } : {}),
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

    const { plannedParts, partResults } = await runTeamLeaderExecution({
      initialParts: parts,
      maxConcurrency: teamLeaderConfig.maxConcurrency,
      refillThreshold: teamLeaderConfig.refillThreshold,
      maxTotalParts: teamLeaderConfig.maxTotalParts,
      abortSignal: leaderBaseOptions.abortSignal,
      onPartQueued: (part) => {
        parallelLogger?.addSubStep(part.id);
      },
      onPartCompleted: (result) => {
        state.stepOutputs.set(result.response.persona, result.response);
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
        scheduledIds,
        remainingPartBudget,
        unfinishedScheduledPartCount,
      }) => {
        emitTeamLeaderProgressHint(this.deps.engineOptions, 'feedback');
        let didRecordFeedbackUsage = false;
        try {
          const moreParts = await structuredCaller.requestMoreParts(
            instruction,
            currentResults.map((result) => ({
              id: result.part.id,
              title: result.part.title,
              status: result.response.status,
              content: result.response.status === 'error'
                ? `[ERROR] ${resolvePartErrorDetail(result)}`
                : result.response.content,
            })),
            scheduledIds,
            remainingPartBudget,
            {
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
              abortSignal: leaderBaseOptions.abortSignal,
              onStream: leaderBaseOptions.onStream,
              onAgentResponse: (response) => {
                didRecordFeedbackUsage = true;
                this.recordUsage(
                  leaderStep.name,
                  leaderProviderInfo,
                  response.status === 'done',
                  response.providerUsage,
                );
              },
              onAgentError: () => {
                didRecordFeedbackUsage = true;
                this.recordUsage(leaderStep.name, leaderProviderInfo, false);
              },
            },
          );
          if (!didRecordFeedbackUsage) {
            didRecordFeedbackUsage = true;
            this.recordUsage(leaderStep.name, leaderProviderInfo, true, moreParts.providerUsage);
          }
          await this.addPartAutoRouting(routedProviderInfoByPart, step, moreParts.parts, runtime);
          return moreParts;
        } catch (error) {
          if (!didRecordFeedbackUsage) {
            this.recordUsage(leaderStep.name, leaderProviderInfo, false);
          }
          if (leaderBaseOptions.abortSignal?.aborted) {
            throw error;
          }
          if (isPlanningBudgetError(error)) {
            throw error;
          }

          const timeoutFallback = createTimeoutContinuationFeedback({
            partResults: currentResults,
            scheduledIds,
            remainingPartBudget,
            coveredTimedOutPartIds,
            unfinishedScheduledPartCount,
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
      runPart: async (part, partIndex) => this.runSinglePart(
        step,
        leaderWorkflowMeta,
        part,
        partIndex,
        parentIteration,
        teamLeaderConfig.timeoutMs,
        updatePersonaSession,
        parallelLogger,
        this.buildPartRuntime(runtime, routedProviderInfoByPart.get(part.id)),
      ).catch((error) => buildTeamLeaderErrorPartResult(step, part, error)),
    });
    this.emitPartRoutingDecisionEvents(step, partResults, routedProviderInfoByPart, parentIteration);

    const rateLimitedResult = partResults.find((result) => result.response.status === 'rate_limited');
    if (rateLimitedResult) {
      const rateLimitedResponse: AgentResponse = {
        ...rateLimitedResult.response,
        persona: step.name,
      };
      state.stepOutputs.set(step.name, rateLimitedResponse);
      state.lastOutput = rateLimitedResponse;
      return {
        response: rateLimitedResponse,
        instruction,
        providerInfo: rateLimitedResult.providerInfo,
        consumedStepIterations: [step.name],
      };
    }

    const allFailed = partResults.every((result) => result.response.status === 'error');
    const timeoutContinuationFailed = hasFailedTimeoutContinuationResult(partResults);
    if (allFailed || timeoutContinuationFailed) {
      const failedResults = partResults.filter((result) => result.response.status === 'error');
      const errors = failedResults.map((result) => `${result.part.id}: ${resolvePartErrorDetail(result)}`).join('; ');
      const errorMessage = allFailed
        ? `All team leader parts failed: ${errors}`
        : `Team leader timeout continuation failed: ${errors}`;
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

    const aggregatedContent = buildTeamLeaderAggregatedContent(plannedParts, partResults);

    let aggregatedResponse: AgentResponse = {
      persona: step.name,
      status: 'done',
      content: aggregatedContent,
      timestamp: new Date(),
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
      return { response: aggregatedResponse, instruction, providerInfo: leaderProviderInfo };
    }
    this.deps.stepExecutor.persistPreviousResponseSnapshot(
      state,
      step.name,
      stepIteration,
      aggregatedResponse.content,
    );
    this.deps.stepExecutor.emitStepReports(step);

    return { response: aggregatedResponse, instruction, providerInfo: leaderProviderInfo };
  }

  private async resolveLeaderAutoRouting(
    leaderStep: WorkflowStep,
    runtime: RuntimeStepResolution | undefined,
  ): Promise<RuntimeStepResolution | undefined> {
    if (!this.deps.engineOptions.autoRouting || runtime?.fallback) {
      return runtime;
    }

    const currentProviderInfo = this.deps.optionsBuilder.resolveStepProviderModel(leaderStep, runtime);
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
      abortSignal: this.deps.engineOptions.abortSignal,
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
    defaultTimeoutMs: number,
    updatePersonaSession: (persona: string, sessionId: string | undefined) => void,
    parallelLogger: ParallelLogger | undefined,
    runtime?: RuntimeStepResolution,
  ): Promise<PartResult> {
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
      runtime,
    );
    if (result.providerInfo) {
      this.recordUsage(
        `${step.name}.${part.id}`,
        result.providerInfo,
        result.response.status === 'done',
        result.response.providerUsage,
      );
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
    recordDelegatedAgentUsage(
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
          currentProviderInfo: this.deps.optionsBuilder.resolveStepProviderModel(partStep, partResolutionRuntime),
        };
      }),
      routeBatchWithAi: this.deps.engineOptions.autoRoutingAiRouter?.routeBatch,
      logger: log,
      abortSignal: this.deps.engineOptions.abortSignal,
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
