import type {
  WorkflowStep,
  WorkflowState,
  AgentResponse,
  PartDefinition,
  PartResult,
  WorkflowMaxSteps,
} from '../../models/types.js';
import { executeAgent } from '../../../agents/agent-usecases.js';
import { buildSessionKey } from '../session-key.js';
import { ParallelLogger } from './parallel-logger.js';
import { incrementStepIteration } from './state-manager.js';
import { buildAbortSignal } from './abort-signal.js';
import { createLogger, getErrorMessage } from '../../../shared/utils/index.js';
import { runTeamLeaderExecution } from './team-leader-execution.js';
import { buildTeamLeaderAggregatedContent } from './team-leader-aggregation.js';
import { createPartStep, resolvePartErrorDetail, summarizeParts } from './team-leader-common.js';
import { buildTeamLeaderParallelLoggerOptions, emitTeamLeaderProgressHint } from './team-leader-streaming.js';
import type { OptionsBuilder } from './OptionsBuilder.js';
import type { StepExecutor } from './StepExecutor.js';
import type { WorkflowEngineOptions, PhaseName, PhasePromptParts } from '../types.js';

const log = createLogger('team-leader-runner');
const MAX_TOTAL_PARTS = 20;

export interface TeamLeaderRunnerDeps {
  readonly optionsBuilder: OptionsBuilder;
  readonly stepExecutor: StepExecutor;
  readonly engineOptions: WorkflowEngineOptions;
  readonly getCwd: () => string;
  readonly getInteractive: () => boolean;
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
  ): Promise<{ response: AgentResponse; instruction: string }> {
    if (!step.teamLeader) {
      throw new Error(`Step "${step.name}" has no teamLeader configuration`);
    }
    const teamLeaderConfig = step.teamLeader;
    const parentIteration = state.iteration;

    const stepIteration = incrementStepIteration(state, step.name);
    const leaderStep: WorkflowStep = {
      ...step,
      persona: teamLeaderConfig.persona ?? step.persona,
      personaPath: teamLeaderConfig.personaPath ?? step.personaPath,
    };
    const { provider: leaderProvider, model: leaderModel } = this.deps.optionsBuilder.resolveStepProviderModel(leaderStep);
    const instruction = this.deps.stepExecutor.buildInstruction(
      leaderStep,
      stepIteration,
      state,
      task,
      maxSteps,
    );

    emitTeamLeaderProgressHint(this.deps.engineOptions, 'decompose');
    let didEmitPhaseStart = false;
    const structuredCaller = this.deps.engineOptions.structuredCaller;
    if (!structuredCaller) {
      throw new Error('structuredCaller is required for team leader execution');
    }
    const parts = await structuredCaller.decomposeTask(instruction, teamLeaderConfig.maxParts, {
      cwd: this.deps.getCwd(),
      persona: leaderStep.persona,
      personaPath: leaderStep.personaPath,
      model: leaderModel,
      provider: leaderProvider,
      resolvedModel: leaderModel,
      resolvedProvider: leaderProvider,
      onStream: this.deps.engineOptions.onStream,
      onPromptResolved: (promptParts) => {
        this.deps.onPhaseStart?.(leaderStep, 1, 'execute', promptParts.userInstruction, promptParts, undefined, parentIteration);
        didEmitPhaseStart = true;
      },
    });
    if (!didEmitPhaseStart) {
      throw new Error(`Missing prompt parts for phase start: ${leaderStep.name}:1`);
    }
    const leaderResponse: AgentResponse = {
      persona: leaderStep.persona ?? leaderStep.name,
      status: 'done',
      content: JSON.stringify({ parts }, null, 2),
      timestamp: new Date(),
    };
    this.deps.onPhaseComplete?.(leaderStep, 1, 'execute', leaderResponse.content, leaderResponse.status, leaderResponse.error, undefined, parentIteration);
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

    const { plannedParts, partResults } = await runTeamLeaderExecution({
      initialParts: parts,
      maxConcurrency: teamLeaderConfig.maxParts,
      refillThreshold: teamLeaderConfig.refillThreshold,
      maxTotalParts: MAX_TOTAL_PARTS,
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
      requestMoreParts: async ({ partResults: currentResults, scheduledIds, remainingPartBudget }) => {
        emitTeamLeaderProgressHint(this.deps.engineOptions, 'feedback');
        return structuredCaller.requestMoreParts(
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
            onStream: this.deps.engineOptions.onStream,
          },
        );
      },
      runPart: async (part, partIndex) => this.runSinglePart(
        step,
        part,
        partIndex,
        teamLeaderConfig.timeoutMs,
        updatePersonaSession,
        parallelLogger,
      ).catch((error) => this.buildErrorPartResult(step, part, error)),
    });

    const allFailed = partResults.every((result) => result.response.status === 'error');
    if (allFailed) {
      const errors = partResults.map((result) => `${result.part.id}: ${resolvePartErrorDetail(result)}`).join('; ');
      throw new Error(`All team leader parts failed: ${errors}`);
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
    );

    state.stepOutputs.set(step.name, aggregatedResponse);
    state.lastOutput = aggregatedResponse;
    this.deps.stepExecutor.persistPreviousResponseSnapshot(
      state,
      step.name,
      stepIteration,
      aggregatedResponse.content,
    );
    this.deps.stepExecutor.emitStepReports(step);

    return { response: aggregatedResponse, instruction };
  }

  private async runSinglePart(
    step: WorkflowStep,
    part: PartDefinition,
    partIndex: number,
    defaultTimeoutMs: number,
    updatePersonaSession: (persona: string, sessionId: string | undefined) => void,
    parallelLogger: ParallelLogger | undefined,
  ): Promise<PartResult> {
    const partStep = createPartStep(step, part);
    const partProviderInfo = this.deps.optionsBuilder.resolveStepProviderModel(partStep);
    const partAllowedTools = step.teamLeader?.partAllowedTools;
    const baseOptions = this.deps.optionsBuilder.buildAgentOptions(partStep, {
      providerInfo: partProviderInfo,
      teamLeaderPart: {
        partAllowedTools,
      },
    });
    const timeoutMs = defaultTimeoutMs;
    const { signal, dispose } = buildAbortSignal(timeoutMs, baseOptions.abortSignal);
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

  private buildErrorPartResult(
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
}
