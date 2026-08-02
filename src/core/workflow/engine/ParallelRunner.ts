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
  WorkflowConfig,
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
import type { ParallelLoggerOptions } from './parallel-logger.js';
import type { RunAgentOptions } from '../../../agents/types.js';
import { createRoutingScope, resolveAutoRoutingBatch } from '../auto-routing/resolver.js';
import { buildRoutingFindings, buildRoutingWorkSnapshot } from '../auto-routing/snapshot.js';
import type { QualityGateRunResult } from '../quality-gates/types.js';
import { sanitizeSensitiveText } from '../../../shared/utils/sensitiveText.js';
import type { FindingContractConfig } from '../../models/types.js';
import type { FindingManagerAuthority } from '../../models/finding-types.js';
import type { FindingLedgerStore } from '../findings/store.js';
import type { FindingManagerRunResult } from '../findings/manager-runner.js';
import {
  ingestFindingContractResults,
  withFindingContractStructuredOutput,
} from '../findings/contract-intake.js';
import type { ReviewerRelationClarification } from '../findings/relation-coherence.js';
import type { CanonicalFindingReviewPublication } from '../findings/review-publication.js';
import type { WorkflowCallRunner } from './WorkflowCallRunner.js';
import type { WorkflowCallIsolatedStateSync, WorkflowCallSessionUpdates } from './WorkflowCallExecutor.js';
import { compactSessionBeforePhase1 } from './session-compaction.js';
import { invalidateExpectedPersonaSession, invalidatePersonaSessionIfExpected } from './session-invalidation.js';
import { recordAgentUsageEvent } from './agent-usage-event.js';
import { formatWorkflowRuleCondition } from '../../models/workflow-rule-condition.js';
import { evaluatePostExecutionRules } from './post-execution-rule-evaluator.js';
import { buildScopedStepIterationIdentity } from '../step-iteration-identity.js';
import { createRunFailure } from '../run/run-failure.js';
import {
  completeObservedPhase1Attempt,
  executeObservedPhase1Attempt,
  PHASE1_EMPTY_OUTPUT_ERROR,
  runPhase1WithEmptyRecovery,
} from './phase1-empty-recovery.js';
import type {
  FindingIntakeNormalizeConfig,
} from '../../models/config-types.js';
import type {
  FindingContractReviewerOutputStrategy,
  FindingContractInstructionContext,
} from '../instruction/instruction-context.js';
import { resolveFindingContractReviewerOutputStrategy } from '../findings/reviewer-output-strategy.js';
import {
  fallbackContextForOperation,
  findingIntakeNormalizerOperationOrigin,
  reviewerOperationOrigin,
  runtimeForOperation,
} from './fallback-operation.js';
import type { DynamicParallelSelectorCoordinator } from '../dynamic-parallel/selector-coordinator.js';
import { validateProviderModelRequirements } from '../provider-model-requirements.js';

const log = createLogger('parallel-runner');

type ParallelSubStepResult = {
  subStep: WorkflowStep;
  response: AgentResponse;
  publication?: CanonicalFindingReviewPublication;
  relationClarification?: ReviewerRelationClarification;
  instruction: string;
  providerInfo?: StepRunResult['providerInfo'];
  durationMs?: number;
  qualityGateFailure?: boolean;
  workflowCallSessionUpdates?: WorkflowCallSessionUpdates;
  workflowCallStateSync?: WorkflowCallIsolatedStateSync;
  workflowCallFailure?: StepRunResult['workflowCallFailure'];
  workflowCallExecutionRejected?: boolean;
  terminalOperation?: StepRunResult['terminalOperation'];
  reviewerRuntime?: RuntimeStepResolution;
};

type ParallelTerminalStatus = 'error' | 'blocked' | 'rate_limited';

function isAgentParallelSubStep(step: WorkflowStep): step is AgentWorkflowStep {
  return !isWorkflowCallStep(step) && step.kind !== 'system';
}

