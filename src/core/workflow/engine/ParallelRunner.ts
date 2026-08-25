/**
 * Executes parallel workflow steps concurrently and aggregates results.
 *
 * When onStream is provided, uses ParallelLogger to prefix each
 * sub-step output with `[name]` for readable interleaved display.
 */

import type {
  WorkflowStep,
  AgentWorkflowStep,
  WorkflowState,
  AgentResponse,
  WorkflowMaxSteps,
  WorkflowResumePointEntry,
} from '../../models/types.js';
import { isDynamicParallelSubSteps } from '../../models/types.js';
import { executeAgent } from '../../../agents/agent-usecases.js';
import { getWorkflowResumeFrameKind, isWorkflowCallStep } from '../step-kind.js';
import { ParallelLogger } from './parallel-logger.js';
import { runReportPhase, ReportPhaseGenerationError } from '../phase-runner.js';
import { RuleDetectionExhaustedError } from '../evaluation/RuleDetectionExhaustedError.js';
import { incrementStepIteration } from './state-manager.js';
import { createLogger, getErrorMessage } from '../../../shared/utils/index.js';
import { buildSessionKey } from '../session-key.js';
import type { OptionsBuilder } from './OptionsBuilder.js';
import type { StepExecutor } from './StepExecutor.js';
import type { WorkflowEngineOptions, PhaseName, PhasePromptParts, JudgeStageEntry, StepRunResult } from '../types.js';
import type { RuntimeStepResolution } from '../types.js';
import type {
  WorkflowStepInactivityDeadline,
  WorkflowStepExecutionDeadlineContext,
} from './step-deadline.js';
import type { ParallelLoggerOptions } from './parallel-logger.js';
import type { RunAgentOptions } from '../../../agents/types.js';
import { createRoutingScope, resolveAutoRoutingBatch } from '../auto-routing/resolver.js';
import { buildRoutingWorkSnapshot } from '../auto-routing/snapshot.js';
import type { QualityGateRunResult } from '../quality-gates/types.js';
import { sanitizeSensitiveText } from '../../../shared/utils/sensitiveText.js';
import { truncateUtf8PreservingMarker } from '../../../shared/utils/text.js';
import type { WorkflowCallRunner } from './WorkflowCallRunner.js';
import {
  getWorkflowCallChildExecutionState,
  type WorkflowCallIsolatedStateSync,
  type WorkflowCallSessionUpdates,
} from './WorkflowCallExecutor.js';
import { compactSessionBeforePhase1 } from './session-compaction.js';
import { invalidateExpectedPersonaSession, invalidatePersonaSessionIfExpected } from './session-invalidation.js';
import { recordAgentUsageEvent } from './agent-usage-event.js';
import {
  aggregateConditionsOf,
  formatWorkflowRuleCondition,
  PARALLEL_TERMINAL_ERROR_LABEL,
  semanticLabelsOf,
} from '../../models/workflow-rule-condition.js';
import { evaluatePostExecutionRules } from './post-execution-rule-evaluator.js';
import { determineRuleTransition } from './transitions.js';
import { buildScopedStepIterationIdentity } from '../step-iteration-identity.js';
import { createRunFailure } from '../run/run-failure.js';
import {
  completeObservedPhase1Attempt,
  executeObservedPhase1Attempt,
  PHASE1_EMPTY_OUTPUT_ERROR,
  runPhase1WithEmptyRecovery,
} from './phase1-empty-recovery.js';
import {
  fallbackContextForOperation,
  reviewerOperationOrigin,
  runtimeForOperation,
} from './fallback-operation.js';
import type { DynamicParallelSelectorCoordinator } from '../dynamic-parallel/selector-coordinator.js';
import { validateProviderModelRequirements } from '../provider-model-requirements.js';
import { formatCompletionRetryDiagnostic } from '../completion-retry.js';
import { sumRetryCounts } from '../../models/response.js';
import {
  AGENT_FAILURE_CATEGORIES,
  MAX_AGENT_FAILURE_MESSAGE_BYTES,
  createProviderStreamParseError,
  isProviderStreamParseError,
} from '../../../shared/types/agent-failure.js';

const log = createLogger('parallel-runner');
export const MAX_EXPLICIT_PARALLEL_ERROR_RETRIES = 3;

type ParallelSubStepResult = {
  subStep: WorkflowStep;
  response: AgentResponse;
  instruction: string;
  providerInfo?: StepRunResult['providerInfo'];
  durationMs?: number;
  qualityGateFailure?: boolean;
  workflowCallSessionUpdates?: WorkflowCallSessionUpdates;
  workflowCallStateSync?: WorkflowCallIsolatedStateSync;
  workflowCallFailure?: StepRunResult['workflowCallFailure'];
  workflowCallExecutionRejected?: boolean;
  executionRejected?: boolean;
  terminalOperation?: StepRunResult['terminalOperation'];
};

type ParallelTerminalStatus = 'error' | 'blocked' | 'rate_limited';

