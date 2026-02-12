import { runAgent } from '../../../agents/runner.js';
import type {
  PieceMovement,
  PieceState,
  AgentResponse,
  PartDefinition,
  PartResult,
} from '../../models/types.js';
import { detectMatchedRule } from '../evaluation/index.js';
import { buildSessionKey } from '../session-key.js';
import { ParallelLogger } from './parallel-logger.js';
import { incrementMovementIteration } from './state-manager.js';
import { parseParts } from './task-decomposer.js';
import { buildAbortSignal } from './abort-signal.js';
import { createLogger, getErrorMessage } from '../../../shared/utils/index.js';
import type { OptionsBuilder } from './OptionsBuilder.js';
import type { MovementExecutor } from './MovementExecutor.js';
import type { PieceEngineOptions, PhaseName } from '../types.js';
import type { ParallelLoggerOptions } from './parallel-logger.js';

const log = createLogger('team-leader-runner');

function resolvePartErrorDetail(partResult: PartResult): string {
  const detail = partResult.response.error ?? partResult.response.content;
  if (!detail) {
    throw new Error(`Part "${partResult.part.id}" failed without error detail`);
  }
  return detail;
}

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

function createPartMovement(step: PieceMovement, part: PartDefinition): PieceMovement {
  if (!step.teamLeader) {
    throw new Error(`Movement "${step.name}" has no teamLeader configuration`);
  }

  return {
    name: `${step.name}.${part.id}`,
    description: part.title,
    persona: step.teamLeader.partPersona ?? step.persona,
    personaPath: step.teamLeader.partPersonaPath ?? step.personaPath,
    personaDisplayName: `${step.name}:${part.id}`,
    session: 'refresh',
    allowedTools: step.teamLeader.partAllowedTools ?? step.allowedTools,
    mcpServers: step.mcpServers,
    provider: step.provider,
    model: step.model,
    permissionMode: step.teamLeader.partPermissionMode ?? step.permissionMode,
    edit: step.teamLeader.partEdit ?? step.edit,
    instructionTemplate: part.instruction,
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
      const detail = leaderResponse.error ?? leaderResponse.content;
      throw new Error(`Team leader failed: ${detail}`);
    }

    const parts = parseParts(leaderResponse.content, teamLeaderConfig.maxParts);
    log.debug('Team leader decomposed parts', {
      movement: step.name,
      partCount: parts.length,
      partIds: parts.map((part) => part.id),
    });

    const parallelLogger = this.deps.engineOptions.onStream
      ? new ParallelLogger(this.buildParallelLoggerOptions(
          step.name,
          movementIteration,
          parts.map((part) => part.id),
          state.iteration,
          maxMovements,
        ))
      : undefined;

    const settled = await Promise.allSettled(
      parts.map((part, index) => this.runSinglePart(
        step,
        part,
        index,
        teamLeaderConfig.timeoutMs,
        updatePersonaSession,
        parallelLogger,
      )),
    );

    const partResults: PartResult[] = settled.map((result, index) => {
      const part = parts[index];
      if (!part) {
        throw new Error(`Missing part at index ${index}`);
      }

      if (result.status === 'fulfilled') {
        state.movementOutputs.set(result.value.response.persona, result.value.response);
        return result.value;
      }

      const errorMsg = getErrorMessage(result.reason);
      const errorResponse: AgentResponse = {
        persona: `${step.name}.${part.id}`,
        status: 'error',
        content: '',
        timestamp: new Date(),
        error: errorMsg,
      };
      state.movementOutputs.set(errorResponse.persona, errorResponse);
      return { part, response: errorResponse };
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

    const aggregatedContent = [
      '## decomposition',
      leaderResponse.content,
      ...partResults.map((result) => [
        `## ${result.part.id}: ${result.part.title}`,
        result.response.status === 'error'
          ? `[ERROR] ${resolvePartErrorDetail(result)}`
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
      const response = await runAgent(partMovement.persona, part.instruction, options);
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
