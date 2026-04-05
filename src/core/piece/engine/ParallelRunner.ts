/**
 * Executes parallel piece movements concurrently and aggregates results.
 *
 * When onStream is provided, uses ParallelLogger to prefix each
 * sub-movement's output with `[name]` for readable interleaved display.
 */

import type {
  PieceMovement,
  PieceState,
  AgentResponse,
} from '../../models/types.js';
import { executeAgent } from '../../../agents/agent-usecases.js';
import { ParallelLogger } from './parallel-logger.js';
import { needsStatusJudgmentPhase, runReportPhase, runStatusJudgmentPhase } from '../phase-runner.js';
import { detectMatchedRule } from '../evaluation/index.js';
import type { StatusJudgmentPhaseResult } from '../phase-runner.js';
import { incrementMovementIteration } from './state-manager.js';
import { createLogger, getErrorMessage } from '../../../shared/utils/index.js';
import { buildSessionKey } from '../session-key.js';
import type { OptionsBuilder } from './OptionsBuilder.js';
import type { MovementExecutor } from './MovementExecutor.js';
import type { PieceEngineOptions, PhaseName, PhasePromptParts, JudgeStageEntry } from '../types.js';
import type { ParallelLoggerOptions } from './parallel-logger.js';
import type { StructuredCaller } from '../../../agents/structured-caller.js';

const log = createLogger('parallel-runner');

/**
 * Simple semaphore for controlling concurrency.
 * Limits the number of concurrent async operations.
 * Same implementation as ArpeggioRunner's Semaphore.
 */
class Semaphore {
  private running = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly maxConcurrency: number) {}

  async acquire(): Promise<void> {
    if (this.running < this.maxConcurrency) {
      this.running++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.waiting.push(resolve);
    });
  }

  release(): void {
    if (this.waiting.length > 0) {
      const next = this.waiting.shift()!;
      next();
    } else {
      this.running--;
    }
  }
}

export interface ParallelRunnerDeps {
  readonly optionsBuilder: OptionsBuilder;
  readonly movementExecutor: MovementExecutor;
  readonly engineOptions: PieceEngineOptions;
  readonly getCwd: () => string;
  readonly getReportDir: () => string;
  readonly getInteractive: () => boolean;
  readonly detectRuleIndex: (content: string, movementName: string) => number;
  readonly structuredCaller: StructuredCaller;
  readonly onPhaseStart?: (
    step: PieceMovement,
    phase: 1 | 2 | 3,
    phaseName: PhaseName,
    instruction: string,
    promptParts: PhasePromptParts,
    phaseExecutionId?: string,
    iteration?: number,
  ) => void;
  readonly onPhaseComplete?: (
    step: PieceMovement,
    phase: 1 | 2 | 3,
    phaseName: PhaseName,
    content: string,
    status: string,
    error?: string,
    phaseExecutionId?: string,
    iteration?: number,
  ) => void;
  readonly onJudgeStage?: (
    step: PieceMovement,
    phase: 3,
    phaseName: 'judge',
    entry: JudgeStageEntry,
    phaseExecutionId?: string,
    iteration?: number,
  ) => void;
}

export class ParallelRunner {
  constructor(
    private readonly deps: ParallelRunnerDeps,
  ) {}