function specializeParallelFindingContractContext(
  baseContext: FindingContractInstructionContext | undefined,
  reviewerOutputStrategy: FindingContractReviewerOutputStrategy,
): FindingContractInstructionContext {
  if (baseContext === undefined || baseContext.reviewer?.mode !== 'structured') {
    throw new Error(
      'Parallel Finding Contract reviewers require one shared review scope snapshot',
    );
  }
  const sharedReviewerContext = baseContext.reviewer;
  if (reviewerOutputStrategy.kind === 'structured') {
    return baseContext;
  }
  return {
    ...baseContext,
    reviewer: {
      mode: 'plain_text_normalized',
      reviewScopeSnapshotId: sharedReviewerContext.reviewScopeSnapshotId,
    },
  };
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
  readonly getCwd: () => string;
  readonly dynamicParallelSelector: DynamicParallelSelectorCoordinator;
  readonly getWorkflowName: () => string;
  readonly getTask: () => string;
  readonly getInteractive: () => boolean;
  readonly observabilityEnabled: boolean;
  readonly observabilityRunId?: string;
  readonly sanitizeObservabilityText?: (text: string) => string;
  readonly getCurrentWorkflowStack?: () => WorkflowResumePointEntry[] | undefined;
  readonly refreshFindingsState: () => void;
  readonly emitEvent: (event: string, ...args: unknown[]) => void;
  readonly findingContract?: FindingContractConfig;
  readonly intakeNormalize?: FindingIntakeNormalizeConfig;
  readonly findingManagerAuthority: FindingManagerAuthority;
  /** findings-manager の provider/model 未指定時の fallback（manager-runner.ts 参照）。 */
  readonly workflowProvider?: WorkflowConfig['provider'];
  readonly workflowModel?: WorkflowConfig['model'];
  readonly findingLedgerStore?: FindingLedgerStore;
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
  /** raw finding id 衝突対策の呼び出し名前空間。トップレベルでは空文字列。 */
  readonly getFindingCallNamespace: () => string;
  readonly runQualityGates: (options: {
    qualityGates: WorkflowStep['qualityGates'];
    projectRoot: string;
    step: WorkflowStep;
    childProcessEnv?: Readonly<Record<string, string>>;
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
    activeStepIteration?: number,
  ): Promise<StepRunResult> {
    if (!step.parallel) {
      throw new Error(`Step "${step.name}" has no parallel sub-steps`);
    }
    const subSteps = isDynamicParallelSubSteps(step.parallel)
      ? await this.deps.dynamicParallelSelector.selectParticipants(step, state, task)
      : step.parallel;
    this.deps.engineOptions.abortSignal?.throwIfAborted();
    // 直前ステップ（通常は coder の fix）の応答。異議申告の裁定材料として
    // manager に渡すため、サブステップ実行で lastOutput が変わる前に捕捉する。
    const priorStepResponseText = state.lastOutput?.content;
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
    const configuredProviderInfoByStep = new Map(subSteps.map((subStep) => {
      const providerInfo = this.deps.optionsBuilder.resolveStepProviderModelBeforeAutoRouting(subStep, runtime);
      validateProviderModelRequirements(providerInfo.provider, providerInfo.model, {
        modelFieldName: `Configuration error: parallel sub-step "${subStep.name}" model`,
      });
      return [subStep.name, providerInfo];
    }));
    const routingLedger = this.deps.engineOptions.autoRouting && agentSubSteps.length > 0
      ? this.deps.findingLedgerStore?.loadLedger()
      : undefined;
    const routedProviderInfoByStep = this.deps.engineOptions.autoRouting
      ? await resolveAutoRoutingBatch({
          autoRouting: this.deps.engineOptions.autoRouting,
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
              lastOutput: state.lastOutput?.content,
              findings: buildRoutingFindings(routingLedger),
              sensitiveValues: this.deps.engineOptions.routingSensitiveValues,
            }),
            currentProviderInfo: configuredProviderInfoByStep.get(subStep.name)!,
          })),
          estimator: this.deps.engineOptions.autoRoutingEstimator,
          runtime: this.deps.engineOptions.routingRuntime,
          logger: log,
          abortSignal: this.deps.engineOptions.abortSignal,
        })
      : new Map();
    const structuredReviewerStrategy: FindingContractReviewerOutputStrategy = {
      kind: 'structured',
      reportGeneration: 'structured',
      intake: 'reviewer_structured',
    };
    const baseFindingContractContext = this.deps.findingContract
      && agentSubSteps[0] !== undefined
      ? this.deps.optionsBuilder.buildFindingContractInstructionContext(
          agentSubSteps[0],
          structuredReviewerStrategy,
        )
      : undefined;
    const sharedReviewerContext = baseFindingContractContext?.reviewer;
    if (
      this.deps.findingContract !== undefined
      && agentSubSteps.length > 0
      && (
        sharedReviewerContext?.mode !== 'structured'
        || sharedReviewerContext.reviewScopeSnapshotId.length === 0
      )
    ) {
      throw new Error(
        'Parallel Finding Contract reviewers require one shared review scope snapshot',
      );
    }
    const workflowCallResumeStack = subSteps.some(isWorkflowCallStep)
      ? this.requireWorkflowCallResumeStack(step, stepIteration)
      : undefined;
    const providerInfoByStep = new Map(subSteps.map((subStep) => {
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

    // Run all sub-steps concurrently (failures are captured, not thrown)
    // When semaphore is set, at most `concurrency` sub-steps execute simultaneously.
    const subStepStartedAtByName = new Map<string, number>();
    const subStepInstructionByName = new Map<string, string>();
    const settled = await Promise.allSettled(
      subSteps.map(async (subStep, index) => {
        if (semaphore) {
          await semaphore.acquire();
        }
        const startedAt = Date.now();
        subStepStartedAtByName.set(subStep.name, startedAt);
        try {
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
          const publicationResumeRuntime = runtimeForOperation(
            routedRuntime,
            findingIntakeNormalizerOperationOrigin(subStep.name),
            routedRuntime?.providerInfo,
          );
          const reviewerOutputStrategy = this.deps.findingContract
            ? resolveFindingContractReviewerOutputStrategy(
                this.deps.findingContract,
                this.deps.intakeNormalize,
                this.deps.optionsBuilder.resolveStepProviderModel(
                  subStep,
                  subRuntime,
                ),
              )
            : undefined;
          if (
            this.deps.findingContract !== undefined
            && reviewerOutputStrategy === undefined
          ) {
            throw new Error('Finding contract reviewer output strategy is not configured');
          }
          const findingContractContext = reviewerOutputStrategy !== undefined
            ? specializeParallelFindingContractContext(
                baseFindingContractContext,
                reviewerOutputStrategy,
              )
            : undefined;
          const rawFindingsStructuredOutput =
            findingContractContext?.reviewer?.mode === 'structured'
              ? findingContractContext.reviewer.rawFindingsStructuredOutput
              : undefined;
          const executableSubStep =
            findingContractContext?.reviewer?.mode === 'structured'
              ? withFindingContractStructuredOutput(subStep, findingContractContext)
              : subStep;
          const subIteration = incrementStepIteration(
            state,
            buildScopedStepIterationIdentity(subStep.name, [step.name]),
          );
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
            findingContractContext === undefined
              ? undefined
              : { mode: 'explicit', context: findingContractContext },
          );
          const phase1Instruction = rawFindingsStructuredOutput
            ? this.deps.stepExecutor.buildPhase1Instruction(subInstruction, executableSubStep, subRuntime)
            : subInstruction;
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

        if (findingContractContext !== undefined) {
          if (reviewerOutputStrategy === undefined) {
            throw new Error('Finding contract reviewer output strategy is not configured');
          }
          const resumedPublication = await this.deps.stepExecutor
            .resumeFindingReviewPublication({
              step: subStep,
              parentStepName: step.name,
              stepIteration,
              state,
              runtime: publicationResumeRuntime,
            });
          if (resumedPublication !== undefined) {
            if ('terminalResponse' in resumedPublication) {
              state.stepOutputs.set(
                subStep.name,
                resumedPublication.terminalResponse,
              );
              return {
                subStep,
                response: resumedPublication.terminalResponse,
                instruction: phase1Instruction,
                providerInfo: resumedPublication.reviewerProviderInfo ?? subPm,
                reviewerRuntime: resumedPublication.reviewerRuntime,
                terminalOperation: resumedPublication.terminalOperation,
                durationMs: Math.max(
                  0,
                  resumedPublication.terminalResponse.timestamp.getTime() - startedAt,
                ),
              };
            }
            const qualityGateResult = await this.deps.runQualityGates({
              qualityGates: subStep.qualityGates,
              projectRoot: this.deps.getCwd(),
              step: subStep,
              childProcessEnv: this.deps.engineOptions.childProcessEnv,
            });
            if (!qualityGateResult.ok) {
              state.stepOutputs.set(subStep.name, qualityGateResult.response);
              return {
                subStep,
                response: qualityGateResult.response,
                instruction: phase1Instruction,
                providerInfo: subPm,
                durationMs: Math.max(
                  0,
                  qualityGateResult.response.timestamp.getTime() - startedAt,
                ),
                qualityGateFailure: true,
              };
            }
            state.stepOutputs.set(subStep.name, resumedPublication.response);
            this.deps.stepExecutor.emitStepReports(
              subStep,
              {
                iteration: parentIteration,
                resumeStepName: step.name,
                stepIteration: subIteration,
                providerInfo: resumedPublication.reviewerProviderInfo ?? subPm,
              },
            );
            return {
              subStep,
              publication: resumedPublication.publication,
              ...(resumedPublication.relationClarification !== undefined
                ? { relationClarification: resumedPublication.relationClarification }
                : {}),
              response: resumedPublication.response,
              instruction: phase1Instruction,
              providerInfo: resumedPublication.reviewerProviderInfo ?? subPm,
              reviewerRuntime: resumedPublication.reviewerRuntime,
              durationMs: Math.max(
                0,
                resumedPublication.response.timestamp.getTime() - startedAt,
              ),
            };
          }
        }

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
        // Override onStream with parallel logger's prefixed handler (immutable)
        const agentOptions: RunAgentOptions = parallelLogger
          ? {
              ...baseOptions,
              ...(compactionOutcome === 'fresh' ? { sessionId: undefined } : {}),
              onStream: parallelLogger.createStreamHandler(subStep.name, index),
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
                )
              ),
              onPhaseStart: this.deps.onPhaseStart,
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
          },
        });
        const subResponse = phase1Result.response;
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
        completeObservedPhase1Attempt({
          eventStep: subStep,
          iteration: parentIteration,
          attempt: phase1Result.finalAttempt,
          response: subResponse,
          onPhaseComplete: this.deps.onPhaseComplete,
        });
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

        let publication: CanonicalFindingReviewPublication | undefined;
        let relationClarification: ReviewerRelationClarification | undefined;
        let finalResponse = subResponse;
        let completedReviewerProviderInfo = subPm;
        let completedReviewerRuntime: RuntimeStepResolution = {
          providerInfo: subPm,
        };
        if (findingContractContext !== undefined) {
          if (reviewerOutputStrategy === undefined) {
            throw new Error('Finding contract reviewer output strategy is not configured');
          }
          const prepared = await this.deps.stepExecutor.prepareFindingReviewPublication({
            step: subStep,
            executableStep: executableSubStep,
            reviewerOutputStrategy,
            parentStepName: step.name,
            stepIteration,
            state,
            phase1Response: subResponse,
            agentOptions,
            onProviderAttempt: (attemptProviderInfo, success, usage) => {
              recordAgentUsageEvent(
                this.deps.engineOptions,
                subStep.name,
                'parallel',
                attemptProviderInfo,
                success,
                usage,
              );
            },
            updatePersonaSession,
            runtime: subRuntime,
          });
          if ('terminalResponse' in prepared) {
            state.stepOutputs.set(subStep.name, prepared.terminalResponse);
            return {
              subStep,
              response: prepared.terminalResponse,
              instruction: phase1Instruction,
              providerInfo: prepared.reviewerProviderInfo ?? subPm,
              reviewerRuntime: prepared.reviewerRuntime,
              ...(prepared.terminalOperation !== undefined
                ? { terminalOperation: prepared.terminalOperation }
                : {}),
              durationMs: Math.max(
                0,
                prepared.terminalResponse.timestamp.getTime() - startedAt,
              ),
            };
          }
          publication = prepared.publication;
          relationClarification = prepared.relationClarification;
          finalResponse = prepared.response;
          completedReviewerProviderInfo = prepared.reviewerProviderInfo ?? subPm;
          completedReviewerRuntime = prepared.reviewerRuntime ?? {
            providerInfo: completedReviewerProviderInfo,
          };
        } else {
          const phaseCtx = this.deps.optionsBuilder.buildPhaseRunnerContext(
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
          try {
            match = await evaluatePostExecutionRules(
              subStep,
              () => phaseCtx,
              subRuleCtx,
            );
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
        }

        const qualityGateResult = await this.deps.runQualityGates({
          qualityGates: subStep.qualityGates,
          projectRoot: this.deps.getCwd(),
          step: subStep,
          childProcessEnv: this.deps.engineOptions.childProcessEnv,
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

        state.stepOutputs.set(subStep.name, finalResponse);
        this.deps.stepExecutor.emitStepReports(
          subStep,
          {
            iteration: parentIteration,
            resumeStepName: step.name,
            stepIteration: subIteration,
            providerInfo: completedReviewerProviderInfo,
          },
        );

        return {
          subStep,
          response: finalResponse,
          ...(publication !== undefined ? { publication } : {}),
          ...(relationClarification !== undefined ? { relationClarification } : {}),
          instruction: phase1Instruction,
          providerInfo: completedReviewerProviderInfo,
          reviewerRuntime: completedReviewerRuntime,
          durationMs: Math.max(0, finalResponse.timestamp.getTime() - startedAt),
        };
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
      };
      state.stepOutputs.set(failedStep.name, errorResponse);
      const startedAt = subStepStartedAtByName.get(failedStep.name);
      const instruction = subStepInstructionByName.get(failedStep.name);
      return {
        subStep: failedStep,
        response: errorResponse,
        instruction: instruction === undefined ? '' : instruction,
        providerInfo: routedProviderInfoByStep.get(failedStep.name),
        durationMs: startedAt === undefined
          ? 0
          : Math.max(0, errorResponse.timestamp.getTime() - startedAt),
        ...(isWorkflowCallStep(failedStep) ? { workflowCallExecutionRejected: true } : {}),
      };
    });
    this.mergeWorkflowCallSubStepEffects(step, subResults, state, updatePersonaSession);
    this.recordSubStepRoutingResults(step, subResults);
    this.emitSubStepRoutingDecisionEvents(subResults, state.iteration);

    const ruleDetectionFailure = settled.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
        && result.reason instanceof RuleDetectionExhaustedError,
    );
    if (ruleDetectionFailure) {
      throw ruleDetectionFailure.reason;
    }

    const terminalResults = this.collectTerminalResults(subResults);
    const rateLimitedResult = terminalResults.find((r) => r.response.status === 'rate_limited');
    if (rateLimitedResult) {
      return this.createTerminalParentResult({
        step,
        state,
        stepIteration,
        subResults,
        terminalResults,
        status: 'rate_limited',
        providerInfo: rateLimitedResult.providerInfo ?? parentPm,
        terminalOperation: rateLimitedResult.terminalOperation,
      });
    }

    const errorResults = terminalResults.filter((r) => r.response.status === 'error');
    if (errorResults.length > 0) {
      return this.createTerminalParentResult({
        step,
        state,
        stepIteration,
        subResults,
        terminalResults,
        status: 'error',
        providerInfo: errorResults[0]?.providerInfo ?? parentPm,
      });
    }

    const blockedResults = terminalResults.filter((r) => r.response.status === 'blocked');
    if (blockedResults.length > 0) {
      return this.createTerminalParentResult({
        step,
        state,
        stepIteration,
        subResults,
        terminalResults: blockedResults,
        status: 'blocked',
        providerInfo: blockedResults[0]?.providerInfo ?? parentPm,
        terminalOperation: blockedResults[0]?.terminalOperation,
      });
    }

    const qualityGateFailure = subResults.find((r) => (
      'qualityGateFailure' in r && r.qualityGateFailure === true
    ));
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

    // 全 reviewer の canonical publication が揃った後に一度だけ取り込む。
    // ここより前の失敗では ledger と rules のどちらも動かさない。
    await this.runFindingContractManager(
      step,
      stepIteration,
      state.iteration,
      subResults,
      priorStepResponseText,
    );

    const postExecutionRuntime = runtime?.fallback === undefined
      ? runtime
      : { ...runtime, fallback: undefined };
    if (this.deps.findingContract !== undefined) {
      for (const result of subResults) {
        if (!isAgentParallelSubStep(result.subStep)) {
          continue;
        }
        if (result.publication === undefined) {
          throw new Error(
            `Finding contract reviewer "${result.subStep.name}" has no canonical publication`,
          );
        }
        const subRuntime = result.reviewerRuntime
          ?? (
            result.providerInfo === undefined
              ? postExecutionRuntime
              : {
                  ...postExecutionRuntime,
                  providerInfo: result.providerInfo,
                }
          );
        result.response = await this.deps.stepExecutor.applyPostExecutionRulesOnly(
          result.subStep,
          state,
          result.response,
          updatePersonaSession,
          subRuntime,
        );
        state.stepOutputs.set(result.subStep.name, result.response);
      }
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
      .map((r) => `## ${r.subStep.name}\n${r.response.content}`)
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
        postExecutionRuntime,
      ),
      parentRuleCtx,
    );

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
    this.deps.stepExecutor.emitStepReports(
      step,
      {
        iteration: state.iteration,
        resumeStepName: step.name,
        stepIteration,
        providerInfo: parentPm,
      },
    );
    const selectedFailure = this.selectFailureByDefinitionOrder(
      subResults,
      `Step "${step.name}" failed`,
    );
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

  private async runFindingContractManager(
    step: WorkflowStep,
    stepIteration: number,
    iteration: number,
    subResults: ParallelSubStepResult[],
    priorStepResponseText: string | undefined,
  ): Promise<FindingManagerRunResult | undefined> {
    if (!this.deps.findingContract) {
      return undefined;
    }
    const ledgerStore = this.deps.findingLedgerStore;
    if (!ledgerStore) {
      throw new Error('Finding contract is configured but finding ledger store is not available');
    }
    const reviewerResults = subResults.flatMap((result) => {
      if (!isAgentParallelSubStep(result.subStep)) {
        return [];
      }
      if (result.publication === undefined) {
        throw new Error(
          `Finding contract reviewer "${result.subStep.name}" has no canonical publication`,
        );
      }
      return [{
        subStep: result.subStep,
        publication: result.publication,
        ...(result.relationClarification !== undefined
          ? { relationClarification: result.relationClarification }
          : {}),
      }];
    });
    if (reviewerResults.length === 0) {
      return undefined;
    }
    return ingestFindingContractResults({
      contract: this.deps.findingContract,
      workflowProvider: this.deps.workflowProvider,
      workflowModel: this.deps.workflowModel,
      cwd: this.deps.getCwd(),
      ledgerStore,
      optionsBuilder: this.deps.optionsBuilder,
      stepExecutor: this.deps.stepExecutor,
      parentStep: step,
      stepIteration,
      iteration,
      subResults: reviewerResults,
      // 台帳の workflowName スタンプは店（ledgerStore）が束縛する正準名を使う。
      // workflow_call の子が親の台帳を継承した場合、この engine 自身の
      // getWorkflowName()（子のワークフロー名）を使うと reconcile 後の
      // ledger.workflowName が親の台帳と食い違い、次回 load/save で
      // assertLedgerWorkflowName が例外を投げる。
      workflowName: ledgerStore.workflowName,
      workflowTask: this.deps.getTask(),
      analyticsWorkflowName: this.deps.getWorkflowName(),
      callNamespace: this.deps.getFindingCallNamespace(),
      timestamp: new Date().toISOString(),
      priorStepResponseText,
      managerAuthority: this.deps.findingManagerAuthority,
      refreshFindingsState: this.deps.refreshFindingsState,
      emitEvent: this.deps.emitEvent,
    });
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
  ): Promise<AgentResponse> {
    let response: AgentResponse;
    try {
      response = await executeAgent(subStep.persona, instruction, options);
    } catch (error) {
      recordAgentUsageEvent(
        this.deps.engineOptions,
        subStep.name,
        'parallel',
        providerInfo,
        false,
        undefined,
      );
      throw error;
    }
    recordAgentUsageEvent(
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
    terminalOperation?: StepRunResult['terminalOperation'];
  }): StepRunResult {
    const content = this.buildTerminalDiagnostic(
      options.step,
      options.terminalResults,
      options.status,
    );
    const failureCategory = this.firstFailureCategory(options.terminalResults);
    const response: AgentResponse = {
      persona: options.step.name,
      status: options.status,
      content,
      timestamp: new Date(),
      ...(options.status === 'error' || options.status === 'rate_limited' ? { error: content } : {}),
      ...(failureCategory && { failureCategory }),
      ...this.firstRateLimitMetadata(options.terminalResults),
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

    const selectedFailure = this.selectFailureByDefinitionOrder(
      options.subResults,
      `Step "${options.step.name}" failed: ${content}`,
    );
    return {
      response,
      instruction: options.subResults.map((result) => result.instruction).join('\n\n'),
      providerInfo: options.providerInfo,
      ...(selectedFailure === undefined ? {} : { workflowCallFailure: selectedFailure }),
      ...(options.terminalOperation !== undefined
        ? { terminalOperation: options.terminalOperation }
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
    parentReason: string,
  ): StepRunResult['workflowCallFailure'] {
    for (const result of results) {
      if (result.workflowCallFailure !== undefined) {
        return result.workflowCallFailure;
      }
      if (result.response.status === 'error') {
        return createRunFailure({
          kind: 'step_error',
          step: result.subStep.name,
          reason: parentReason,
          error: result.response.error ?? result.response.content,
        });
      }
    }
    return undefined;
  }

  private collectTerminalResults(results: ParallelSubStepResult[]): ParallelSubStepResult[] {
    return results.filter((result) => (
      result.response.status === 'error'
      || result.response.status === 'blocked'
      || result.response.status === 'rate_limited'
    ));
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

  private firstFailureCategory(results: ParallelSubStepResult[]): AgentResponse['failureCategory'] | undefined {
    return results.find((result) => result.response.failureCategory)?.response.failureCategory;
  }

  private firstRateLimitMetadata(results: ParallelSubStepResult[]): Pick<AgentResponse, 'errorKind' | 'rateLimitInfo'> {
    const rateLimitedResult = results.find((result) => result.response.status === 'rate_limited');
    if (!rateLimitedResult) {
      return {};
    }
    return {
      ...(rateLimitedResult.response.errorKind && { errorKind: rateLimitedResult.response.errorKind }),
      ...(rateLimitedResult.response.rateLimitInfo && { rateLimitInfo: rateLimitedResult.response.rateLimitInfo }),
    };
  }

}
