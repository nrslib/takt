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
import { runAgent } from '../../../agents/runner.js';
import { ParallelLogger } from './parallel-logger.js';
import { needsStatusJudgmentPhase, runReportPhase, runStatusJudgmentPhase } from '../phase-runner.js';
import { detectMatchedRule } from '../evaluation/index.js';
import { incrementMovementIteration } from './state-manager.js';
import { createLogger, getErrorMessage } from '../../../shared/utils/index.js';
import { buildSessionKey } from '../session-key.js';
import type { OptionsBuilder } from './OptionsBuilder.js';
import type { MovementExecutor } from './MovementExecutor.js';
import type { PieceEngineOptions, PhaseName } from '../types.js';
import type { ParallelLoggerOptions } from './parallel-logger.js';

const log = createLogger('parallel-runner');

export interface ParallelRunnerDeps {
  readonly optionsBuilder: OptionsBuilder;
  readonly movementExecutor: MovementExecutor;
  readonly engineOptions: PieceEngineOptions;
  readonly getCwd: () => string;
  readonly getReportDir: () => string;
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
    maxIterations: number,
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
      ? new ParallelLogger(this.buildParallelLoggerOptions(step.name, movementIteration, subMovements.map((s) => s.name), state.iteration, maxIterations))
      : undefined;

    const ruleCtx = {
      state,
      cwd: this.deps.getCwd(),
      interactive: this.deps.getInteractive(),
      detectRuleIndex: this.deps.detectRuleIndex,
      callAiJudge: this.deps.callAiJudge,
    };

    // Run all sub-movements concurrently (failures are captured, not thrown)
    const settled = await Promise.allSettled(
      subMovements.map(async (subMovement, index) => {
        const subIteration = incrementMovementIteration(state, subMovement.name);
        const subInstruction = this.deps.movementExecutor.buildInstruction(subMovement, subIteration, state, task, maxIterations);

        // Session key uses buildSessionKey (persona:provider) — same as normal movements.
        // This ensures sessions are shared across movements with the same persona+provider,
        // while different providers (e.g., claude-eye vs codex-eye) get separate sessions.
        const subSessionKey = buildSessionKey(subMovement);

        // Phase 1: main execution (Write excluded if sub-movement has report)
        const baseOptions = this.deps.optionsBuilder.buildAgentOptions(subMovement);

        // Override onStream with parallel logger's prefixed handler (immutable)
        const agentOptions = parallelLogger
          ? { ...baseOptions, onStream: parallelLogger.createStreamHandler(subMovement.name, index) }
          : baseOptions;

        this.deps.onPhaseStart?.(subMovement, 1, 'execute', subInstruction);
        const subResponse = await runAgent(subMovement.persona, subInstruction, agentOptions);
        updatePersonaSession(subSessionKey, subResponse.sessionId);
        this.deps.onPhaseComplete?.(subMovement, 1, 'execute', subResponse.content, subResponse.status, subResponse.error);

        // Phase 2/3 context — no overrides needed, phase-runner uses buildSessionKey internally
        const phaseCtx = this.deps.optionsBuilder.buildPhaseRunnerContext(state, subResponse.content, updatePersonaSession, this.deps.onPhaseStart, this.deps.onPhaseComplete);

        // Phase 2: report output for sub-movement
        if (subMovement.outputContracts && subMovement.outputContracts.length > 0) {
          await runReportPhase(subMovement, subIteration, phaseCtx);
        }

        // Phase 3: status judgment for sub-movement
        let subTagContent = '';
        if (needsStatusJudgmentPhase(subMovement)) {
          subTagContent = await runStatusJudgmentPhase(subMovement, phaseCtx);
        }

        const match = await detectMatchedRule(subMovement, subResponse.content, subTagContent, ruleCtx);
        const finalResponse = match
          ? { ...subResponse, matchedRuleIndex: match.index, matchedRuleMethod: match.method }
          : subResponse;

        state.movementOutputs.set(subMovement.name, finalResponse);
        this.deps.movementExecutor.emitMovementReports(subMovement);

        return { subMovement, response: finalResponse, instruction: subInstruction };
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
    return { response: aggregatedResponse, instruction: aggregatedInstruction };
  }

  private buildParallelLoggerOptions(
    movementName: string,
    movementIteration: number,
    subMovementNames: string[],
    iteration: number,
    maxIterations: number,
  ): ParallelLoggerOptions {
    const options: ParallelLoggerOptions = {
      subMovementNames,
      parentOnStream: this.deps.engineOptions.onStream,
      progressInfo: {
        iteration,
        maxIterations,
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