  /**
   * Run a parallel movement: execute all sub-movements concurrently, then aggregate results.
   * The aggregated output becomes the parent movement's response for rules evaluation.
   */
  async runParallelMovement(
    step: PieceMovement,
    state: PieceState,
    task: string,
    maxMovements: number,
    updatePersonaSession: (persona: string, sessionId: string | undefined) => void,
  ): Promise<{ response: AgentResponse; instruction: string }> {
    if (!step.parallel) {
      throw new Error(`Movement "${step.name}" has no parallel sub-movements`);
    }
    const subMovements = step.parallel;
    const movementIteration = incrementMovementIteration(state, step.name);
    log.debug('Running parallel movement', {
      movement: step.name,
      subMovements: subMovements.map(s => s.name),
      movementIteration,
    });

    // Create parallel logger for prefixed output (only when streaming is enabled)
    const parallelLogger = this.deps.engineOptions.onStream
      ? new ParallelLogger(this.buildParallelLoggerOptions(step.name, movementIteration, subMovements.map((s) => s.name), state.iteration, maxMovements))
      : undefined;

    const parentPm = this.deps.optionsBuilder.resolveStepProviderModel(step);
    const parentRuleCtx = {
      state,
      cwd: this.deps.getCwd(),
      provider: parentPm.provider,
      resolvedProvider: parentPm.provider,
      resolvedModel: parentPm.model,
      interactive: this.deps.getInteractive(),
      detectRuleIndex: this.deps.detectRuleIndex,
      structuredCaller: this.deps.structuredCaller,
    };

    // Create semaphore for concurrency control (if configured)
    const semaphore = step.concurrency != null
      ? new Semaphore(step.concurrency)
      : undefined;
    if (semaphore) {
      log.debug('Concurrency limit enabled', { movement: step.name, concurrency: step.concurrency });
    }

    // Run all sub-movements concurrently (failures are captured, not thrown)
    // When semaphore is set, at most `concurrency` sub-movements execute simultaneously.
    const settled = await Promise.allSettled(
      subMovements.map(async (subMovement, index) => {
        if (semaphore) {
          await semaphore.acquire();
        }
        try {
        const subIteration = incrementMovementIteration(state, subMovement.name);
        const subInstruction = this.deps.movementExecutor.buildInstruction(subMovement, subIteration, state, task, maxMovements);
        const parentIteration = state.iteration;
        const subPm = this.deps.optionsBuilder.resolveStepProviderModel(subMovement);
        const subRuleCtx = {
          ...parentRuleCtx,
          provider: subPm.provider,
          resolvedProvider: subPm.provider,
          resolvedModel: subPm.model,
        };

        // Session key uses buildSessionKey (persona:provider) — same as normal movements.
        // This ensures sessions are shared across movements with the same persona+provider,
        // while different providers (e.g., claude-eye vs codex-eye) get separate sessions.
        const subSessionKey = buildSessionKey(subMovement);

        // Phase 1: main execution (Write excluded if sub-movement has report)
        const baseOptions = this.deps.optionsBuilder.buildAgentOptions(subMovement);
        let didEmitPhaseStart = false;

        // Override onStream with parallel logger's prefixed handler (immutable)
        const agentOptions = parallelLogger
          ? { ...baseOptions, onStream: parallelLogger.createStreamHandler(subMovement.name, index) }
          : { ...baseOptions };
        agentOptions.onPromptResolved = (promptParts: PhasePromptParts) => {
          this.deps.onPhaseStart?.(subMovement, 1, 'execute', subInstruction, promptParts, undefined, parentIteration);
          didEmitPhaseStart = true;
        };
        const subResponse = await executeAgent(subMovement.persona, subInstruction, agentOptions);
        if (!didEmitPhaseStart) {
          throw new Error(`Missing prompt parts for phase start: ${subMovement.name}:1`);
        }
        updatePersonaSession(subSessionKey, subResponse.sessionId);
        this.deps.onPhaseComplete?.(subMovement, 1, 'execute', subResponse.content, subResponse.status, subResponse.error, undefined, parentIteration);

        // Phase 2/3 context — no overrides needed, phase-runner uses buildSessionKey internally
        const phaseCtx = this.deps.optionsBuilder.buildPhaseRunnerContext(
          state,
          subResponse.content,
          updatePersonaSession,
          this.deps.onPhaseStart,
          this.deps.onPhaseComplete,
          this.deps.onJudgeStage,
          parentIteration,
        );

        // Phase 2: report output for sub-movement
        if (subMovement.outputContracts && subMovement.outputContracts.length > 0) {
          await runReportPhase(subMovement, subIteration, phaseCtx);
        }

        // Phase 3: status judgment for sub-movement
        let subPhase3: StatusJudgmentPhaseResult | undefined;
        try {
          subPhase3 = needsStatusJudgmentPhase(subMovement)
            ? await runStatusJudgmentPhase(subMovement, phaseCtx)
            : undefined;
        } catch (error) {
          log.info('Phase 3 status judgment failed for sub-movement, falling back to phase1 rule evaluation', {
            movement: subMovement.name,
            error: getErrorMessage(error),
          });
        }

        let finalResponse: AgentResponse;
        if (subPhase3) {
          finalResponse = { ...subResponse, matchedRuleIndex: subPhase3.ruleIndex, matchedRuleMethod: subPhase3.method };
        } else {
          const match = await detectMatchedRule(subMovement, subResponse.content, '', subRuleCtx);
          finalResponse = match
            ? { ...subResponse, matchedRuleIndex: match.index, matchedRuleMethod: match.method }
            : subResponse;
        }

        state.movementOutputs.set(subMovement.name, finalResponse);
        this.deps.movementExecutor.emitMovementReports(subMovement);

        return { subMovement, response: finalResponse, instruction: subInstruction };
        } finally {
          if (semaphore) {
            semaphore.release();
          }
        }
      }),
    );

    // Map settled results: fulfilled → as-is, rejected → error AgentResponse
    const subResults = settled.map((result, index) => {
      if (result.status === 'fulfilled') {
        return result.value;
      }
      const failedMovement = subMovements[index]!;
      const errorMsg = getErrorMessage(result.reason);
      log.error('Sub-movement failed', { movement: failedMovement.name, error: errorMsg });
      const errorResponse: AgentResponse = {
        persona: failedMovement.name,
        status: 'error',
        content: '',
        timestamp: new Date(),
        error: errorMsg,
      };
      state.movementOutputs.set(failedMovement.name, errorResponse);
      return { subMovement: failedMovement, response: errorResponse, instruction: '' };
    });

    // If all sub-movements failed (error-originated), throw
    const allFailed = subResults.every(r => r.response.error != null);
    if (allFailed) {
      const errors = subResults.map(r => `${r.subMovement.name}: ${r.response.error}`).join('; ');
      throw new Error(`All parallel sub-movements failed: ${errors}`);
    }

    // Print completion summary
    if (parallelLogger) {
      parallelLogger.printSummary(
        step.name,
        subResults.map((r) => ({
          name: r.subMovement.name,
          condition: r.response.matchedRuleIndex != null && r.subMovement.rules
            ? r.subMovement.rules[r.response.matchedRuleIndex]?.condition
            : undefined,
        })),
      );
    }

    // Aggregate sub-movement outputs into parent movement's response
    const aggregatedContent = subResults
      .map((r) => `## ${r.subMovement.name}\n${r.response.content}`)
      .join('\n\n---\n\n');

    const aggregatedInstruction = subResults
      .map((r) => r.instruction)
      .join('\n\n');

    // Parent movement uses aggregate conditions, so tagContent is empty
    const match = await detectMatchedRule(step, aggregatedContent, '', parentRuleCtx);

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
    return { response: aggregatedResponse, instruction: aggregatedInstruction };
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
      progressInfo: {
        iteration,
        maxMovements,
      },
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
