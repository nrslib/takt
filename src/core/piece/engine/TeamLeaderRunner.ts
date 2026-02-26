import type {
  PieceMovement,
  PieceState,
  AgentResponse,
  PartDefinition,
  PartResult,
} from '../../models/types.js';
import { decomposeTask, executeAgent, requestMoreParts } from '../agent-usecases.js';
import { buildSessionKey } from '../session-key.js';
import { ParallelLogger } from './parallel-logger.js';
import { incrementMovementIteration } from './state-manager.js';
import { buildAbortSignal } from './abort-signal.js';
import { createLogger, getErrorMessage } from '../../../shared/utils/index.js';
import { runTeamLeaderExecution } from './team-leader-execution.js';
import { buildTeamLeaderAggregatedContent } from './team-leader-aggregation.js';
import { createPartMovement, resolvePartErrorDetail, summarizeParts } from './team-leader-common.js';
import { buildTeamLeaderParallelLoggerOptions, emitTeamLeaderProgressHint } from './team-leader-streaming.js';
import type { OptionsBuilder } from './OptionsBuilder.js';
import type { MovementExecutor } from './MovementExecutor.js';
import type { PieceEngineOptions, PhaseName } from '../types.js';

const log = createLogger('team-leader-runner');
const MAX_TOTAL_PARTS = 20;

export interface TeamLeaderRunnerDeps {
  readonly optionsBuilder: OptionsBuilder;
  readonly movementExecutor: MovementExecutor;
  readonly engineOptions: PieceEngineOptions;
  readonly getCwd: () => string;
  readonly getInteractive: () => boolean;
  readonly detectRuleIndex: (content: string, movementName: string) => number;
  readonly callAiJudge: (
    agentOutput: string,
    conditions: Array<{ index: number; text: string }>,
    options: { cwd: string }
  ) => Promise<number>;
  readonly onPhaseStart?: (step: PieceMovement, phase: 1 | 2 | 3, phaseName: PhaseName, instruction: string) => void;
  readonly onPhaseComplete?: (step: PieceMovement, phase: 1 | 2 | 3, phaseName: PhaseName, content: string, status: string, error?: string) => void;
}

export class TeamLeaderRunner {
  constructor(
    private readonly deps: TeamLeaderRunnerDeps,
  ) {}