function isAgentParallelSubStep(step: WorkflowStep): step is AgentWorkflowStep {
  return !isWorkflowCallStep(step) && step.kind !== 'system';
}

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
  readonly getAbortSignal?: () => AbortSignal | undefined;
  readonly getCwd: () => string;
  readonly dynamicParallelSelector: DynamicParallelSelectorCoordinator;
  readonly getWorkflowName: () => string;
  readonly getTask: () => string;
  readonly getInteractive: () => boolean;
  readonly observabilityEnabled: boolean;
  readonly observabilityRunId?: string;
  readonly sanitizeObservabilityText?: (text: string) => string;
  readonly getCurrentWorkflowStack?: () => WorkflowResumePointEntry[] | undefined;
  readonly emitEvent: (event: string, ...args: unknown[]) => void;
  readonly getWorkflowCallRunner?: () => WorkflowCallRunner;
  readonly claimStepOccurrence: (
    step: WorkflowStep,
    resumeStackPrefix: readonly WorkflowResumePointEntry[],
  ) => number;
  readonly updateMaxSteps: (maxSteps: WorkflowMaxSteps) => void;
  readonly setActiveResumePoint: (
    step: WorkflowStep,
    iteration: number,
    occurrence: number,
  ) => void;
  readonly getRunId: () => string;
  readonly runQualityGates: (options: {
    qualityGates: WorkflowStep['qualityGates'];
    projectRoot: string;
    step: WorkflowStep;
    childProcessEnv?: Readonly<Record<string, string>>;
    observabilityEnabled: boolean;
    runId?: string;
    workflowName?: string;
  }) => Promise<QualityGateRunResult>;
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
  private readonly explicitErrorAttemptsByStep = new Map<string, number>();

  constructor(
    private readonly deps: ParallelRunnerDeps,
  ) {}

  private resolveAbortSignal(): AbortSignal | undefined {
    return this.deps.getAbortSignal?.() ?? this.deps.engineOptions.abortSignal;
  }

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
    activeStepIteration?: number,
    executionDeadlineContext?: WorkflowStepExecutionDeadlineContext,
  ): Promise<StepRunResult> {
    if (!step.parallel) {
      throw new Error(`Step "${step.name}" has no parallel sub-steps`);
    }
    const selectorProvider = this.deps.engineOptions.selectorProvider;
    const selectorDeadline = isDynamicParallelSubSteps(step.parallel) && selectorProvider !== undefined
      ? executionDeadlineContext?.begin('parallel-selector', selectorProvider)
      : undefined;
    const subSteps = isDynamicParallelSubSteps(step.parallel)
      ? await runWithExecutionDeadline(
          executionDeadlineContext,
          selectorDeadline,
          () => this.deps.dynamicParallelSelector.selectParticipants(step, state, task),
        )
      : step.parallel;
    this.resolveAbortSignal()?.throwIfAborted();
    const stepIteration = activeStepIteration ?? incrementStepIteration(state, step.name);
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
      interactive: this.deps.getInteractive(),
    };

    // Create semaphore for concurrency control (if configured)
    const semaphore = step.concurrency != null
      ? new Semaphore(step.concurrency)
      : undefined;
    if (semaphore) {
      log.debug('Concurrency limit enabled', { step: step.name, concurrency: step.concurrency });
    }
    const agentSubSteps = subSteps.filter(isAgentParallelSubStep);
    const configuredProviderInfoByStep = new Map(agentSubSteps.map((subStep) => {
      const providerInfo = this.deps.optionsBuilder.resolveStepProviderModelBeforeAutoRouting(subStep, runtime);
      validateProviderModelRequirements(providerInfo.provider, providerInfo.model, {
        modelFieldName: `Configuration error: parallel sub-step "${subStep.name}" model`,
      });
      return [subStep.name, providerInfo];
    }));
    const autoRouting = this.deps.engineOptions.autoRouting;
    const routingDeadline = autoRouting === undefined
      ? undefined
      : executionDeadlineContext?.begin(`parallel:auto-routing:${step.name}`, {
          provider: autoRouting.router.provider,
          providerOptions: autoRouting.router.providerOptions,
        });
    const routedProviderInfoByStep = autoRouting
      ? await runWithExecutionDeadline(executionDeadlineContext, routingDeadline, () => resolveAutoRoutingBatch({
          autoRouting,
          concurrency: step.concurrency,
          items: agentSubSteps.map((subStep) => ({
            id: subStep.name,
            scope: createRoutingScope({
              workflow: this.deps.getWorkflowName(),
              parentStep: step.name,
              workItem: subStep.name,
            }),
            step: {
              name: subStep.name,
              tags: subStep.tags,
              personaKey: subStep.providerRoutingPersonaKey,
              instruction: subStep.instruction,
            },
            snapshot: buildRoutingWorkSnapshot({
              goal: task,
              userInputs: state.userInputs,
              retryNote: this.deps.engineOptions.retryNote,
              step: {
                name: subStep.name,
                tags: subStep.tags ?? [],
                personaKey: subStep.providerRoutingPersonaKey,
                instruction: subStep.instruction,
                stepType: 'parallel',
                edit: subStep.edit,
                passPreviousResponse: subStep.passPreviousResponse === true,
              },
              lastOutput: runtime?.fallback === undefined
                ? state.lastOutput?.content
                : undefined,
              sensitiveValues: this.deps.engineOptions.routingSensitiveValues,
            }),
            currentProviderInfo: configuredProviderInfoByStep.get(subStep.name)!,
          })),
          estimator: this.deps.engineOptions.autoRoutingEstimator,
          runtime: this.deps.engineOptions.routingRuntime,
          logger: log,
          abortSignal: this.resolveAbortSignal(),
          ...this.deps.optionsBuilder.buildDeadlineActivityCallbacks(
            `parallel:auto-routing:${step.name}`,
            routingDeadline?.recordActivity,
          ),
        }))
      : new Map();
    const workflowCallResumeStack = subSteps.some(isWorkflowCallStep)
      ? this.requireWorkflowCallResumeStack(step, stepIteration)
      : undefined;
    const providerInfoByStep = new Map(agentSubSteps.map((subStep) => {
      const routedProviderInfo = routedProviderInfoByStep.get(subStep.name);
      const subRuntime = routedProviderInfo === undefined
        ? runtime
        : { ...runtime, providerInfo: routedProviderInfo };
      const providerInfo = routedProviderInfo === undefined
        ? (runtime
          ? this.deps.optionsBuilder.resolveStepProviderModel(subStep, runtime)
          : this.deps.optionsBuilder.resolveStepProviderModel(subStep))
        : this.deps.optionsBuilder.resolveStepProviderModel(subStep, subRuntime);
      validateProviderModelRequirements(providerInfo.provider, providerInfo.model, {
        modelFieldName: `Configuration error: parallel sub-step "${subStep.name}" model`,
      });
      return [subStep.name, providerInfo];
    }));

    const subStepDeadlineByName = new Map<string, WorkflowStepInactivityDeadline>();
    const getSubStepDeadline = (subStep: WorkflowStep): WorkflowStepInactivityDeadline | undefined => {
      if (executionDeadlineContext === undefined) {
        return undefined;
      }
      const existing = subStepDeadlineByName.get(subStep.name);
      if (existing !== undefined) {
        return existing;
      }
      const providerInfo = providerInfoByStep.get(subStep.name);
      if (providerInfo === undefined) {
        throw new Error(`Provider preflight result is missing for parallel sub-step "${subStep.name}"`);
      }
      const deadline = executionDeadlineContext.begin(`parallel:${subStep.name}`, providerInfo);
      subStepDeadlineByName.set(subStep.name, deadline);
      return deadline;
    };

    const subStepStartedAtByName = new Map<string, number>();
    const subStepInstructionByName = new Map<string, string>();
    const dynamicFacetIdentityPath = this.deps.getCurrentWorkflowStack?.() ?? [];
    const preparationResults = await Promise.allSettled(
      agentSubSteps.map(async (subStep) => {
        if (semaphore) {
          await semaphore.acquire();
        }
        try {
          const subStepDeadline = getSubStepDeadline(subStep);
          return await runWithExecutionDeadline(
            executionDeadlineContext,
            subStepDeadline,
            async () => {
              const subIteration = incrementStepIteration(
                state,
                buildScopedStepIterationIdentity(subStep.name, [step.name]),
              );
              const executableSubStep = await this.deps.stepExecutor.prepareDynamicFacetStep(
                subStep,
                state,
                task,
                subIteration,
                { identityPath: dynamicFacetIdentityPath },
              );
              return [subStep.name, { executableSubStep, subIteration }] as const;
            },
          );
        } finally {
          if (semaphore) {
            semaphore.release();
          }
        }
      }),
    );
    const preparationFailure = preparationResults.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (preparationFailure !== undefined) {
      throw preparationFailure.reason;
    }
    const preparedAgentSubSteps = new Map(preparationResults.map((result) => {
      if (result.status !== 'fulfilled') {
        throw result.reason;
      }
      return result.value;
    }));

    // Run all sub-steps concurrently only after every dynamic facet selector succeeds.
    // When semaphore is set, at most `concurrency` sub-steps execute simultaneously.
    const settled = await Promise.allSettled(
      subSteps.map(async (subStep, index) => {
        if (semaphore) {
          await semaphore.acquire();
        }
        const startedAt = Date.now();
        subStepStartedAtByName.set(subStep.name, startedAt);
        const subStepDeadline = isAgentParallelSubStep(subStep)
          ? getSubStepDeadline(subStep)
          : undefined;
        try {
          return await runWithExecutionDeadline(
            executionDeadlineContext,
            subStepDeadline,
            async () => {
          if (isWorkflowCallStep(subStep)) {
            if (workflowCallResumeStack === undefined) {
              throw new Error(
                `Parallel workflow_call sub-step "${subStep.name}" has no parent resume stack`,
              );
            }
            subStepInstructionByName.set(subStep.name, '');
            return await this.runWorkflowCallSubStep(
              subStep,
              state,
              runtime,
              startedAt,
              workflowCallResumeStack,
            );
          }
          if (!isAgentParallelSubStep(subStep)) {
            throw new Error(`Unsupported parallel sub-step kind for "${subStep.name}"`);
          }

          const routedRuntime = routedProviderInfoByStep.has(subStep.name)
            ? {
                ...runtime,
                providerInfo: routedProviderInfoByStep.get(subStep.name)!,
              }
            : runtime;
          const subRuntime = runtimeForOperation(
            routedRuntime,
            reviewerOperationOrigin(subStep.name),
            routedRuntime?.providerInfo,
          );
          const preparedSubStep = preparedAgentSubSteps.get(subStep.name);
          if (preparedSubStep === undefined) {
            throw new Error(`Prepared parallel sub-step is missing for "${subStep.name}"`);
          }
          const { executableSubStep, subIteration } = preparedSubStep;
          const subInstruction = this.deps.stepExecutor.buildInstruction(
            executableSubStep,
            subIteration,
            state,
            task,
            maxSteps,
            fallbackContextForOperation(
              subRuntime,
              reviewerOperationOrigin(subStep.name),
            ),
          );
          const phase1Instruction = subInstruction;
          subStepInstructionByName.set(subStep.name, phase1Instruction);
          const parentIteration = state.iteration;
          const subPm = providerInfoByStep.get(subStep.name);
          if (subPm === undefined) {
            throw new Error(`Provider preflight result is missing for parallel sub-step "${subStep.name}"`);
          }
          const subRuleCtx = {
            state,
            interactive: this.deps.getInteractive(),
          };

        // Session key uses the same resolved provider as Phase 1 options and resume phases.
        const subSessionKey = buildSessionKey(executableSubStep, {
          provider: subPm.provider,
          model: subPm.model,
        });

        // Phase 1: main execution (Write excluded if sub-step has report)
        const baseOptions = this.deps.optionsBuilder.buildAgentOptions(executableSubStep, subRuntime);
        const compactionOutcome = await compactSessionBeforePhase1(executableSubStep, baseOptions);
        if (compactionOutcome === 'fresh') {
          invalidatePersonaSessionIfExpected(
            state,
            subSessionKey,
            baseOptions.sessionId,
            updatePersonaSession,
          );
        }
        // Preserve provider activity/logging while replacing only the display callback.
        const agentOptions: RunAgentOptions = parallelLogger
          ? {
              ...baseOptions,
              ...(compactionOutcome === 'fresh' ? { sessionId: undefined } : {}),
              onStream: this.deps.optionsBuilder.buildProviderStream(
                executableSubStep,
                subPm.provider,
                subPm.model,
                parallelLogger.createStreamHandler(subStep.name, index),
              ),
            }
          : {
              ...baseOptions,
              ...(compactionOutcome === 'fresh' ? { sessionId: undefined } : {}),
            };
        const promptResolvedAttempts = new Set<number>();
        const phase1Result = await runPhase1WithEmptyRecovery({
          instruction: phase1Instruction,
          initialSessionId: agentOptions.sessionId,
          retryProviderErrorFresh: compactionOutcome !== 'fresh',
          execute: async (attempt) => {
            const result = await executeObservedPhase1Attempt({
              enabled: this.deps.observabilityEnabled,
              runId: this.deps.observabilityRunId,
              workflowName: this.deps.getWorkflowName(),
              eventStep: subStep,
              spanStep: executableSubStep,
              iteration: parentIteration,
              attempt,
              workflowStack: this.deps.getCurrentWorkflowStack?.(),
              sanitizeText: this.deps.sanitizeObservabilityText,
              providerInfo: subPm,
              execute: (attemptInstruction, sessionId, onPromptResolved) => (
                this.executeSubStepAgent(
                  executableSubStep,
                  subPm,
                  attemptInstruction,
                  {
                    ...agentOptions,
                    sessionId,
                    onPromptResolved,
                  },
                  executableSubStep.completionRetry === undefined,
                )
              ),
              onPhaseStart: this.deps.onPhaseStart,
              ...(executableSubStep.completionRetry === undefined
                ? {}
                : {
                    onPhaseComplete: this.deps.onPhaseComplete,
                    failurePersona: executableSubStep.persona ?? executableSubStep.name,
                    recordFailure: () => recordAgentUsageEvent(
                      this.deps.engineOptions,
                      subStep.name,
                      'parallel',
                      subPm,
                      false,
                      undefined,
                    ),
                  }),
            });
            if (result.promptResolved) {
              promptResolvedAttempts.add(attempt.sequence);
            }
            return result.response;
          },
          discardSession: (sessionId) => {
            invalidatePersonaSessionIfExpected(
              state,
              subSessionKey,
              sessionId,
              updatePersonaSession,
            );
          },
          recordSupersededAttempt: (supersededResponse, attempt) => {
            if (promptResolvedAttempts.has(attempt.sequence)) {
              completeObservedPhase1Attempt({
                eventStep: subStep,
                iteration: parentIteration,
                attempt,
                response: supersededResponse,
                onPhaseComplete: this.deps.onPhaseComplete,
              });
            }
            if (executableSubStep.completionRetry !== undefined) {
              recordAgentUsageEvent(
                this.deps.engineOptions,
                subStep.name,
                'parallel',
                subPm,
                supersededResponse.status === 'done',
                supersededResponse.providerUsage,
              );
            }
          },
        });
        let subResponse = phase1Result.response;
        if (!promptResolvedAttempts.has(phase1Result.finalAttempt.sequence)) {
          throw new Error(`Missing prompt parts for phase start: ${subStep.name}:1`);
        }
        if (subResponse.error === PHASE1_EMPTY_OUTPUT_ERROR) {
          log.info('Phase 1 returned empty output for parallel sub-step, treating as error', {
            step: subStep.name,
          });
        }
        if (subResponse.sessionId !== undefined) {
          updatePersonaSession(subSessionKey, subResponse.sessionId);
        }
        if (executableSubStep.completionRetry !== undefined) {
          subResponse = this.deps.stepExecutor.finalizeObservedReviewerAttempt({
            eventStep: subStep,
            executableStep: executableSubStep,
            iteration: parentIteration,
            attempt: phase1Result.finalAttempt,
            response: subResponse,
            runtime: subRuntime,
            recordUsage: (success, usage) => recordAgentUsageEvent(
              this.deps.engineOptions,
              subStep.name,
              'parallel',
              subPm,
              success,
              usage,
            ),
          });
        } else {
          completeObservedPhase1Attempt({
            eventStep: subStep,
            iteration: parentIteration,
            attempt: phase1Result.finalAttempt,
            response: subResponse,
            onPhaseComplete: this.deps.onPhaseComplete,
          });
        }
        if (subResponse.status === 'error' || subResponse.status === 'blocked' || subResponse.status === 'rate_limited') {
          state.stepOutputs.set(subStep.name, subResponse);
          return {
            subStep,
            response: subResponse,
            instruction: phase1Instruction,
            providerInfo: subPm,
            ...(subResponse.status === 'blocked' || subResponse.status === 'rate_limited'
              ? {
                  terminalOperation: {
                    origin: reviewerOperationOrigin(subStep.name),
                    providerInfo: subPm,
                  },
                }
              : {}),
            durationMs: Math.max(0, subResponse.timestamp.getTime() - startedAt),
          };
        }

        let completionRetryDiagnostic: string | undefined;
        if (executableSubStep.completionRetry !== undefined) {
          let reviewerPhaseExecutionSequence = phase1Result.finalAttempt.sequence + 1;
          const completion = await this.deps.stepExecutor.completeReviewerResponse({
            step: executableSubStep,
            originalInstruction: phase1Instruction,
            initialResponse: subResponse,
            executeRetry: async (instruction, sessionId) => {
              const observedAttempts = new Map<number, typeof phase1Result.finalAttempt>();
              const resolveObservedAttempt = (attempt: typeof phase1Result.finalAttempt) => {
                const existing = observedAttempts.get(attempt.sequence);
                if (existing !== undefined) return existing;
                const created = { ...attempt, sequence: reviewerPhaseExecutionSequence++ };
                observedAttempts.set(attempt.sequence, created);
                return created;
              };
              const retry = await runPhase1WithEmptyRecovery({
                instruction,
                initialSessionId: sessionId,
                retryProviderErrorFresh: false,
                execute: async (attempt) => {
                  const observedAttempt = resolveObservedAttempt(attempt);
                  const observed = await executeObservedPhase1Attempt({
                    enabled: this.deps.observabilityEnabled,
                    runId: this.deps.observabilityRunId,
                    workflowName: this.deps.getWorkflowName(),
                    eventStep: subStep,
                    spanStep: executableSubStep,
                    iteration: parentIteration,
                    attempt: observedAttempt,
                    workflowStack: this.deps.getCurrentWorkflowStack?.(),
                    sanitizeText: this.deps.sanitizeObservabilityText,
                    providerInfo: subPm,
                    execute: (attemptInstruction, attemptSessionId, onPromptResolved) => (
                      this.executeSubStepAgent(
                        executableSubStep,
                        subPm,
                        attemptInstruction,
                        { ...agentOptions, sessionId: attemptSessionId, onPromptResolved },
                        false,
                      )
                    ),
                    onPhaseStart: this.deps.onPhaseStart,
                    onPhaseComplete: this.deps.onPhaseComplete,
                    failurePersona: executableSubStep.persona ?? executableSubStep.name,
                    recordFailure: () => recordAgentUsageEvent(
                      this.deps.engineOptions,
                      subStep.name,
                      'parallel',
                      subPm,
                      false,
                      undefined,
                    ),
                  });
                  return observed.response;
                },
                discardSession: () => undefined,
                recordSupersededAttempt: (response, attempt) => {
                  const observedAttempt = resolveObservedAttempt(attempt);
                  completeObservedPhase1Attempt({
                    eventStep: subStep,
                    iteration: parentIteration,
                    attempt: observedAttempt,
                    response,
                    onPhaseComplete: this.deps.onPhaseComplete,
                  });
                  recordAgentUsageEvent(
                    this.deps.engineOptions,
                    subStep.name,
                    'parallel',
                    subPm,
                    response.status === 'done',
                    response.providerUsage,
                  );
                },
              });
              return this.deps.stepExecutor.finalizeObservedReviewerAttempt({
                eventStep: subStep,
                executableStep: executableSubStep,
                iteration: parentIteration,
                attempt: resolveObservedAttempt(retry.finalAttempt),
                response: retry.response,
                runtime: subRuntime,
                recordUsage: (success, usage) => recordAgentUsageEvent(
                  this.deps.engineOptions,
                  subStep.name,
                  'parallel',
                  subPm,
                  success,
                  usage,
                ),
              });
            },
          });
          subResponse = completion.response;
          updatePersonaSession(subSessionKey, completion.reviewerSessionId);
          completionRetryDiagnostic = completion.diagnostic === undefined
            ? undefined
            : formatCompletionRetryDiagnostic(
                completion.diagnostic,
                this.deps.engineOptions.language,
              );
          if (subResponse.status === 'error' || subResponse.status === 'blocked' || subResponse.status === 'rate_limited') {
            state.stepOutputs.set(subStep.name, subResponse);
            return {
              subStep,
              response: subResponse,
              instruction: phase1Instruction,
              providerInfo: subPm,
              durationMs: Math.max(0, subResponse.timestamp.getTime() - startedAt),
            };
          }
        }

        let finalResponse = subResponse;
        const basePhaseContext = this.deps.optionsBuilder.buildPhaseRunnerContext(
            subStep,
            state,
            subResponse.content,
            updatePersonaSession,
            this.deps.onPhaseStart,
            this.deps.onPhaseComplete,
            this.deps.onJudgeStage,
            parentIteration,
            subRuntime,
            (
              providerInfo: NonNullable<StepRunResult['providerInfo']>,
              success: boolean,
              usage: AgentResponse['providerUsage'],
            ): void => {
              recordAgentUsageEvent(
                this.deps.engineOptions,
                subStep.name,
                'parallel',
                providerInfo,
                success,
                usage,
              );
            },
          );
          const phaseCtx = completionRetryDiagnostic === undefined
            ? basePhaseContext
            : { ...basePhaseContext, completionRetryDiagnostic };
          if (subStep.outputContracts && subStep.outputContracts.length > 0) {
            try {
              const reportResult = await runReportPhase(subStep, subIteration, phaseCtx);
              if (reportResult && 'blocked' in reportResult) {
                const blockedResponse: AgentResponse = {
                  ...subResponse,
                  status: 'blocked',
                  content: reportResult.response.content,
                };
                state.stepOutputs.set(subStep.name, blockedResponse);
                return {
                  subStep,
                  response: blockedResponse,
                  instruction: phase1Instruction,
                  providerInfo: subPm,
                  terminalOperation: {
                    origin: reviewerOperationOrigin(subStep.name),
                    providerInfo: reportResult.providerInfo,
                  },
                  durationMs: Math.max(
                    0,
                    blockedResponse.timestamp.getTime() - startedAt,
                  ),
                };
              }
              if (reportResult && 'rateLimited' in reportResult) {
                const rateLimitedResponse: AgentResponse = {
                  ...reportResult.response,
                  persona: subStep.name,
                };
                state.stepOutputs.set(subStep.name, rateLimitedResponse);
                return {
                  subStep,
                  response: rateLimitedResponse,
                  instruction: phase1Instruction,
                  providerInfo: subPm,
                  terminalOperation: {
                    origin: reviewerOperationOrigin(subStep.name),
                    providerInfo: reportResult.providerInfo,
                  },
                  durationMs: Math.max(
                    0,
                    rateLimitedResponse.timestamp.getTime() - startedAt,
                  ),
                };
              }
            } catch (reportError) {
              if (reportError instanceof ReportPhaseGenerationError) {
                if (reportError.failureCategory === AGENT_FAILURE_CATEGORIES.PROVIDER_STREAM_PARSE_ERROR) {
                  throw createProviderStreamParseError(reportError.failureMessage ?? getErrorMessage(reportError));
                }
                log.info(
                  'Report phase failed for parallel sub-step, continuing to status judgment',
                  {
                    step: subStep.name,
                    error: getErrorMessage(reportError),
                  },
                );
              } else {
                throw reportError;
              }
            }
          }
          let match;
          let commandGates: 'required' | 'skip' = 'required';
          try {
            match = await evaluatePostExecutionRules(
              subStep,
              () => phaseCtx,
              subRuleCtx,
            );
            if (match !== undefined && subStep.rules !== undefined && subStep.rules.length > 0) {
              const transition = determineRuleTransition(subStep, match.index);
              if (transition === null) {
                throw new RuleDetectionExhaustedError(subStep.name);
              }
              commandGates = transition.commandGates;
            }
          } catch (error) {
            if (error instanceof RuleDetectionExhaustedError) {
              invalidateExpectedPersonaSession(
                state,
                subSessionKey,
                subResponse,
                baseOptions.sessionId,
                updatePersonaSession,
              );
            }
            throw error;
          }
        finalResponse = match
          ? {
              ...subResponse,
              matchedRuleIndex: match.index,
              matchedRuleMethod: match.method,
            }
          : subResponse;

        if (commandGates === 'required') {
          const qualityGateResult = await this.deps.runQualityGates({
            qualityGates: subStep.qualityGates,
            projectRoot: this.deps.getCwd(),
            step: subStep,
            childProcessEnv: this.deps.engineOptions.childProcessEnv,
            observabilityEnabled: this.deps.observabilityEnabled,
            runId: this.deps.observabilityRunId,
            workflowName: this.deps.getWorkflowName(),
          });
          if (!qualityGateResult.ok) {
            state.stepOutputs.set(subStep.name, qualityGateResult.response);
            return {
              subStep,
              response: qualityGateResult.response,
              instruction: phase1Instruction,
              providerInfo: subPm,
              durationMs: Math.max(0, qualityGateResult.response.timestamp.getTime() - startedAt),
              qualityGateFailure: true,
            };
          }
        }

        state.stepOutputs.set(subStep.name, finalResponse);
        this.deps.stepExecutor.emitStepReports(
          subStep,
          {
            iteration: parentIteration,
            resumeStepName: step.name,
            stepIteration: subIteration,
            providerInfo: subPm,
          },
        );

        return {
          subStep,
          response: finalResponse,
          instruction: phase1Instruction,
          providerInfo: subPm,
          durationMs: Math.max(0, finalResponse.timestamp.getTime() - startedAt),
        };
            },
          );
        } finally {
          if (semaphore) {
            semaphore.release();
          }
        }
      }),
    );

    // Map settled results: fulfilled → as-is, rejected → error AgentResponse
    const subResults: ParallelSubStepResult[] = settled.map((result, index) => {
      if (result.status === 'fulfilled') {
        return result.value;
      }
      const failedStep = subSteps[index]!;
      const errorMsg = getErrorMessage(result.reason);
      log.error('Sub-step failed', { step: failedStep.name, error: sanitizeSensitiveText(errorMsg) });
      const errorResponse: AgentResponse = {
        persona: failedStep.name,
        status: 'error',
        content: '',
        timestamp: new Date(),
        error: errorMsg,
        ...(isProviderStreamParseError(result.reason)
          ? { failureCategory: result.reason.failureCategory }
          : {}),
      };
      state.stepOutputs.set(failedStep.name, errorResponse);
      const startedAt = subStepStartedAtByName.get(failedStep.name);
      const instruction = subStepInstructionByName.get(failedStep.name);
      const childExecutionState = getWorkflowCallChildExecutionState(result.reason);
      return {
        subStep: failedStep,
        response: errorResponse,
        instruction: instruction === undefined ? '' : instruction,
        providerInfo: routedProviderInfoByStep.get(failedStep.name),
        executionRejected: true,
        durationMs: startedAt === undefined
          ? 0
          : Math.max(0, errorResponse.timestamp.getTime() - startedAt),
        ...(childExecutionState !== undefined
          ? {
              workflowCallSessionUpdates: childExecutionState.sessionUpdates,
              workflowCallStateSync: childExecutionState.stateSync,
            }
          : isWorkflowCallStep(failedStep)
            ? { workflowCallExecutionRejected: true }
            : {}),
      };
    });
    this.mergeWorkflowCallSubStepEffects(step, subResults, state, updatePersonaSession);
    this.recordSubStepRoutingResults(step, subResults);
    this.emitSubStepRoutingDecisionEvents(subResults, state.iteration);

    const ruleDetectionFailure = settled.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
        && (
          result.reason instanceof RuleDetectionExhaustedError
          || getWorkflowCallChildExecutionState(result.reason)?.originalError
            instanceof RuleDetectionExhaustedError
        ),
    );
    if (ruleDetectionFailure) {
      const childExecutionState = getWorkflowCallChildExecutionState(ruleDetectionFailure.reason);
      throw childExecutionState?.originalError ?? ruleDetectionFailure.reason;
    }

    const terminalResults = this.collectTerminalResults(subResults);
    const parseFailureResult = terminalResults.find(
      (result) => result.response.failureCategory
        === AGENT_FAILURE_CATEGORIES.PROVIDER_STREAM_PARSE_ERROR,
    );
    const rateLimitedResult = terminalResults.find((r) => r.response.status === 'rate_limited');
    if (parseFailureResult !== undefined || rateLimitedResult !== undefined) {
      this.explicitErrorAttemptsByStep.delete(step.name);
    }
    if (parseFailureResult) {
      return this.createTerminalParentResult({
        step,
        state,
        stepIteration,
        subResults,
        terminalResults,
        status: 'error',
        providerInfo: parseFailureResult.providerInfo ?? parentPm,
        primaryFailure: parseFailureResult,
      });
    }
    if (rateLimitedResult) {
      return this.createTerminalParentResult({
        step,
        state,
        stepIteration,
        subResults,
        terminalResults,
        status: 'rate_limited',
        providerInfo: rateLimitedResult.providerInfo ?? parentPm,
        primaryFailure: rateLimitedResult,
      });
    }

    const errorResults = terminalResults.filter((r) => r.response.status === 'error');
    const hasExplicitErrorRule = this.hasExplicitErrorAggregateRule(step);
    if (errorResults.length === 0) {
      this.explicitErrorAttemptsByStep.delete(step.name);
    } else if (!hasExplicitErrorRule) {
      this.explicitErrorAttemptsByStep.delete(step.name);
      const primaryFailure = this.firstFailureResult(errorResults);
      if (primaryFailure === undefined) {
        throw new Error(`Parallel step "${step.name}" has no primary error result`);
      }
      return this.createTerminalParentResult({
        step,
        state,
        stepIteration,
        subResults,
        terminalResults,
        status: 'error',
        providerInfo: primaryFailure.providerInfo ?? parentPm,
        primaryFailure,
      });
    } else {
      const attempts = (this.explicitErrorAttemptsByStep.get(step.name) ?? 0) + 1;
      this.explicitErrorAttemptsByStep.set(step.name, attempts);
      if (attempts > MAX_EXPLICIT_PARALLEL_ERROR_RETRIES) {
        const primaryFailure = this.firstFailureResult(errorResults);
        if (primaryFailure === undefined) {
          throw new Error(`Parallel step "${step.name}" has no primary error result`);
        }
        const reason = `Parallel step "${step.name}" exceeded its explicit error retry limit (${MAX_EXPLICIT_PARALLEL_ERROR_RETRIES})`;
        return this.createTerminalParentResult({
          step,
          state,
          stepIteration,
          subResults,
          terminalResults: errorResults,
          status: 'error',
          providerInfo: primaryFailure.providerInfo ?? parentPm,
          primaryFailure,
          failure: createRunFailure({
            kind: 'step_error',
            step: step.name,
            reason,
            error: reason,
            ...(primaryFailure.response.failureCategory === undefined
              ? {}
              : { failureCategory: primaryFailure.response.failureCategory }),
          }),
        });
      }
    }

    const blockedResults = terminalResults.filter((r) => r.response.status === 'blocked');
    if (blockedResults.length > 0) {
      const primaryFailure = blockedResults[0];
      if (primaryFailure === undefined) {
        throw new Error(`Parallel step "${step.name}" has no primary blocked result`);
      }
      return this.createTerminalParentResult({
        step,
        state,
        stepIteration,
        subResults,
        terminalResults: blockedResults,
        status: 'blocked',
        providerInfo: primaryFailure.providerInfo ?? parentPm,
        primaryFailure,
      });
    }

    const qualityGateFailure = subResults.find((r) => (
      'qualityGateFailure' in r && r.qualityGateFailure === true
    ));
    const retryCount = sumRetryCounts(subResults.map((result) => result.response));
    if (qualityGateFailure) {
      const failureResponse: AgentResponse = {
        persona: step.name,
        status: 'done',
        content: [
          `Parallel sub-step quality gate failed: ${qualityGateFailure.subStep.name}`,
          '',
          qualityGateFailure.response.content,
        ].join('\n'),
        timestamp: new Date(),
        ...(retryCount === undefined ? {} : { retryCount }),
      };
      return {
        response: failureResponse,
        instruction: qualityGateFailure.instruction,
        providerInfo: qualityGateFailure.providerInfo ?? parentPm,
        qualityGateFailure: {
          response: failureResponse,
          stepIteration,
        },
      };
    }

    // Print completion summary
    if (parallelLogger) {
      parallelLogger.printSummary(
        step.name,
        subResults.map((r) => ({
          name: r.subStep.name,
          condition: r.response.matchedRuleIndex != null && r.subStep.rules
            ? r.subStep.rules[r.response.matchedRuleIndex] === undefined
              ? undefined
              : formatWorkflowRuleCondition(r.subStep.rules[r.response.matchedRuleIndex]!.condition)
            : undefined,
        })),
      );
    }

    // Aggregate sub-step outputs into the parent step response
    const aggregatedContent = subResults
      .map((r) => `## ${r.subStep.name}\n${r.response.status === 'error'
        ? this.buildSubStepErrorDiagnostic(r)
        : r.response.content}`)
      .join('\n\n---\n\n');

    const aggregatedInstruction = subResults
      .map((r) => r.instruction)
      .join('\n\n');

    const match = await evaluatePostExecutionRules(
      step,
      () => this.deps.optionsBuilder.buildPhaseRunnerContext(
        step,
        state,
        aggregatedContent,
        updatePersonaSession,
        this.deps.onPhaseStart,
        this.deps.onPhaseComplete,
        this.deps.onJudgeStage,
        state.iteration,
        runtime,
      ),
      parentRuleCtx,
    );

    const aggregatedResponse: AgentResponse = {
      persona: step.name,
      status: 'done',
      content: aggregatedContent,
      timestamp: new Date(),
      ...(match && { matchedRuleIndex: match.index, matchedRuleMethod: match.method }),
      ...(retryCount === undefined ? {} : { retryCount }),
    };

    state.stepOutputs.set(step.name, aggregatedResponse);
    state.lastOutput = aggregatedResponse;
    this.deps.stepExecutor.persistPreviousResponseSnapshot(
      state,
      step.name,
      stepIteration,
      aggregatedResponse.content,
    );
    this.deps.stepExecutor.emitStepReports(
      step,
      {
        iteration: state.iteration,
        resumeStepName: step.name,
        stepIteration,
        providerInfo: parentPm,
      },
    );
    const selectedFailure = this.selectFailureByDefinitionOrder(subResults);
    return {
      response: aggregatedResponse,
      instruction: aggregatedInstruction,
      providerInfo: parentPm,
      ...(selectedFailure === undefined ? {} : { workflowCallFailure: selectedFailure }),
    };
  }

  private async runWorkflowCallSubStep(
    subStep: WorkflowStep,
    state: WorkflowState,
    runtime: RuntimeStepResolution | undefined,
    startedAt: number,
    resumeStackPrefix: readonly WorkflowResumePointEntry[],
  ): Promise<ParallelSubStepResult> {
    if (!isWorkflowCallStep(subStep)) {
      throw new Error(`Parallel sub-step "${subStep.name}" is not a workflow_call`);
    }

    const occurrence = this.deps.claimStepOccurrence(subStep, resumeStackPrefix);
    const workflowCallRunner = this.deps.getWorkflowCallRunner?.();
    if (!workflowCallRunner) {
      throw new Error(`Parallel workflow_call sub-step "${subStep.name}" requires workflowCallRunner`);
    }
    const workflowCallExecution = workflowCallRunner.activateInvocation(
      subStep,
      state.iteration,
      occurrence,
      resumeStackPrefix,
    );
    try {
      const operationRuntime = runtimeForOperation(
        runtime,
        reviewerOperationOrigin(subStep.name),
      );
      const subRuntime = operationRuntime?.fallback
        ? operationRuntime
        : workflowCallRunner.resolveRuntime(subStep);
      const result = await workflowCallRunner.runIsolated(
        subStep,
        subRuntime,
        resumeStackPrefix,
        workflowCallExecution,
      );
      return {
        subStep,
        response: result.result.response,
        instruction: result.result.instruction,
        providerInfo: result.result.providerInfo,
        ...(result.result.terminalOperation !== undefined
          ? { terminalOperation: result.result.terminalOperation }
          : {}),
        ...(result.result.workflowCallFailure === undefined
          ? {}
          : { workflowCallFailure: result.result.workflowCallFailure }),
        durationMs: Math.max(0, result.result.response.timestamp.getTime() - startedAt),
        workflowCallSessionUpdates: result.sessionUpdates,
        workflowCallStateSync: result.stateSync,
      };
    } catch (error) {
      workflowCallExecution.fail(error);
      throw error;
    } finally {
      workflowCallExecution.cancel();
    }
  }

  private requireWorkflowCallResumeStack(
    step: WorkflowStep,
    occurrence: number,
  ): WorkflowResumePointEntry[] {
    const stack = this.deps.getCurrentWorkflowStack?.();
    const parentFrame = stack?.at(-1);
    if (
      stack === undefined
      || parentFrame === undefined
      || parentFrame.step !== step.name
      || parentFrame.kind !== getWorkflowResumeFrameKind(step)
      || parentFrame.occurrence !== occurrence
    ) {
      throw new Error(
        `Parallel workflow_call parent "${this.deps.getWorkflowName()}/${step.name}" has no active resume frame`,
      );
    }
    return [...stack];
  }

  private mergeWorkflowCallSubStepEffects(
    step: WorkflowStep,
    subResults: ParallelSubStepResult[],
    state: WorkflowState,
    updatePersonaSession: (persona: string, sessionId: string | undefined) => void,
  ): void {
    let didSyncWorkflowCallState = false;
    for (const result of subResults) {
      if (!isWorkflowCallStep(result.subStep)) {
        continue;
      }
      state.stepOutputs.set(result.subStep.name, result.response);
      if (result.workflowCallExecutionRejected) {
        continue;
      }
      if (!result.workflowCallSessionUpdates) {
        throw new Error(`Parallel workflow_call sub-step "${result.subStep.name}" did not return session updates`);
      }
      if (!result.workflowCallStateSync) {
        throw new Error(`Parallel workflow_call sub-step "${result.subStep.name}" did not return state sync`);
      }
      state.iteration = Math.max(state.iteration, result.workflowCallStateSync.iteration);
      if (result.workflowCallStateSync.maxSteps !== undefined) {
        this.deps.updateMaxSteps(result.workflowCallStateSync.maxSteps);
      }
      didSyncWorkflowCallState = true;
    }
    this.mergeWorkflowCallSessionUpdates(subResults, state, updatePersonaSession);
    if (didSyncWorkflowCallState) {
      const occurrence = state.stepIterations.get(step.name);
      if (occurrence === undefined) {
        throw new Error(`Parallel step "${step.name}" has no occurrence after child execution`);
      }
      this.deps.setActiveResumePoint(step, state.iteration, occurrence);
    }
  }

  private mergeWorkflowCallSessionUpdates(
    subResults: ParallelSubStepResult[],
    state: WorkflowState,
    updatePersonaSession: (persona: string, sessionId: string | undefined) => void,
  ): void {
    const updatesBySessionKey = new Map<string, Array<{ expectedSessionId: string | undefined; sessionId: string | undefined }>>();
    for (const result of subResults) {
      if (!result.workflowCallSessionUpdates || result.workflowCallExecutionRejected) {
        continue;
      }
      for (const [sessionKey, update] of result.workflowCallSessionUpdates) {
        const updates = updatesBySessionKey.get(sessionKey) ?? [];
        updates.push(update);
        updatesBySessionKey.set(sessionKey, updates);
      }
    }

    for (const [sessionKey, updates] of updatesBySessionKey) {
      const currentSessionId = state.personaSessions.get(sessionKey);
      const applicableUpdates = updates.filter((update) => update.expectedSessionId === currentSessionId);
      const finalUpdate = applicableUpdates.at(-1);
      if (finalUpdate !== undefined) {
        updatePersonaSession(sessionKey, finalUpdate.sessionId);
      }
    }
  }

  private emitSubStepRoutingDecisionEvents(subResults: ParallelSubStepResult[], iteration: number): void {
    for (const result of subResults) {
      const providerInfo = result.providerInfo;
      if (providerInfo?.autoRoutingDecision === undefined) {
        continue;
      }
      this.deps.emitEvent(
        'routing:decision',
        result.subStep,
        result.response,
        result.instruction,
        providerInfo,
        'parallel',
        result.durationMs ?? 0,
        iteration,
        this.deps.getWorkflowName(),
      );
    }
  }

  private recordSubStepRoutingResults(step: WorkflowStep, subResults: ParallelSubStepResult[]): void {
    const routingRuntime = this.deps.engineOptions.routingRuntime;
    if (routingRuntime === undefined) {
      return;
    }
    for (const result of subResults) {
      const scope = createRoutingScope({
        workflow: this.deps.getWorkflowName(),
        parentStep: step.name,
        workItem: result.subStep.name,
      });
      if (
        result.providerInfo?.autoRoutingDecision === undefined
        || !routingRuntime.hasResolution(scope)
      ) {
        continue;
      }
      routingRuntime.recordExecutionResult({
        scope,
        status: result.response.status === 'done' ? 'done' : 'failed',
      });
    }
  }

  private async executeSubStepAgent(
    subStep: AgentWorkflowStep,
    providerInfo: NonNullable<StepRunResult['providerInfo']>,
    instruction: string,
    options: RunAgentOptions,
    recordUsage = true,
  ): Promise<AgentResponse> {
    let response: AgentResponse;
    try {
      response = await executeAgent(subStep.persona, instruction, options);
    } catch (error) {
      if (recordUsage) recordAgentUsageEvent(
        this.deps.engineOptions,
        subStep.name,
        'parallel',
        providerInfo,
        false,
        undefined,
      );
      throw error;
    }
    if (recordUsage) recordAgentUsageEvent(
      this.deps.engineOptions,
      subStep.name,
      'parallel',
      providerInfo,
      response.status === 'done',
      response.providerUsage,
    );
    return response;
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

  private createTerminalParentResult(options: {
    step: WorkflowStep;
    state: WorkflowState;
    stepIteration: number;
    subResults: ParallelSubStepResult[];
    terminalResults: ParallelSubStepResult[];
    status: ParallelTerminalStatus;
    providerInfo: StepRunResult['providerInfo'];
    primaryFailure: ParallelSubStepResult;
    failure?: StepRunResult['workflowCallFailure'];
  }): StepRunResult {
    const content = this.buildTerminalDiagnostic(
      options.step,
      options.terminalResults,
      options.status,
    );
    const primaryFailure = options.primaryFailure;
    const failureCategory = primaryFailure.response.failureCategory;
    const boundedContent = truncateUtf8PreservingMarker(content, MAX_AGENT_FAILURE_MESSAGE_BYTES);
    const failureError = truncateUtf8PreservingMarker(
      sanitizeSensitiveText(
        options.failure?.error
          ?? primaryFailure.response.error
          ?? primaryFailure.response.content,
      ),
      MAX_AGENT_FAILURE_MESSAGE_BYTES,
    );
    const retryCount = sumRetryCounts(options.subResults.map((result) => result.response));
    const response: AgentResponse = {
      persona: options.step.name,
      status: options.status,
      content: boundedContent,
      timestamp: new Date(),
      ...(options.status === 'error' || options.status === 'rate_limited'
        ? { error: failureError || boundedContent }
        : {}),
      ...(failureCategory && { failureCategory }),
      ...(retryCount === undefined ? {} : { retryCount }),
      ...(options.status === 'rate_limited'
        ? {
            ...(primaryFailure.response.errorKind === undefined
              ? {}
              : { errorKind: primaryFailure.response.errorKind }),
            ...(primaryFailure.response.rateLimitInfo === undefined
              ? {}
              : { rateLimitInfo: primaryFailure.response.rateLimitInfo }),
          }
        : {}),
    };

    options.state.stepOutputs.set(options.step.name, response);
    options.state.lastOutput = response;
    if (options.status === 'blocked') {
      this.deps.stepExecutor.persistPreviousResponseSnapshot(
        options.state,
        options.step.name,
        options.stepIteration,
        response.content,
      );
    }

    const selectedFailure = options.failure ?? this.toRunFailure(primaryFailure);
    return {
      response,
      instruction: options.subResults.map((result) => result.instruction).join('\n\n'),
      providerInfo: options.providerInfo,
      ...(selectedFailure === undefined ? {} : { workflowCallFailure: selectedFailure }),
      ...(primaryFailure.terminalOperation !== undefined
        ? { terminalOperation: primaryFailure.terminalOperation }
        : {}),
      consumedStepIterations: [
        options.step.name,
        ...options.subResults.map((result) => (
          buildScopedStepIterationIdentity(
            result.subStep.name,
            [options.step.name],
          )
        )),
      ],
    };
  }

  private selectFailureByDefinitionOrder(
    results: ParallelSubStepResult[],
  ): StepRunResult['workflowCallFailure'] {
    for (const result of results) {
      const failure = this.toRunFailure(result);
      if (failure !== undefined) {
        return failure;
      }
    }
    return undefined;
  }

  private toRunFailure(
    result: ParallelSubStepResult,
  ): StepRunResult['workflowCallFailure'] {
    if (result.workflowCallFailure !== undefined) {
      return result.workflowCallFailure;
    }
    if (result.response.status !== 'error') {
      return undefined;
    }
    const failureError = truncateUtf8PreservingMarker(
      sanitizeSensitiveText(result.response.error ?? result.response.content),
      MAX_AGENT_FAILURE_MESSAGE_BYTES,
    );
    return createRunFailure({
      kind: 'step_error',
      step: result.subStep.name,
      reason: failureError,
      error: failureError,
      ...(result.response.failureCategory === undefined
        ? {}
        : { failureCategory: result.response.failureCategory }),
    });
  }

  private collectTerminalResults(results: ParallelSubStepResult[]): ParallelSubStepResult[] {
    return results.filter((result) => (
      result.response.status === 'error'
      || result.response.status === 'blocked'
      || result.response.status === 'rate_limited'
    ));
  }

  private hasExplicitErrorAggregateRule(step: WorkflowStep): boolean {
    return step.rules?.some((rule) => aggregateConditionsOf(rule.condition).some(
      (condition) => condition.targetConditions.some(
        (target) => semanticLabelsOf(target).includes(PARALLEL_TERMINAL_ERROR_LABEL),
      ),
    )) === true;
  }

  private buildSubStepErrorDiagnostic(result: ParallelSubStepResult): string {
    const failureCategory = result.response.failureCategory ?? 'none';
    const detail = truncateUtf8PreservingMarker(
      sanitizeSensitiveText(result.response.error ?? result.response.content),
      MAX_AGENT_FAILURE_MESSAGE_BYTES,
    );
    return [
      '[ERROR]',
      `status: ${result.response.status}`,
      `failureCategory: ${failureCategory}`,
      `detail: ${detail}`,
    ].join('\n');
  }

  private buildTerminalDiagnostic(
    step: WorkflowStep,
    terminalResults: ParallelSubStepResult[],
    status: ParallelTerminalStatus,
  ): string {
    const detailLines = terminalResults.map((result) => {
      const failureCategory = result.response.failureCategory ?? 'none';
      const detail = sanitizeSensitiveText(result.response.error ?? result.response.content);
      const lines = [
        `- sub-step: ${result.subStep.name}`,
        `  status: ${result.response.status}`,
        `  failureCategory: ${failureCategory}`,
      ];
      if (result.response.rateLimitInfo) {
        lines.push(`  rateLimitInfo: provider=${result.response.rateLimitInfo.provider}, source=${result.response.rateLimitInfo.source}`);
      }
      lines.push(`  detail: ${detail}`);
      return lines.join('\n');
    });

    return [
      `Parallel step "${step.name}" returned ${status} because one or more sub-steps ended in a non-rule terminal status.`,
      'Aggregate rules were not evaluated as a normal review result because terminal sub-step statuses',
      'do not represent matched aggregate conditions such as all("approved") or any("needs_fix").',
      '',
      'Sub-step diagnostics:',
      ...detailLines,
    ].join('\n');
  }

  private firstFailureResult(results: ParallelSubStepResult[]): ParallelSubStepResult | undefined {
    return results.find(
      (result) => result.response.failureCategory
        === AGENT_FAILURE_CATEGORIES.PROVIDER_STREAM_PARSE_ERROR,
    )
      ?? results.find((result) => result.response.failureCategory !== undefined)
      ?? results.find((result) => result.response.status === 'error');
  }

}
