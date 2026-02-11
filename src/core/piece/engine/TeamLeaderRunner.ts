import { runAgent } from '../../../agents/runner.js';
import type {
  PieceMovement,
  PieceState,
  AgentResponse,
  SubtaskDefinition,
  SubtaskResult,
} from '../../models/types.js';
import { detectMatchedRule } from '../evaluation/index.js';
import { buildSessionKey } from '../session-key.js';
import { ParallelLogger } from './parallel-logger.js';
import { incrementMovementIteration } from './state-manager.js';
import { parseSubtasks } from './task-decomposer.js';
import { buildAbortSignal } from './abort-signal.js';
import { createLogger, getErrorMessage } from '../../../shared/utils/index.js';
import type { OptionsBuilder } from './OptionsBuilder.js';
import type { MovementExecutor } from './MovementExecutor.js';
import type { PieceEngineOptions, PhaseName } from '../types.js';
import type { ParallelLoggerOptions } from './parallel-logger.js';

const log = createLogger('team-leader-runner');

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

function createSubtaskMovement(step: PieceMovement, subtask: SubtaskDefinition): PieceMovement {
  if (!step.teamLeader) {
    throw new Error(`Movement "${step.name}" has no teamLeader configuration`);
  }

  return {
    name: `${step.name}.${subtask.id}`,
    description: subtask.title,
    persona: step.teamLeader.subtaskPersona ?? step.persona,
    personaPath: step.teamLeader.subtaskPersonaPath ?? step.personaPath,
    personaDisplayName: `${step.name}:${subtask.id}`,
    session: 'refresh',
    allowedTools: step.teamLeader.subtaskAllowedTools ?? step.allowedTools,
    mcpServers: step.mcpServers,
    provider: step.provider,
    model: step.model,
    permissionMode: step.teamLeader.subtaskPermissionMode ?? step.permissionMode,
    edit: step.teamLeader.subtaskEdit ?? step.edit,
    instructionTemplate: subtask.instruction,
    passPreviousResponse: false,
  };
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
    const instruction = this.deps.movementExecutor.buildInstruction(
      leaderStep,
      movementIteration,
      state,
      task,
      maxMovements,
    );

    this.deps.onPhaseStart?.(leaderStep, 1, 'execute', instruction);
    const leaderResponse = await runAgent(
      leaderStep.persona,
      instruction,
      this.deps.optionsBuilder.buildAgentOptions(leaderStep),
    );
    updatePersonaSession(buildSessionKey(leaderStep), leaderResponse.sessionId);
    this.deps.onPhaseComplete?.(
      leaderStep,
      1,
      'execute',
      leaderResponse.content,
      leaderResponse.status,
      leaderResponse.error,
    );
    if (leaderResponse.status === 'error') {
      const detail = leaderResponse.error ?? leaderResponse.content ?? 'unknown error';
      throw new Error(`Team leader failed: ${detail}`);
    }

    const subtasks = parseSubtasks(leaderResponse.content, teamLeaderConfig.maxSubtasks);
    log.debug('Team leader decomposed subtasks', {
      movement: step.name,
      subtaskCount: subtasks.length,
      subtaskIds: subtasks.map((subtask) => subtask.id),
    });

    const parallelLogger = this.deps.engineOptions.onStream
      ? new ParallelLogger(this.buildParallelLoggerOptions(
          step.name,
          movementIteration,
          subtasks.map((subtask) => subtask.id),
          state.iteration,
          maxMovements,
        ))
      : undefined;

    const settled = await Promise.allSettled(
      subtasks.map((subtask, index) => this.runSingleSubtask(
        step,
        subtask,
        index,
        teamLeaderConfig.timeoutMs,
        updatePersonaSession,
        parallelLogger,
      )),
    );

    const subtaskResults: SubtaskResult[] = settled.map((result, index) => {
      const subtask = subtasks[index];
      if (!subtask) {
        throw new Error(`Missing subtask at index ${index}`);
      }

      if (result.status === 'fulfilled') {
        state.movementOutputs.set(result.value.response.persona, result.value.response);
        return result.value;
      }

      const errorMsg = getErrorMessage(result.reason);
      const errorResponse: AgentResponse = {
        persona: `${step.name}.${subtask.id}`,
        status: 'error',
        content: '',
        timestamp: new Date(),
        error: errorMsg,
      };
      state.movementOutputs.set(errorResponse.persona, errorResponse);
      return { subtask, response: errorResponse };
    });

    const allFailed = subtaskResults.every((result) => result.response.status === 'error');
    if (allFailed) {
      const errors = subtaskResults.map((result) => `${result.subtask.id}: ${result.response.error}`).join('; ');
      throw new Error(`All team leader subtasks failed: ${errors}`);
    }

    if (parallelLogger) {
      parallelLogger.printSummary(
        step.name,
        subtaskResults.map((result) => ({ name: result.subtask.id, condition: undefined })),
      );
    }

    const aggregatedContent = [
      '## decomposition',
      leaderResponse.content,
      ...subtaskResults.map((result) => [
        `## ${result.subtask.id}: ${result.subtask.title}`,
        result.response.status === 'error'
          ? `[ERROR] ${result.response.error ?? 'unknown error'}`
          : result.response.content,
      ].join('\n')),
    ].join('\n\n---\n\n');

    const ruleCtx = {
      state,
      cwd: this.deps.getCwd(),
      interactive: this.deps.getInteractive(),
      detectRuleIndex: this.deps.detectRuleIndex,
      callAiJudge: this.deps.callAiJudge,
    };
    const match = await detectMatchedRule(step, aggregatedContent, '', ruleCtx);

    const aggregatedResponse: AgentResponse = {
      persona: step.name,
      status: 'done',
      content: aggregatedContent,
      timestamp: new Date(),
      ...(match && { matchedRuleIndex: match.index, matchedRuleMethod: match.method }),
    };

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

  private async runSingleSubtask(
    step: PieceMovement,
    subtask: SubtaskDefinition,
    subtaskIndex: number,
    defaultTimeoutMs: number,
    updatePersonaSession: (persona: string, sessionId: string | undefined) => void,
    parallelLogger: ParallelLogger | undefined,
  ): Promise<SubtaskResult> {
    const subtaskMovement = createSubtaskMovement(step, subtask);
    const baseOptions = this.deps.optionsBuilder.buildAgentOptions(subtaskMovement);
    const timeoutMs = subtask.timeoutMs ?? defaultTimeoutMs;
    const { signal, dispose } = buildAbortSignal(timeoutMs, baseOptions.abortSignal);
    const options = parallelLogger
      ? { ...baseOptions, abortSignal: signal, onStream: parallelLogger.createStreamHandler(subtask.id, subtaskIndex) }
      : { ...baseOptions, abortSignal: signal };

    try {
      const response = await runAgent(subtaskMovement.persona, subtask.instruction, options);
      updatePersonaSession(buildSessionKey(subtaskMovement), response.sessionId);
      return {
        subtask,
        response: {
          ...response,
          persona: subtaskMovement.name,
        },
      };
    } finally {
      dispose();
    }
  }

  private buildParallelLoggerOptions(
    movementName: string,
    movementIteration: number,
    subMovementNames: string[],
    iteration: number,
    maxMovements: number,
  ): ParallelLoggerOptions {
    const options: ParallelLoggerOptions = {
      subMovementNames,
      parentOnStream: this.deps.engineOptions.onStream,
      progressInfo: { iteration, maxMovements },
    };

    if (this.deps.engineOptions.taskPrefix != null && this.deps.engineOptions.taskColorIndex != null) {
      return {
        ...options,
        taskLabel: this.deps.engineOptions.taskPrefix,
        taskColorIndex: this.deps.engineOptions.taskColorIndex,
        parentMovementName: movementName,
        movementIteration,
      };
    }

    return options;
  }
}