  async runTeamLeaderMovement(
    step: PieceMovement,
    state: PieceState,
    task: string,
    maxMovements: number,
    updatePersonaSession: (persona: string, sessionId: string | undefined) => void,
  ): Promise<{ response: AgentResponse; instruction: string }> {
    if (!step.teamLeader) {
      throw new Error(`Movement "${step.name}" has no teamLeader configuration`);
    }
    const teamLeaderConfig = step.teamLeader;

    const movementIteration = incrementMovementIteration(state, step.name);
    const leaderStep: PieceMovement = {
      ...step,
      persona: teamLeaderConfig.persona ?? step.persona,
      personaPath: teamLeaderConfig.personaPath ?? step.personaPath,
    };
    const leaderProvider = leaderStep.provider ?? this.deps.engineOptions.provider;
    const leaderModel = leaderStep.model ?? this.deps.engineOptions.model;
    const instruction = this.deps.movementExecutor.buildInstruction(
      leaderStep,
      movementIteration,
      state,
      task,
      maxMovements,
    );

    emitTeamLeaderProgressHint(this.deps.engineOptions, 'decompose');
    this.deps.onPhaseStart?.(leaderStep, 1, 'execute', instruction);
    const parts = await decomposeTask(instruction, teamLeaderConfig.maxParts, {
      cwd: this.deps.getCwd(),
      persona: leaderStep.persona,
      personaPath: leaderStep.personaPath,
      model: leaderModel,
      provider: leaderProvider,
    });
    const leaderResponse: AgentResponse = {
      persona: leaderStep.persona ?? leaderStep.name,
      status: 'done',
      content: JSON.stringify({ parts }, null, 2),
      timestamp: new Date(),
    };
    this.deps.onPhaseComplete?.(leaderStep, 1, 'execute', leaderResponse.content, leaderResponse.status, leaderResponse.error);
    log.debug('Team leader decomposed parts', {
      movement: step.name,
      partCount: parts.length,
      partIds: parts.map((part) => part.id),
    });
    log.info('Team leader decomposition completed', {
      movement: step.name,
      partCount: parts.length,
      parts: summarizeParts(parts),
    });

    const parallelLogger = this.deps.engineOptions.onStream
      ? new ParallelLogger(buildTeamLeaderParallelLoggerOptions(
        this.deps.engineOptions,
        step.name,
        movementIteration,
        parts.map((part) => part.id),
        state.iteration,
        maxMovements,
      ))
      : undefined;

    const { plannedParts, partResults } = await runTeamLeaderExecution({
      initialParts: parts,
      maxConcurrency: teamLeaderConfig.maxParts,
      refillThreshold: teamLeaderConfig.refillThreshold,
      maxTotalParts: MAX_TOTAL_PARTS,
      onPartQueued: (part) => {
        parallelLogger?.addSubMovement(part.id);
      },
      onPartCompleted: (result) => {
        state.movementOutputs.set(result.response.persona, result.response);
      },
      onPlanningDone: ({ reason, plannedParts: plannedCount, completedParts }) => {
        log.info('Team leader marked planning as done', {
          movement: step.name,
          plannedParts: plannedCount,
          completedParts,
          reasoning: reason,
        });
      },
      onPlanningNoNewParts: ({ reason, plannedParts: plannedCount, completedParts }) => {
        log.info('Team leader returned no new unique parts; stop planning', {
          movement: step.name,
          plannedParts: plannedCount,
          completedParts,
          reasoning: reason,
        });
      },
      onPartsAdded: ({ parts: addedParts, reason, totalPlanned }) => {
        log.info('Team leader added new parts', {
          movement: step.name,
          addedCount: addedParts.length,
          totalPlannedAfterAdd: totalPlanned,
          parts: summarizeParts(addedParts),
          reasoning: reason,
        });
      },
      onPlanningError: (error) => {
        log.info('Team leader feedback failed; stop adding new parts', {
          movement: step.name,
          detail: getErrorMessage(error),
        });
      },
      requestMoreParts: async ({ partResults: currentResults, scheduledIds, remainingPartBudget }) => {
        emitTeamLeaderProgressHint(this.deps.engineOptions, 'feedback');
        return requestMoreParts(
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

    aggregatedResponse = await this.deps.movementExecutor.applyPostExecutionPhases(
      step,
      state,
      movementIteration,
      aggregatedResponse,
      updatePersonaSession,
    );

    state.movementOutputs.set(step.name, aggregatedResponse);
    state.lastOutput = aggregatedResponse;
    this.deps.movementExecutor.persistPreviousResponseSnapshot(
      state,
      step.name,
      movementIteration,
      aggregatedResponse.content,
    );
    this.deps.movementExecutor.emitMovementReports(step);

    return { response: aggregatedResponse, instruction };
  }

  private async runSinglePart(
    step: PieceMovement,
    part: PartDefinition,
    partIndex: number,
    defaultTimeoutMs: number,
    updatePersonaSession: (persona: string, sessionId: string | undefined) => void,
    parallelLogger: ParallelLogger | undefined,
  ): Promise<PartResult> {
    const partMovement = createPartMovement(step, part);
    const baseOptions = this.deps.optionsBuilder.buildAgentOptions(partMovement);
    const timeoutMs = part.timeoutMs ?? defaultTimeoutMs;
    const { signal, dispose } = buildAbortSignal(timeoutMs, baseOptions.abortSignal);
    const options = parallelLogger
      ? { ...baseOptions, abortSignal: signal, onStream: parallelLogger.createStreamHandler(part.id, partIndex) }
      : { ...baseOptions, abortSignal: signal };

    try {
      const response = await executeAgent(partMovement.persona, part.instruction, options);
      updatePersonaSession(buildSessionKey(partMovement), response.sessionId);
      return {
        part,
        response: {
          ...response,
          persona: partMovement.name,
        },
      };
    } finally {
      dispose();
    }
  }

  private buildErrorPartResult(
    step: PieceMovement,
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
