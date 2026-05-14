/**
 * Executes parallel workflow steps concurrently and aggregates results.
 *
 * When onStream is provided, uses ParallelLogger to prefix each
 * sub-step output with `[name]` for readable interleaved display.
 */

import type {
  WorkflowStep,
  WorkflowState,
  AgentResponse,
  WorkflowMaxSteps,
} from '../../models/types.js';
import { executeAgent } from '../../../agents/agent-usecases.js';
import { ParallelLogger } from './parallel-logger.js';
import { needsStatusJudgmentPhase, runReportPhase, runStatusJudgmentPhase } from '../phase-runner.js';
import { detectMatchedRule } from '../evaluation/index.js';
import type { StatusJudgmentPhaseResult } from '../phase-runner.js';
import { incrementStepIteration } from './state-manager.js';
import { createLogger, getErrorMessage } from '../../../shared/utils/index.js';
import { buildSessionKey } from '../session-key.js';
import type { OptionsBuilder } from './OptionsBuilder.js';
import type { StepExecutor } from './StepExecutor.js';
import type { WorkflowEngineOptions, PhaseName, PhasePromptParts, JudgeStageEntry, StepRunResult } from '../types.js';
import type { RuntimeStepResolution } from '../types.js';
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
  readonly stepExecutor: StepExecutor;
  readonly engineOptions: WorkflowEngineOptions;
  readonly getCwd: () => string;
  readonly getReportDir: () => string;
  readonly getInteractive: () => boolean;
  readonly detectRuleIndex: (content: string, stepName: string) => number;
  readonly structuredCaller: StructuredCaller;
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
  readonly onJudgeStage?: (
    step: WorkflowStep,
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
   * Run a parallel step: execute all sub-steps concurrently, then aggregate results.
   * The aggregated output becomes the parent step response for rules evaluation.
   */
  async runParallelStep(
    step: WorkflowStep,
    state: WorkflowState,
    task: string,
    maxSteps: WorkflowMaxSteps,
    updatePersonaSession: (persona: string, sessionId: string | undefined) => void,
    runtime?: RuntimeStepResolution,
  ): Promise<StepRunResult> {
    if (!step.parallel) {
      throw new Error(`Step "${step.name}" has no parallel sub-steps`);
    }
    const subSteps = step.parallel;
    const stepIteration = incrementStepIteration(state, step.name);
    log.debug('Running parallel step', {
      step: step.name,
      subSteps: subSteps.map(s => s.name),
      stepIteration,
    });

    // Create parallel logger for prefixed output (only when streaming is enabled)
    const parallelLogger = this.deps.engineOptions.onStream
      ? new ParallelLogger(this.buildParallelLoggerOptions(step.name, stepIteration, subSteps.map((s) => s.name), state.iteration, maxSteps))
      : undefined;

    const parentPm = runtime
      ? this.deps.optionsBuilder.resolveStepProviderModel(step, runtime)
      : this.deps.optionsBuilder.resolveStepProviderModel(step);
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
      log.debug('Concurrency limit enabled', { step: step.name, concurrency: step.concurrency });
    }

    // Run all sub-steps concurrently (failures are captured, not thrown)
    // When semaphore is set, at most `concurrency` sub-steps execute simultaneously.
    const settled = await Promise.allSettled(
      subSteps.map(async (subStep, index) => {
        if (semaphore) {
          await semaphore.acquire();
        }
        try {
        const subIteration = incrementStepIteration(state, subStep.name);
        const subInstruction = this.deps.stepExecutor.buildInstruction(
          subStep,
          subIteration,
          state,
          task,
          maxSteps,
          runtime?.fallback,
        );
        const parentIteration = state.iteration;
        const subPm = runtime
          ? this.deps.optionsBuilder.resolveStepProviderModel(subStep, runtime)
          : this.deps.optionsBuilder.resolveStepProviderModel(subStep);
        const subRuleCtx = {
          ...parentRuleCtx,
          provider: subPm.provider,
          resolvedProvider: subPm.provider,
          resolvedModel: subPm.model,
        };

        // Session key uses buildSessionKey (persona:provider) — same as normal steps.
        // This ensures sessions are shared across steps with the same persona+provider,
        // while different providers (e.g., claude-eye vs codex-eye) get separate sessions.
        const subSessionKey = buildSessionKey(subStep, runtime?.providerInfo?.provider);

        // Phase 1: main execution (Write excluded if sub-step has report)
        const baseOptions = this.deps.optionsBuilder.buildAgentOptions(subStep, runtime);
        let didEmitPhaseStart = false;

        // Override onStream with parallel logger's prefixed handler (immutable)
        const agentOptions = parallelLogger
          ? { ...baseOptions, onStream: parallelLogger.createStreamHandler(subStep.name, index) }
          : { ...baseOptions };
        agentOptions.onPromptResolved = (promptParts: PhasePromptParts) => {
          this.deps.onPhaseStart?.(subStep, 1, 'execute', subInstruction, promptParts, undefined, parentIteration);
          didEmitPhaseStart = true;
        };
        const subResponse = await executeAgent(subStep.persona, subInstruction, agentOptions);
        if (!didEmitPhaseStart) {
          throw new Error(`Missing prompt parts for phase start: ${subStep.name}:1`);
        }
        updatePersonaSession(subSessionKey, subResponse.sessionId);
        this.deps.onPhaseComplete?.(subStep, 1, 'execute', subResponse.content, subResponse.status, subResponse.error, undefined, parentIteration);
        if (subResponse.status === 'error' || subResponse.status === 'blocked' || subResponse.status === 'rate_limited') {
          state.stepOutputs.set(subStep.name, subResponse);
          return { subStep, response: subResponse, instruction: subInstruction, providerInfo: subPm };
        }

        // Phase 2/3 context resolves the same runtime-aware session key as Phase 1.
        const phaseCtx = this.deps.optionsBuilder.buildPhaseRunnerContext(
          state,
          subResponse.content,
          updatePersonaSession,
          this.deps.onPhaseStart,
          this.deps.onPhaseComplete,
          this.deps.onJudgeStage,
          parentIteration,
          runtime,
        );

        // Phase 2: report output for sub-step
        if (subStep.outputContracts && subStep.outputContracts.length > 0) {
          const reportResult = await runReportPhase(subStep, subIteration, phaseCtx);
          if (reportResult && 'blocked' in reportResult) {
            const blockedResponse: AgentResponse = {
              ...subResponse,
              status: 'blocked',
              content: reportResult.response.content,
            };
            state.stepOutputs.set(subStep.name, blockedResponse);
            return { subStep, response: blockedResponse, instruction: subInstruction, providerInfo: subPm };
          }
          if (reportResult && 'rateLimited' in reportResult) {
            const rateLimitedResponse: AgentResponse = {
              ...reportResult.response,
              persona: subStep.name,
            };
            state.stepOutputs.set(subStep.name, rateLimitedResponse);
            return { subStep, response: rateLimitedResponse, instruction: subInstruction, providerInfo: subPm };
          }
        }

        // Phase 3: status judgment for sub-step
        let subPhase3: StatusJudgmentPhaseResult | undefined;
        try {
          subPhase3 = needsStatusJudgmentPhase(subStep)
            ? await runStatusJudgmentPhase(subStep, phaseCtx)
            : undefined;
        } catch (error) {
          log.info('Phase 3 status judgment failed for sub-step, falling back to phase1 rule evaluation', {
            step: subStep.name,
            error: getErrorMessage(error),
          });
        }

        let finalResponse: AgentResponse;
        if (subPhase3) {
          finalResponse = { ...subResponse, matchedRuleIndex: subPhase3.ruleIndex, matchedRuleMethod: subPhase3.method };
        } else {
          const match = await detectMatchedRule(subStep, subResponse.content, '', subRuleCtx);
          finalResponse = match
            ? { ...subResponse, matchedRuleIndex: match.index, matchedRuleMethod: match.method }
            : subResponse;
        }

        state.stepOutputs.set(subStep.name, finalResponse);
        this.deps.stepExecutor.emitStepReports(subStep);

        return { subStep, response: finalResponse, instruction: subInstruction, providerInfo: subPm };
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
      const failedStep = subSteps[index]!;
      const errorMsg = getErrorMessage(result.reason);
      log.error('Sub-step failed', { step: failedStep.name, error: errorMsg });
      const errorResponse: AgentResponse = {
        persona: failedStep.name,
        status: 'error',
        content: '',
        timestamp: new Date(),
        error: errorMsg,
      };
      state.stepOutputs.set(failedStep.name, errorResponse);
      return { subStep: failedStep, response: errorResponse, instruction: '', providerInfo: undefined };
    });

    const rateLimitedResult = subResults.find((r) => r.response.status === 'rate_limited');
    if (rateLimitedResult) {
      const rateLimitedResponse: AgentResponse = {
        ...rateLimitedResult.response,
        persona: step.name,
      };
      state.stepOutputs.set(step.name, rateLimitedResponse);
      state.lastOutput = rateLimitedResponse;
      return {
        response: rateLimitedResponse,
        instruction: rateLimitedResult.instruction,
        providerInfo: rateLimitedResult.providerInfo,
        consumedStepIterations: [
          step.name,
          ...subResults.map((result) => result.subStep.name),
        ],
      };
    }

    // If all sub-steps failed (error-originated), throw
    const allFailed = subResults.every(r => r.response.error != null);
    if (allFailed) {
      const errors = subResults.map(r => `${r.subStep.name}: ${r.response.error}`).join('; ');
      throw new Error(`All parallel sub-steps failed: ${errors}`);
    }

    // Print completion summary
    if (parallelLogger) {
      parallelLogger.printSummary(
        step.name,
        subResults.map((r) => ({
          name: r.subStep.name,
          condition: r.response.matchedRuleIndex != null && r.subStep.rules
            ? r.subStep.rules[r.response.matchedRuleIndex]?.condition
            : undefined,
        })),
      );
    }

    // Aggregate sub-step outputs into the parent step response
    const aggregatedContent = subResults
      .map((r) => `## ${r.subStep.name}\n${r.response.content}`)
      .join('\n\n---\n\n');

    const aggregatedInstruction = subResults
      .map((r) => r.instruction)
      .join('\n\n');

    // Parent step uses aggregate conditions, so tagContent is empty
    const match = await detectMatchedRule(step, aggregatedContent, '', parentRuleCtx);

    const aggregatedResponse: AgentResponse = {
      persona: step.name,
      status: 'done',
      content: aggregatedContent,
      timestamp: new Date(),
      ...(match && { matchedRuleIndex: match.index, matchedRuleMethod: match.method }),
    };

    state.stepOutputs.set(step.name, aggregatedResponse);
    state.lastOutput = aggregatedResponse;
    this.deps.stepExecutor.persistPreviousResponseSnapshot(
      state,
      step.name,
      stepIteration,
      aggregatedResponse.content,
    );
    this.deps.stepExecutor.emitStepReports(step);
    return { response: aggregatedResponse, instruction: aggregatedInstruction, providerInfo: parentPm };
  }

  private buildParallelLoggerOptions(
    stepName: string,
    stepIteration: number,
    subStepNames: string[],
    iteration: number,
    maxSteps: WorkflowMaxSteps,
  ): ParallelLoggerOptions {
    const options: ParallelLoggerOptions = {
      subStepNames,
      parentOnStream: this.deps.engineOptions.onStream,
      progressInfo: {
        iteration,
        maxSteps,
      },
    };

    if (this.deps.engineOptions.taskPrefix != null && this.deps.engineOptions.taskColorIndex != null) {
      return {
        ...options,
        taskLabel: this.deps.engineOptions.taskPrefix,
        taskColorIndex: this.deps.engineOptions.taskColorIndex,
        parentStepName: stepName,
        stepIteration,
      };
    }

    return options;
  }

}
