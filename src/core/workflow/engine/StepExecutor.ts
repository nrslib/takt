/**
 * Executes a single workflow step through the 3-phase model.
 *
 * Phase 1: Main agent execution (with tools)
 * Phase 2: Report output (Write-only, optional)
 * Phase 3: Status judgment (no tools, optional)
 */

import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AgentWorkflowStep,
  WorkflowStep,
  WorkflowState,
  AgentResponse,
  Language,
  FallbackContext,
  WorkflowConfig,
  WorkflowResumePointEntry,
  NormalAgentWorkflowStep,
  ResolvedFacetPool,
  ResolvedFacetContent,
} from '../../models/types.js';
import { isNormalAgentWorkflowStep } from '../../models/types.js';
import type {
  PhaseName,
  PhasePromptParts,
  JudgeStageEntry,
  RuntimeStepResolution,
  StepProviderInfo,
  StepRunResult,
  WorkflowEngineOptions,
  WorkflowStepExecutionEventContext,
} from '../types.js';
import type { ProviderUsageSnapshot } from '../../models/response.js';
import { executeAgent } from '../../../agents/agent-usecases.js';
import {
  executeStructuredAgent,
  executeStructuredTextAgent,
  requireStructuredAgentProvider,
  StructuredAgentResponseError,
} from '../../../agents/structured-caller/transport.js';
import { InstructionBuilder } from '../instruction/InstructionBuilder.js';
import type {
  DynamicFacetSelectionContext,
  DynamicFacetSelectorCoordinator,
} from '../dynamic-facets/dynamicFacetSelectorCoordinator.js';
import {
  runReportPhase,
  ReportPhaseGenerationError,
} from '../phase-runner.js';
import { RuleDetectionExhaustedError } from '../evaluation/RuleDetectionExhaustedError.js';
import type {
  BasePhaseRunnerContext,
  StatusJudgmentPhaseContext,
} from '../phase-runner.js';
import { buildSessionKey } from '../session-key.js';
import { incrementStepIteration, getPreviousOutput } from './state-manager.js';
import { createLogger, getErrorMessage, slugify } from '../../../shared/utils/index.js';
import { safeExternalErrorMessage } from '../../../shared/utils/safeExternalErrorMessage.js';
import type { OptionsBuilder } from './OptionsBuilder.js';
import type { RunPaths } from '../run/run-paths.js';
import { waitForStepDelay } from './step-delay.js';
import { parseStructuredOutputObject } from '../../../agents/structured-caller/shared.js';
import {
  assertProviderResolvedForCapabilitySensitiveOptions,
} from './engine-provider-options.js';
import {
  StructuredOutputSchemaError,
  StructuredOutputValueValidationError,
  validateStructuredOutputAgainstSchema,
} from './structured-output-schema-validator.js';
import {
  providerSupportsStructuredOutput,
} from '../../../infra/providers/provider-capabilities.js';
import {
  AGENT_FAILURE_CATEGORIES,
  createProviderStreamParseError,
} from '../../../shared/types/agent-failure.js';
import { buildStructuredJsonSchemaInstruction } from '../../../shared/prompts/index.js';
import type {
  StructuredOutputFailureReason,
  StructuredOutputNormalizerRegistry,
} from './structured-output-normalizer.js';
import { compactSessionBeforePhase1 } from './session-compaction.js';
import { invalidateExpectedPersonaSession, invalidatePersonaSessionIfExpected } from './session-invalidation.js';
import type { InstructionBuildTransaction } from './instruction-build-transaction.js';
import { evaluatePostExecutionRules } from './post-execution-rule-evaluator.js';
import type { PullRequestContext } from '../pr-context.js';
import type { TaskReviewScope } from '../review-scope.js';
import { requireWorkflowResumeStackSnapshot } from '../run/resume-point.js';
import {
  completeObservedPhase1Attempt,
  executeObservedPhase1Attempt,
  PHASE1_EMPTY_OUTPUT_ERROR,
  runPhase1WithEmptyRecovery,
  type Phase1Attempt,
} from './phase1-empty-recovery.js';
import { buildCompanionMailboxDirectory } from '../companion/mailbox.js';
import { runCompanionFixLoop } from '../companion/fix-loop.js';
import { CompanionStepRuntime } from '../companion/step-runtime.js';
import {
  CompanionReviewStateStore,
  type CompanionReviewAuthority,
} from '../companion/review-state-store.js';
import type { RunAgentOptions } from '../../../agents/types.js';
import { isAbortError } from '../companion/abort.js';
import {
  buildCompletionRetryJudgePrompt,
  formatCompletionRetryDiagnostic,
  parseCompletionRetryDecision,
  runCompletionRetryEpisode,
  COMPLETION_RETRY_JUDGE_NAME,
  type CompletionRetryDiagnostic,
} from '../completion-retry.js';
import { buildCompletionRetryJudgeStep } from '../completion-retry-judge-step.js';
import {
  collectCompletionRetryEvidence,
  completionRetryClaimedPaths,
} from '../completion-retry-evidence.js';
import { runWithCompletionRetryJudgeSpan } from '../observability/workflowSpans.js';
import {
  fallbackContextForOperation,
  reviewerOperationOrigin,
} from './fallback-operation.js';

const log = createLogger('step-executor');

function emitCompanionReviewSkippedSafely(
  emitEvent: StepExecutorDeps['emitEvent'],
  payload: Record<string, unknown>,
): void {
  try {
    emitEvent('companion:review_skipped', payload);
  } catch (error) {
    log.warn('Companion skip audit could not be emitted; continuing workflow', {
      error: safeExternalErrorMessage(error),
    });
  }
}

function requireActiveCompanionState(
  state: WorkflowState,
  stepName: string,
): NonNullable<WorkflowState['companion']> {
  if (state.companion === undefined) {
    throw new Error(`Missing companion workflow state for active step "${stepName}"`);
  }
  return state.companion;
}

export interface StepExecutorDeps {
  readonly optionsBuilder: OptionsBuilder;
  readonly getCwd: () => string;
  readonly getProjectCwd: () => string;
  readonly getReportDir: () => string;
  readonly getRunPaths: () => RunPaths;
  readonly getFailureDir: () => string;
  readonly getLanguage: () => Language | undefined;
  readonly getInteractive: () => boolean;
  readonly getWorkflowSteps: () => ReadonlyArray<{ name: string; description?: string }>;
  readonly getWorkflowName: () => string;
  readonly getTask: () => string;
  readonly getWorkflowDescription: () => string | undefined;
  readonly getWorkflowCallVars?: () => Readonly<Record<string, string | number | boolean>> | undefined;
  readonly getRetryNote: () => string | undefined;
  readonly getPrContext?: () => PullRequestContext | undefined;
  /** Changed file set for this task. Recomputed per instruction build (the working tree moves). */
  readonly getReviewScope: () => TaskReviewScope;
  readonly getObservabilityRunId?: () => string | undefined;
  readonly observabilityEnabled?: () => boolean;
  readonly sanitizeObservabilityText?: (text: string) => string;
  readonly getCurrentWorkflowStack?: () => WorkflowResumePointEntry[] | undefined;
  readonly structuredOutputNormalizers: StructuredOutputNormalizerRegistry;
  readonly abortSignal?: AbortSignal;
  readonly getAbortSignal?: () => AbortSignal | undefined;
  readonly executionProvider: WorkflowConfig['provider'];
  readonly executionModel: WorkflowConfig['model'];
  readonly internalAgentSeats?: import('../../models/config-types.js').InternalAgentSeats;
  readonly emitEvent: (event: string, ...args: unknown[]) => void;
  /** 実行ループ外の合成ステップの LLM 呼び出しを usage-events へ記録する。 */
  readonly recordSynthesizedAgentUsage: (
    stepName: string,
    providerInfo: StepProviderInfo,
    success: boolean,
    usage: ProviderUsageSnapshot | undefined,
  ) => void;
  readonly getRunId: () => string;
  readonly getRunPathNamespace: () => readonly string[];
  readonly companionEnabled: boolean;
  readonly companionDefinitions?: WorkflowConfig['companions'];
  readonly companionProviders?: WorkflowEngineOptions['companionProviders'];
  readonly companionSelectorProvider?: WorkflowEngineOptions['selectorProvider'];
  readonly companionDiffReader?: WorkflowEngineOptions['companionDiffReader'];
  readonly companionReviewAuthority?: CompanionReviewAuthority;
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
  readonly dynamicFacetSelectorCoordinator?: DynamicFacetSelectorCoordinator;
  readonly getFacetPool?: (name: string) => ResolvedFacetPool | undefined;
}

/**
 * 通常 agent ステップを実行前に確定した結果。RunLoop の観測イベント、
 * StepExecutor、provider がこの同じ値を共有する。
 */
export interface PreparedNormalStepExecution {
  readonly executableStep: AgentWorkflowStep;
  readonly phase1Instruction: string;
  readonly priorStepResponseText?: string;
  readonly stepIteration: number;
}

interface StructuredOutputNormalizationResult {
  readonly response: AgentResponse;
  readonly invalidDetail?: string;
  readonly invalidKind?: 'model_output' | 'schema_config';
  readonly invalidIssues?: readonly {
    readonly path: string;
    readonly keyword: string;
    readonly message: string;
  }[];
}

export class StepExecutor {
  private static isProviderStreamParseFailure(response: AgentResponse): boolean {
    return response.failureCategory === AGENT_FAILURE_CATEGORIES.PROVIDER_STREAM_PARSE_ERROR;
  }

  private readonly structuredOutputNormalizers: StructuredOutputNormalizerRegistry;
  private readonly companionReviewState: CompanionReviewStateStore | undefined;

  constructor(
    private readonly deps: StepExecutorDeps,
  ) {
    this.structuredOutputNormalizers = deps.structuredOutputNormalizers;
    this.companionReviewState = deps.companionReviewAuthority === undefined
      ? undefined
      : new CompanionReviewStateStore(deps.companionReviewAuthority);
  }

  private resolveAbortSignal(): AbortSignal | undefined {
    return this.deps.getAbortSignal?.() ?? this.deps.abortSignal;
  }

  private static buildTimestamp(): string {
    return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  }

  private static buildSnapshotFileName(
    stepName: string,
    stepIteration: number,
    timestamp: string,
  ): string {
    const safeStepName = slugify(stepName) || 'step';
    return `${safeStepName}.${stepIteration}.${timestamp}.md`;
  }

  async completeReviewerResponse(input: {
    readonly step: AgentWorkflowStep;
    readonly originalInstruction: string;
    readonly initialResponse: AgentResponse;
    readonly executeRetry: (
      instruction: string,
      sessionId: string | undefined,
    ) => Promise<AgentResponse>;
  }): Promise<{
    readonly response: AgentResponse;
    readonly reviewerSessionId: string | undefined;
    readonly diagnostic?: CompletionRetryDiagnostic;
  }> {
    const config = input.step.completionRetry;
    if (config === undefined) {
      return {
        response: input.initialResponse,
        reviewerSessionId: input.initialResponse.sessionId,
      };
    }
    const priorJudgeGapPaths = new Set<string>();
    const result = await runCompletionRetryEpisode({
      config,
      originalInstruction: input.originalInstruction,
      initialResponse: input.initialResponse,
      initialSessionId: input.initialResponse.sessionId,
      executeRetry: async ({ attemptIndex, instruction, sessionId }) => {
        this.deps.emitEvent('review_completion:retry:start', {
          step: input.step.name,
          attempt: attemptIndex,
        });
        try {
          const response = await input.executeRetry(instruction, sessionId);
          this.deps.emitEvent('review_completion:retry:complete', {
            step: input.step.name,
            attempt: attemptIndex,
            status: response.status,
            ...(response.error === undefined ? {} : { error: response.error }),
          });
          return response;
        } catch (error) {
          this.deps.emitEvent('review_completion:retry:complete', {
            step: input.step.name,
            attempt: attemptIndex,
            status: 'error',
            error: getErrorMessage(error),
          });
          throw error;
        }
      },
      judge: async (reviewResponse, attemptIndex) => {
        const judgeStep = buildCompletionRetryJudgeStep({
          reviewerStepName: input.step.name,
          workflowProvider: this.deps.executionProvider,
          workflowModel: this.deps.executionModel,
          internalAgentSeats: this.deps.internalAgentSeats,
        });
        const reviewScope = this.deps.getReviewScope();
        const prompt = buildCompletionRetryJudgePrompt({
          language: this.deps.getLanguage(),
          task: this.deps.getTask(),
          reviewerInstruction: input.originalInstruction,
          reviewScope,
          evidence: collectCompletionRetryEvidence({
            cwd: this.deps.getCwd(),
            reviewScope,
            claimedPaths: completionRetryClaimedPaths(reviewResponse.structuredOutput),
            priorGapPaths: [...priorJudgeGapPaths],
          }),
          reviewResponse: reviewResponse.content,
        });
        let judgeProviderInfo: StepProviderInfo = { provider: undefined, model: undefined };
        let usageRecorded = false;
        try {
          judgeProviderInfo = this.deps.optionsBuilder.resolveStepProviderModel(judgeStep);
          const provider = requireStructuredAgentProvider(
            judgeProviderInfo.provider,
            COMPLETION_RETRY_JUDGE_NAME,
          );
          const judgeOptions = this.deps.optionsBuilder.buildAgentOptions(judgeStep);
          this.deps.emitEvent('review_completion:judge:start', {
            step: input.step.name,
            attempt: attemptIndex,
            provider,
            model: judgeProviderInfo.model,
          });
          const response = await runWithCompletionRetryJudgeSpan(
            {
              enabled: this.deps.observabilityEnabled?.() === true,
              runId: this.deps.getObservabilityRunId?.(),
              workflowName: this.deps.getWorkflowName(),
              reviewerStep: input.step.name,
              attempt: attemptIndex,
              providerInfo: judgeProviderInfo,
            },
            () => executeStructuredAgent(
              prompt.instruction,
              judgeStep.structuredOutput!.schema,
              {
                name: COMPLETION_RETRY_JUDGE_NAME,
                cwd: this.deps.getCwd(),
                projectCwd: this.deps.getProjectCwd(),
                systemPrompt: prompt.systemPrompt,
                language: this.deps.getLanguage(),
                abortSignal: this.resolveAbortSignal(),
                childProcessEnv: judgeOptions.childProcessEnv,
                failureDir: judgeOptions.failureDir,
                resolution: {
                  provider,
                  model: judgeProviderInfo.model,
                  providerOptions: judgeOptions.providerOptions,
                  permissionMode: judgeOptions.permissionMode,
                },
              },
            ),
            (judgeResponse) => ({
              status: judgeResponse.status,
              gapCount: Array.isArray(judgeResponse.structuredOutput?.missing_obligations)
                ? judgeResponse.structuredOutput.missing_obligations.length
                : 0,
            }),
          );
          this.deps.recordSynthesizedAgentUsage(
            COMPLETION_RETRY_JUDGE_NAME,
            judgeProviderInfo,
            true,
            response.providerUsage,
          );
          usageRecorded = true;
          const decision = parseCompletionRetryDecision(response.structuredOutput);
          decision.missingObligations.forEach((gap) => priorJudgeGapPaths.add(gap.path));
          this.deps.emitEvent('review_completion:judge:complete', {
            step: input.step.name,
            attempt: attemptIndex,
            status: response.status,
            complete: decision.complete,
            gapCount: decision.missingObligations.length,
          });
          return decision;
        } catch (error) {
          if (!usageRecorded && judgeProviderInfo.provider !== undefined) {
            this.deps.recordSynthesizedAgentUsage(
              COMPLETION_RETRY_JUDGE_NAME,
              judgeProviderInfo,
              false,
              undefined,
            );
          }
          this.deps.emitEvent('review_completion:judge:complete', {
            step: input.step.name,
            attempt: attemptIndex,
            status: 'error',
            error: getErrorMessage(error),
          });
          throw error;
        }
      },
      isAbort: (error) => isAbortError(error) || this.resolveAbortSignal()?.aborted === true,
    });
    return {
      response: result.response,
      reviewerSessionId: result.reviewerSessionId,
      ...(result.diagnostic === undefined ? {} : { diagnostic: result.diagnostic }),
    };
  }

  normalizeReviewerResponse(
    step: AgentWorkflowStep,
    response: AgentResponse,
    runtime?: RuntimeStepResolution,
  ): AgentResponse {
    const normalized = this.normalizeStructuredOutputWithDiagnostics(step, response, runtime);
    if (normalized.invalidDetail !== undefined) {
      throw new Error(
        `Reviewer attempt for step "${step.name}" produced invalid structured_output: ${normalized.invalidDetail}`,
      );
    }
    return normalized.response;
  }

  finalizeObservedReviewerAttempt(input: {
    readonly eventStep: WorkflowStep;
    readonly executableStep: AgentWorkflowStep;
    readonly iteration: number;
    readonly attempt: Phase1Attempt;
    readonly response: AgentResponse;
    readonly runtime?: RuntimeStepResolution;
    readonly recordUsage?: (success: boolean, usage: AgentResponse['providerUsage']) => void;
  }): AgentResponse {
    let normalized: AgentResponse;
    try {
      normalized = this.normalizeReviewerResponse(
        input.executableStep,
        input.response,
        input.runtime,
      );
    } catch (error) {
      completeObservedPhase1Attempt({
        eventStep: input.eventStep,
        iteration: input.iteration,
        attempt: input.attempt,
        response: {
          ...input.response,
          status: 'error',
          error: getErrorMessage(error),
        },
        onPhaseComplete: this.deps.onPhaseComplete,
      });
      input.recordUsage?.(false, input.response.providerUsage);
      throw error;
    }
    completeObservedPhase1Attempt({
      eventStep: input.eventStep,
      iteration: input.iteration,
      attempt: input.attempt,
      response: normalized,
      onPhaseComplete: this.deps.onPhaseComplete,
    });
    input.recordUsage?.(normalized.status === 'done', normalized.providerUsage);
    return normalized;
  }

  private async completeReviewerCompanion(input: {
    readonly eventStep: WorkflowStep;
    readonly executableStep: AgentWorkflowStep;
    readonly state: WorkflowState;
    readonly initialResponse: AgentResponse;
    readonly agentOptions: RunAgentOptions;
    readonly runtime?: RuntimeStepResolution;
    readonly companionRuntime: CompanionStepRuntime | undefined;
    readonly providerInfo: StepProviderInfo;
    readonly nextSequence: () => number;
  }): Promise<AgentResponse> {
    if (input.companionRuntime === undefined) return input.initialResponse;
    input.companionRuntime.beginReviewAttempt();
    const fixLoop = await runCompanionFixLoop({
      initialResponse: input.initialResponse,
      phase1Options: input.agentOptions,
      completeReview: ({ implementerResponse, afterFix, fixRound }) => (
        input.companionRuntime!.complete(input.state, implementerResponse, { afterFix, fixRound })
      ),
      executeFix: async (attempt) => {
        input.companionRuntime!.beginFixRound(attempt.sequence, attempt.openMustFixCount);
        const promptResolvedAttempts = new Set<number>();
        const phaseAttempts = new Map<number, Phase1Attempt>();
        const resolvePhaseAttempt = (recoveryAttempt: Phase1Attempt): Phase1Attempt => {
          const existing = phaseAttempts.get(recoveryAttempt.sequence);
          if (existing !== undefined) return existing;
          const created = {
            ...recoveryAttempt,
            sequence: input.nextSequence(),
            reason: recoveryAttempt.reason === 'initial'
              ? 'companion_fix' as const
              : recoveryAttempt.reason,
          };
          phaseAttempts.set(recoveryAttempt.sequence, created);
          return created;
        };
        const recovery = await runPhase1WithEmptyRecovery({
          instruction: attempt.instruction,
          initialSessionId: attempt.sessionId,
          retryProviderErrorFresh: false,
          execute: async (recoveryAttempt) => {
            const phaseAttempt = resolvePhaseAttempt(recoveryAttempt);
            try {
              const observed = await executeObservedPhase1Attempt({
                enabled: this.deps.observabilityEnabled?.() === true,
                runId: this.deps.getObservabilityRunId?.(),
                workflowName: this.deps.getWorkflowName(),
                eventStep: input.eventStep,
                spanStep: input.executableStep,
                iteration: input.state.iteration,
                attempt: phaseAttempt,
                workflowStack: this.deps.getCurrentWorkflowStack?.(),
                sanitizeText: this.deps.sanitizeObservabilityText,
                providerInfo: input.providerInfo,
                execute: (instruction, sessionId, onPromptResolved) => executeAgent(
                  input.executableStep.persona,
                  instruction,
                  { ...attempt.options, sessionId, onPromptResolved },
                ),
                onPhaseStart: (...args) => {
                  promptResolvedAttempts.add(phaseAttempt.sequence);
                  this.deps.onPhaseStart?.(...args);
                },
              });
              return observed.response;
            } catch (error) {
              if (promptResolvedAttempts.has(phaseAttempt.sequence)) {
                completeObservedPhase1Attempt({
                  eventStep: input.eventStep,
                  iteration: input.state.iteration,
                  attempt: phaseAttempt,
                  response: {
                    persona: input.executableStep.persona ?? input.executableStep.name,
                    status: 'error',
                    content: '',
                    error: getErrorMessage(error),
                    timestamp: new Date(),
                  },
                  onPhaseComplete: this.deps.onPhaseComplete,
                });
              }
              this.deps.recordSynthesizedAgentUsage(
                input.eventStep.name,
                input.providerInfo,
                false,
                undefined,
              );
              throw error;
            }
          },
          discardSession: () => undefined,
          recordSupersededAttempt: (response, recoveryAttempt) => {
            const phaseAttempt = resolvePhaseAttempt(recoveryAttempt);
            if (promptResolvedAttempts.has(phaseAttempt.sequence)) {
              completeObservedPhase1Attempt({
                eventStep: input.eventStep,
                iteration: input.state.iteration,
                attempt: phaseAttempt,
                response,
                onPhaseComplete: this.deps.onPhaseComplete,
              });
            }
            this.deps.recordSynthesizedAgentUsage(
              input.eventStep.name,
              input.providerInfo,
              response.status === 'done',
              response.providerUsage,
            );
          },
        });
        const finalAttempt = resolvePhaseAttempt(recovery.finalAttempt);
        if (!promptResolvedAttempts.has(finalAttempt.sequence)) {
          throw new Error(
            `Missing prompt parts for companion fix: ${input.eventStep.name}:1:${finalAttempt.sequence}`,
          );
        }
        if (input.executableStep.completionRetry !== undefined) {
          return this.finalizeObservedReviewerAttempt({
            eventStep: input.eventStep,
            executableStep: input.executableStep,
            iteration: input.state.iteration,
            attempt: finalAttempt,
            response: recovery.response,
            runtime: input.runtime,
            recordUsage: (success, usage) => this.deps.recordSynthesizedAgentUsage(
              input.eventStep.name,
              input.providerInfo,
              success,
              usage,
            ),
          });
        }
        const normalized = this.normalizeStructuredOutputWithDiagnostics(
          input.executableStep,
          recovery.response,
          input.runtime,
        );
        if (normalized.invalidDetail !== undefined) {
          const error = new Error(
            `Companion fix for step "${input.executableStep.name}" produced invalid structured_output: ${normalized.invalidDetail}`,
          );
          completeObservedPhase1Attempt({
            eventStep: input.eventStep,
            iteration: input.state.iteration,
            attempt: finalAttempt,
            response: { ...recovery.response, status: 'error', error: error.message },
            onPhaseComplete: this.deps.onPhaseComplete,
          });
          this.deps.recordSynthesizedAgentUsage(
            input.eventStep.name,
            input.providerInfo,
            false,
            recovery.response.providerUsage,
          );
          throw error;
        }
        completeObservedPhase1Attempt({
          eventStep: input.eventStep,
          iteration: input.state.iteration,
          attempt: finalAttempt,
          response: normalized.response,
          onPhaseComplete: this.deps.onPhaseComplete,
        });
        this.deps.recordSynthesizedAgentUsage(
          input.eventStep.name,
          input.providerInfo,
          normalized.response.status === 'done',
          normalized.response.providerUsage,
        );
        return normalized.response;
      },
      abortSignal: this.resolveAbortSignal(),
      onAttemptFailure: (failure) => {
        log.warn('Companion advisory attempt failed; continuing with the latest successful response', {
          step: input.eventStep.name,
          stage: failure.stage,
          fixRound: failure.fixRound,
          sequence: failure.sequence,
          reason: failure.reason,
        });
      },
    });
    return fixLoop.phaseResponse;
  }

  private resolveDynamicFacetPool(step: NormalAgentWorkflowStep): ResolvedFacetPool | undefined {
    if (step.dynamicFacets === undefined) return undefined;
    return this.deps.getFacetPool?.(step.dynamicFacets.pool);
  }

  async prepareDynamicFacetStep(
    step: AgentWorkflowStep,
    state: WorkflowState,
    task: string,
    stepIteration: number,
    context?: DynamicFacetSelectionContext,
  ): Promise<AgentWorkflowStep> {
    if (!isNormalAgentWorkflowStep(step) || step.dynamicFacets === undefined) {
      return step;
    }
    if (this.deps.dynamicFacetSelectorCoordinator === undefined) {
      throw new Error(
        `Configuration error: step "${step.name}" has dynamic_facets but no dynamic facet selector coordinator is configured`,
      );
    }
    const pool = this.resolveDynamicFacetPool(step);
    if (pool === undefined) {
      throw new Error(
        `Configuration error: step "${step.name}" references unknown facet pool "${step.dynamicFacets.pool}"`,
      );
    }
    const result = await this.deps.dynamicFacetSelectorCoordinator.resolveDynamicFacets(
      step,
      state,
      task,
      pool,
      { ...context, stepIteration },
    );
    return {
      ...step,
      policyContents: result.effectivePolicyContents.map((content) => ({ content })),
      knowledgeContents: result.effectiveKnowledgeContents.map((content) => ({ content })),
    } as AgentWorkflowStep;
  }

  private writeSnapshot(
    content: string,
    directoryRel: string,
    filename: string,
    transaction?: InstructionBuildTransaction,
  ): string {
    const absPath = join(this.deps.getCwd(), directoryRel, filename);
    transaction?.recordSnapshotWrite(absPath);
    writeFileSync(absPath, content, 'utf-8');
    return `${directoryRel}/${filename}`;
  }

  private writeFacetSnapshot(
    facet: 'knowledge' | 'policy',
    stepName: string,
    stepIteration: number,
    contents: readonly ResolvedFacetContent[] | undefined,
    transaction?: InstructionBuildTransaction,
  ): { content: string[]; sourcePath: string } | undefined {
    if (!contents || contents.length === 0) return undefined;
    const contentStrings = contents.map((c) => c.content);
    const merged = contentStrings.join('\n\n---\n\n');
    const timestamp = StepExecutor.buildTimestamp();
    const runPaths = this.deps.getRunPaths();
    const directoryRel = facet === 'knowledge'
      ? runPaths.contextKnowledgeRel
      : runPaths.contextPolicyRel;
    const sourcePath = this.writeSnapshot(
      merged,
      directoryRel,
      StepExecutor.buildSnapshotFileName(stepName, stepIteration, timestamp),
      transaction,
    );
    return { content: [merged], sourcePath };
  }

  private ensurePreviousResponseSnapshot(
    state: WorkflowState,
    stepName: string,
    stepIteration: number,
    transaction?: InstructionBuildTransaction,
  ): void {
    if (!state.lastOutput || state.previousResponseSourcePath) return;
    const timestamp = StepExecutor.buildTimestamp();
    const runPaths = this.deps.getRunPaths();
    const fileName = StepExecutor.buildSnapshotFileName(stepName, stepIteration, timestamp);
    const sourcePath = this.writeSnapshot(
      state.lastOutput.content,
      runPaths.contextPreviousResponsesRel,
      fileName,
      transaction,
    );
    this.writeSnapshot(
      state.lastOutput.content,
      runPaths.contextPreviousResponsesRel,
      'latest.md',
      transaction,
    );
    state.previousResponseSourcePath = sourcePath;
  }

  persistPreviousResponseSnapshot(
    state: WorkflowState,
    stepName: string,
    stepIteration: number,
    content: string,
  ): void {
    const timestamp = StepExecutor.buildTimestamp();
    const runPaths = this.deps.getRunPaths();
    const fileName = StepExecutor.buildSnapshotFileName(stepName, stepIteration, timestamp);
    const sourcePath = this.writeSnapshot(content, runPaths.contextPreviousResponsesRel, fileName);
    this.writeSnapshot(content, runPaths.contextPreviousResponsesRel, 'latest.md');
    state.previousResponseSourcePath = sourcePath;
  }

  buildPhase1Instruction(
    instruction: string,
    step: WorkflowStep,
    runtime?: RuntimeStepResolution,
  ): string {
    const provider = this.deps.optionsBuilder.resolveStepProviderModel(step, runtime).provider;
    assertProviderResolvedForCapabilitySensitiveOptions(provider, {
      stepName: step.name,
      usesStructuredOutput: step.structuredOutput !== undefined,
    });
    const supportsStructuredOutput = providerSupportsStructuredOutput(provider);
    if (!step.structuredOutput || supportsStructuredOutput !== false) {
      return instruction;
    }

    return buildStructuredJsonSchemaInstruction(
      instruction,
      step.structuredOutput.schema,
      this.deps.getLanguage() ?? 'en',
    );
  }

  async prepareNormalStepExecution(
    step: WorkflowStep,
    state: WorkflowState,
    task: string,
    maxSteps: number | 'infinite',
    stepIteration: number,
    runtime?: RuntimeStepResolution,
  ): Promise<PreparedNormalStepExecution> {
    const executableStep = await this.prepareDynamicFacetStep(
      step as AgentWorkflowStep,
      state,
      task,
      stepIteration,
    );
    const instruction = this.buildInstruction(
      executableStep,
      stepIteration,
      state,
      task,
      maxSteps,
      fallbackContextForOperation(
        runtime,
        reviewerOperationOrigin(step.name),
      ),
    );

    return {
      executableStep,
      phase1Instruction: this.buildPhase1Instruction(
        instruction,
        executableStep,
        runtime,
      ),
      ...(state.lastOutput?.content !== undefined ? { priorStepResponseText: state.lastOutput.content } : {}),
      stepIteration,
    };
  }

  /**
   * 実行ループを通らない合成ステップ
   * の LLM 呼び出しを usage-events へ記録する。通常ステップは step:complete
   * イベント経由、parallel / team_leader は recordDelegatedAgentUsage 経由で
   * 記録されるが、合成ステップの executeAgent 直呼びはどちらの経路にも
   * 乗らず、トークン集計の死角になっていた。
   *
   * `attemptProviderInfo` は、その呼び出しが実際に使った provider/model。
   * report phase の fallback のように attempt ごとに provider が変わる経路では
   * これを渡さないと、fallback で走った試行を primary として計上してしまう。
   * 単発呼び出しでは省略でき、ステップ解決結果を使う。
   */
  recordSynthesizedAgentUsage(
    step: WorkflowStep,
    success: boolean,
    usage: ProviderUsageSnapshot | undefined,
    attemptProviderInfo?: StepProviderInfo,
  ): void {
    this.deps.recordSynthesizedAgentUsage(
      step.name,
      attemptProviderInfo ?? this.deps.optionsBuilder.resolveStepProviderModel(step),
      success,
      usage,
    );
  }

  normalizeStructuredOutput(
    step: WorkflowStep,
    response: AgentResponse,
    runtime?: RuntimeStepResolution,
  ): AgentResponse {
    const result = this.normalizeStructuredOutputWithDiagnostics(step, response, runtime);
    if (result.invalidDetail !== undefined) {
      const provider = this.deps.optionsBuilder.resolveStepProviderModel(step, runtime).provider;
      throw new Error(
        `Step "${step.name}" requires structured_output for provider "${provider}": ${result.invalidDetail}`,
      );
    }
    return result.response;
  }

  normalizeStructuredOutputWithDiagnostics(
    step: WorkflowStep,
    response: AgentResponse,
    runtime?: RuntimeStepResolution,
  ): StructuredOutputNormalizationResult {
    if (StepExecutor.isProviderStreamParseFailure(response)) {
      return { response };
    }
    if (!step.structuredOutput) {
      return { response };
    }

    const provider = this.deps.optionsBuilder.resolveStepProviderModel(step, runtime).provider;
    assertProviderResolvedForCapabilitySensitiveOptions(provider, {
      stepName: step.name,
      usesStructuredOutput: true,
    });
    const supportsStructuredOutput = providerSupportsStructuredOutput(provider);

    if (response.status !== 'done') {
      const detail = response.error ?? response.content;
      const failureReason = this.resolveStructuredOutputFailureReason(response);
      const fallback = this.buildStructuredOutputFailureFallback(
        step,
        response,
        failureReason,
        detail,
      );
      if (fallback) {
        return { response: fallback };
      }
      this.logStructuredOutputFailure(step, failureReason, detail);
      return { response };
    }

    try {
      let structuredOutput = response.structuredOutput;
      if (structuredOutput === undefined) {
        if (supportsStructuredOutput !== false) {
          throw new Error('Structured output response is missing');
        }
        structuredOutput = parseStructuredOutputObject(response.content);
      }

      const validationSchema = step.structuredOutput.validationSchema
        ?? step.structuredOutput.schema;
      validateStructuredOutputAgainstSchema(structuredOutput, validationSchema);
      structuredOutput = this.structuredOutputNormalizers.normalize(structuredOutput, {
        step,
        language: this.deps.getLanguage(),
      });
      validateStructuredOutputAgainstSchema(structuredOutput, validationSchema);
      if (structuredOutput === response.structuredOutput) {
        return { response };
      }
      return {
        response: {
          ...response,
          structuredOutput,
        },
      };
    } catch (error) {
      const detail = getErrorMessage(error);
      const failureReason = supportsStructuredOutput !== false
        && response.structuredOutput === undefined
        ? 'missing'
        : 'schema_error';
      const fallback = this.buildStructuredOutputFailureFallback(
        step,
        response,
        failureReason,
        detail,
      );
      if (fallback) {
        return { response: fallback };
      }
      this.logStructuredOutputFailure(step, failureReason, detail);
      return {
        response,
        invalidDetail: detail,
        invalidKind: error instanceof StructuredOutputSchemaError
          ? 'schema_config'
          : 'model_output',
        ...(error instanceof StructuredOutputValueValidationError
          ? { invalidIssues: error.issues }
          : {}),
      };
    }
  }

  private buildStructuredOutputFailureFallback(
    step: WorkflowStep,
    response: AgentResponse,
    failureReason: StructuredOutputFailureReason,
    detail: string,
  ): AgentResponse | undefined {
    const structuredOutputConfig = step.structuredOutput;
    if (structuredOutputConfig === undefined) {
      return undefined;
    }

    return this.structuredOutputNormalizers.buildFailureFallback({
      step,
      response,
      failureReason,
      detail,
      language: this.deps.getLanguage(),
      validate: (value) => validateStructuredOutputAgainstSchema(
        value,
        structuredOutputConfig.validationSchema ?? structuredOutputConfig.schema,
      ),
    });
  }

  private resolveStructuredOutputFailureReason(response: AgentResponse): StructuredOutputFailureReason {
    if (
      response.failureCategory === AGENT_FAILURE_CATEGORIES.STREAM_IDLE_TIMEOUT
      || response.failureCategory === AGENT_FAILURE_CATEGORIES.PART_TIMEOUT
    ) {
      return 'timeout';
    }
    if (response.status === 'error') {
      return 'provider_error';
    }
    return response.structuredOutput === undefined ? 'missing' : 'schema_error';
  }

  private logStructuredOutputFailure(
    step: WorkflowStep,
    failureReason: StructuredOutputFailureReason,
    detail: string,
  ): void {
    log.info('Structured output failed', {
      step: step.name,
      used_structured_output: false,
      structured_output_failure_reason: failureReason,
      error: detail,
    });
  }

  /** Build Phase 1 instruction from template */
  buildInstruction(
    step: WorkflowStep,
    stepIteration: number,
    state: WorkflowState,
    task: string,
    maxSteps: number | 'infinite',
    fallbackContext?: FallbackContext,
    transaction?: InstructionBuildTransaction,
  ): string {
    this.ensurePreviousResponseSnapshot(state, step.name, stepIteration, transaction);
    const policySnapshot = this.writeFacetSnapshot(
      'policy',
      step.name,
      stepIteration,
      step.policyContents,
      transaction,
    );
    const knowledgeSnapshot = this.writeFacetSnapshot(
      'knowledge',
      step.name,
      stepIteration,
      step.knowledgeContents,
      transaction,
    );
    const workflowSteps = this.deps.getWorkflowSteps();
    const reportDir = join(this.deps.getCwd(), this.deps.getReportDir());
    // workflow_call の子（subworkflows 名前空間）の {report:X} が親成果物へ
    // read-only フォールバックするための reports ルート。engine の runPaths から
    // 明示的に渡す（リゾルバ側でパス文字列から推測しない）。
    const reportsRootDir = this.deps.getRunPaths().reportsRootAbs;
    const instruction = new InstructionBuilder(step, {
      task,
      iteration: state.iteration,
      maxSteps,
      stepIteration,
      cwd: this.deps.getCwd(),
      projectCwd: this.deps.getProjectCwd(),
      userInputs: state.userInputs,
      previousOutput: getPreviousOutput(state),
      reportDir,
      reportsRootDir,
      language: this.deps.getLanguage(),
      interactive: this.deps.getInteractive(),
      workflowSteps,
      currentStepIndex: workflowSteps.findIndex(s => s.name === step.name),
      workflowName: this.deps.getWorkflowName(),
      workflowDescription: this.deps.getWorkflowDescription(),
      workflowCallVars: this.deps.getWorkflowCallVars?.(),
      retryNote: this.deps.getRetryNote(),
      prContext: this.deps.getPrContext?.(),
      reviewScope: this.deps.getReviewScope(),
      policyContents: policySnapshot
        ? policySnapshot.content.map((content) => ({ content, sourcePath: policySnapshot.sourcePath }))
        : step.policyContents,
      policySourcePath: policySnapshot?.sourcePath,
      knowledgeContents: knowledgeSnapshot
        ? knowledgeSnapshot.content.map((content) => ({ content, sourcePath: knowledgeSnapshot.sourcePath }))
        : step.knowledgeContents,
      knowledgeSourcePath: knowledgeSnapshot?.sourcePath,
      previousResponseSourcePath: state.previousResponseSourcePath,
      fallbackContext,
      workflowState: state,
      ...(!this.deps.companionEnabled
        || !isNormalAgentWorkflowStep(step)
        || step.companion === undefined
        ? {}
        : {
            companion: {
              mailboxDirectory: buildCompanionMailboxDirectory({
                cwd: this.deps.getCwd(),
                runSlug: this.deps.getRunId(),
                runPathNamespace: this.deps.getRunPathNamespace(),
                stepName: step.name,
              }),
            },
          }),
    }).build();
    return instruction;
  }

  /**
   * Apply shared post-execution phases (Phase 2/3 + fallback rule evaluation).
   *
   * This method is intentionally reusable by non-normal step runners
   * (e.g., team_leader) so rule/report behavior stays consistent.
   */
  async applyPostExecutionPhases(
    step: WorkflowStep,
    state: WorkflowState,
    stepIteration: number,
    response: AgentResponse,
    updatePersonaSession: (persona: string, sessionId: string | undefined) => void,
    runtime?: RuntimeStepResolution,
    onProviderAttempt?: BasePhaseRunnerContext['onProviderAttempt'],
    onTerminalOperation?: (
      terminalOperation: NonNullable<StepRunResult['terminalOperation']>,
    ) => void,
    phase2Diagnostic?: string,
  ): Promise<AgentResponse> {
    let nextResponse = response;

    if (nextResponse.status === 'error' || nextResponse.status === 'blocked' || nextResponse.status === 'rate_limited') {
      return nextResponse;
    }

    const recordPhaseProviderAttempt = onProviderAttempt
      ?? ((providerInfo, success, usage) => {
        this.deps.recordSynthesizedAgentUsage(
          step.name,
          providerInfo,
          success,
          usage,
        );
      });
    const basePhaseContext = this.deps.optionsBuilder.buildPhaseRunnerContext(
      step,
      state,
      nextResponse.content,
      updatePersonaSession,
      this.deps.onPhaseStart,
      this.deps.onPhaseComplete,
      this.deps.onJudgeStage,
      state.iteration,
      runtime,
      recordPhaseProviderAttempt,
    );
    const phaseCtx = phase2Diagnostic === undefined
      ? basePhaseContext
      : { ...basePhaseContext, completionRetryDiagnostic: phase2Diagnostic };

    // Phase 2: report output (resume same session, Write only)
    // Report generation is only valid after a completed Phase 1 response.
    if (nextResponse.status === 'done' && step.outputContracts && step.outputContracts.length > 0) {
      try {
        const reportResult = await runReportPhase(step, stepIteration, phaseCtx);
        if (reportResult && 'blocked' in reportResult) {
          onTerminalOperation?.({
            origin: reviewerOperationOrigin(step.name),
            providerInfo: reportResult.providerInfo,
          });
          nextResponse = { ...nextResponse, status: 'blocked', content: reportResult.response.content };
          return nextResponse;
        }
        if (reportResult && 'rateLimited' in reportResult) {
          onTerminalOperation?.({
            origin: reviewerOperationOrigin(step.name),
            providerInfo: reportResult.providerInfo,
          });
          return {
            ...reportResult.response,
            persona: step.name,
          };
        }
      } catch (reportError) {
        if (reportError instanceof ReportPhaseGenerationError) {
          if (reportError.failureCategory === AGENT_FAILURE_CATEGORIES.PROVIDER_STREAM_PARSE_ERROR) {
            throw createProviderStreamParseError(reportError.failureMessage ?? getErrorMessage(reportError));
          }
          log.info('Report phase failed, continuing to status judgment', {
            step: step.name,
            error: getErrorMessage(reportError),
          });
        } else {
          throw reportError;
        }
      }
    }

    return this.applyPostExecutionRules(
      step,
      state,
      nextResponse,
      () => this.deps.optionsBuilder.buildPhaseRunnerContext(
        step,
        state,
        nextResponse.content,
        updatePersonaSession,
        this.deps.onPhaseStart,
        this.deps.onPhaseComplete,
        this.deps.onJudgeStage,
        state.iteration,
        runtime,
        recordPhaseProviderAttempt,
      ),
    );
  }

  private async applyPostExecutionRules(
    step: WorkflowStep,
    state: WorkflowState,
    response: AgentResponse,
    phaseContext: () => StatusJudgmentPhaseContext,
  ): Promise<AgentResponse> {
    if (response.structuredOutput) {
      state.structuredOutputs.set(step.name, response.structuredOutput);
    }
    const match = await evaluatePostExecutionRules(step, phaseContext, {
      state,
      interactive: this.deps.getInteractive(),
    });
    if (match) {
      log.debug('Rule matched', { step: step.name, ruleIndex: match.index, method: match.method });
      return {
        ...response,
        matchedRuleIndex: match.index,
        matchedRuleMethod: match.method,
      };
    }
    return response;
  }

  async applyPostExecutionRulesOnly(
    step: WorkflowStep,
    state: WorkflowState,
    response: AgentResponse,
    updatePersonaSession: (persona: string, sessionId: string | undefined) => void,
    runtime?: RuntimeStepResolution,
  ): Promise<AgentResponse> {
    return this.applyPostExecutionRules(
      step,
      state,
      response,
      () => this.deps.optionsBuilder.buildPhaseRunnerContext(
        step,
        state,
        response.content,
        updatePersonaSession,
        this.deps.onPhaseStart,
        this.deps.onPhaseComplete,
        this.deps.onJudgeStage,
        state.iteration,
        runtime,
      ),
    );
  }

  /**
   * Execute a normal (non-parallel) step through all 3 phases.
   *
   * Returns the final response (with matchedRuleIndex if a rule matched)
   * and the instruction used for Phase 1.
   */
  async runNormalStep(
    step: WorkflowStep,
    state: WorkflowState,
    task: string,
    maxSteps: number | 'infinite',
    updatePersonaSession: (persona: string, sessionId: string | undefined) => void,
    prebuiltInstruction?: string,
    runtime?: RuntimeStepResolution,
    preparedExecution?: PreparedNormalStepExecution,
  ): Promise<StepRunResult> {
    await waitForStepDelay(step);
    const stepIteration = preparedExecution?.stepIteration ?? (prebuiltInstruction
      ? state.stepIterations.get(step.name) ?? 1
      : incrementStepIteration(state, step.name));

    const executableStep = preparedExecution?.executableStep ?? step as AgentWorkflowStep;
    const executionRuntime = runtime;

    const instruction = preparedExecution?.phase1Instruction
      ?? prebuiltInstruction
      ?? this.buildInstruction(
        executableStep,
        stepIteration,
        state,
        task,
        maxSteps,
      );
    const phase1Instruction = preparedExecution?.phase1Instruction
      ?? this.buildPhase1Instruction(instruction, executableStep, executionRuntime);
    const providerInfo = this.deps.optionsBuilder.resolveStepProviderModel(
      executableStep,
      executionRuntime,
    );
    const sessionKey = buildSessionKey(executableStep, {
      provider: providerInfo.provider,
      model: providerInfo.model,
    });
    log.debug('Running step', {
      step: step.name,
      persona: step.persona ?? '(none)',
      stepIteration,
      iteration: state.iteration,
      sessionId: state.personaSessions.get(sessionKey) ?? 'new',
    });

    // Phase 1: main execution (Write excluded if step has report)
    let companionRuntime: CompanionStepRuntime | undefined;
    if (isNormalAgentWorkflowStep(executableStep)) {
      if (!this.deps.companionEnabled && executableStep.companion !== undefined) {
        emitCompanionReviewSkippedSafely(this.deps.emitEvent, {
          step: step.name,
          phase: 'initial',
          reason: 'companion_disabled',
          runPathNamespace: [...this.deps.getRunPathNamespace()],
        });
      } else if (this.deps.companionEnabled && executableStep.companion === undefined) {
        emitCompanionReviewSkippedSafely(this.deps.emitEvent, {
          step: step.name,
          phase: 'initial',
          reason: 'companion_not_configured',
          runPathNamespace: [...this.deps.getRunPathNamespace()],
        });
      }
    }
    if (
      this.deps.companionEnabled
      && isNormalAgentWorkflowStep(executableStep)
      && executableStep.companion !== undefined
    ) {
      const companionDefinitions = this.deps.companionDefinitions;
      const companionProviders = this.deps.companionProviders;
      const companionDiffReader = this.deps.companionDiffReader;
      const companionReviewState = this.companionReviewState;
      state.companion = {
        escalated: false,
        completionVerified: false,
        openMustFixCount: 0,
        openMustFix: [],
      };
      try {
        if (
          companionDefinitions === undefined
          || companionProviders === undefined
          || companionDiffReader === undefined
          || companionReviewState === undefined
        ) {
          throw new Error(`Companion runtime configuration is missing for step "${step.name}"`);
        }
        companionRuntime = await CompanionStepRuntime.create({
          cwd: this.deps.getCwd(),
          projectCwd: this.deps.getProjectCwd(),
          failureDir: this.deps.getFailureDir(),
          runSlug: this.deps.getRunId(),
          runPathNamespace: this.deps.getRunPathNamespace(),
          language: this.deps.getLanguage() ?? 'en',
          task,
          step: executableStep,
          definitions: companionDefinitions,
          providers: companionProviders,
          selectorProvider: this.deps.companionSelectorProvider,
          diffReader: companionDiffReader,
          abortSignal: this.resolveAbortSignal(),
          stateStore: companionReviewState,
          emitEvent: this.deps.emitEvent,
          recordUsage: (name, companionProvider, success, usage) => {
            this.deps.recordSynthesizedAgentUsage(
              `companion:${name}`,
              {
                provider: companionProvider.provider,
                model: companionProvider.model,
                providerOptions: companionProvider.providerOptions,
              },
              success,
              usage,
            );
          },
        });
      } catch (error) {
        this.resolveAbortSignal()?.throwIfAborted();
        const reason = safeExternalErrorMessage(error);
        state.companion = {
          ...requireActiveCompanionState(state, step.name),
          completionFailure: true,
          reason,
        };
        emitCompanionReviewSkippedSafely(this.deps.emitEvent, {
          step: step.name,
          phase: 'initial',
          reason: 'companion_runtime_unavailable',
          runPathNamespace: [...this.deps.getRunPathNamespace()],
        });
        log.warn(
          `Companion startup failed for "${step.name}"; main step will continue without completion review: ${reason}`,
        );
      }
    }
    using activeCompanionRuntime = companionRuntime;
    const builtAgentOptions = this.deps.optionsBuilder.buildAgentOptions(
      executableStep,
      executionRuntime,
    );
    const baseAgentOptions = activeCompanionRuntime?.composeOptions(builtAgentOptions)
      ?? builtAgentOptions;
    const compactionOutcome = await compactSessionBeforePhase1(executableStep, baseAgentOptions);
    if (compactionOutcome === 'fresh') {
      invalidatePersonaSessionIfExpected(
        state,
        sessionKey,
        baseAgentOptions.sessionId,
        updatePersonaSession,
      );
    }
    const agentOptions: RunAgentOptions = {
      ...baseAgentOptions,
      ...(compactionOutcome === 'fresh' ? { sessionId: undefined } : {}),
    };
    const promptResolvedAttempts = new Set<number>();
    const phase1Result = await runPhase1WithEmptyRecovery({
      instruction: phase1Instruction,
      initialSessionId: executableStep.internalFreshSession === true
        ? undefined
        : agentOptions.sessionId,
      retryProviderErrorFresh: false,
      execute: async (attempt) => {
        const result = await executeObservedPhase1Attempt({
          enabled: this.deps.observabilityEnabled?.() === true,
          runId: this.deps.getObservabilityRunId?.(),
          workflowName: this.deps.getWorkflowName(),
          eventStep: step,
          spanStep: executableStep,
          iteration: state.iteration,
          attempt,
          workflowStack: this.deps.getCurrentWorkflowStack?.(),
          sanitizeText: this.deps.sanitizeObservabilityText,
          providerInfo,
          execute: (attemptInstruction, sessionId, onPromptResolved) => (
            executableStep.internalFreshSession === true
              ? executeStructuredTextAgent(attemptInstruction, {
                  name: executableStep.name,
                  cwd: agentOptions.cwd,
                  projectCwd: agentOptions.projectCwd,
                  persona: executableStep.persona,
                  personaPath: agentOptions.personaPath,
                  workflowBundleResourceRoot: agentOptions.workflowBundleResourceRoot,
                  resolution: {
                    provider: requireStructuredAgentProvider(
                      providerInfo.provider,
                      executableStep.name,
                    ),
                    model: providerInfo.model,
                    providerOptions: providerInfo.providerOptions,
                    permissionMode: agentOptions.permissionMode,
                  },
                  language: agentOptions.language,
                  abortSignal: agentOptions.abortSignal,
                  childProcessEnv: agentOptions.childProcessEnv,
                  failureDir: agentOptions.failureDir,
                  onStream: agentOptions.onStream,
                  onPromptResolved,
                  workflowMeta: agentOptions.workflowMeta,
                }).then((response) => {
                  const freshResponse = { ...response };
                  delete freshResponse.sessionId;
                  return freshResponse;
                }).catch((error: unknown) => {
                  if (
                    !(error instanceof StructuredAgentResponseError)
                    || error.response.status === 'done'
                  ) {
                    throw error;
                  }
                  const failedResponse = { ...error.response };
                  delete failedResponse.sessionId;
                  return failedResponse;
                })
              : executeAgent(
                  executableStep.persona,
                  attemptInstruction,
                  {
                    ...agentOptions,
                    sessionId,
                    onPromptResolved,
                  },
                )
          ),
          onPhaseStart: this.deps.onPhaseStart,
          ...(executableStep.completionRetry === undefined
            ? {}
            : {
                onPhaseComplete: this.deps.onPhaseComplete,
                failurePersona: executableStep.persona ?? executableStep.name,
                recordFailure: () => this.deps.recordSynthesizedAgentUsage(
                  step.name,
                  providerInfo,
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
        if (executableStep.internalFreshSession === true) {
          return;
        }
        invalidatePersonaSessionIfExpected(
          state,
          sessionKey,
          sessionId,
          updatePersonaSession,
        );
      },
      recordSupersededAttempt: (supersededResponse, attempt) => {
        if (promptResolvedAttempts.has(attempt.sequence)) {
          completeObservedPhase1Attempt({
            eventStep: step,
            iteration: state.iteration,
            attempt,
            response: supersededResponse,
            onPhaseComplete: this.deps.onPhaseComplete,
          });
        }
        this.deps.recordSynthesizedAgentUsage(
          step.name,
          providerInfo,
          supersededResponse.status === 'done',
          supersededResponse.providerUsage,
        );
      },
    });
    let response = phase1Result.response;
    if (!promptResolvedAttempts.has(phase1Result.finalAttempt.sequence)) {
      throw new Error(`Missing prompt parts for phase start: ${step.name}:1`);
    }
    if (response.error === PHASE1_EMPTY_OUTPUT_ERROR) {
      log.info('Phase 1 returned empty output, treating as error', { step: step.name });
    }

    if (executableStep.completionRetry === undefined) {
      const normalizedPhase1 = this.normalizeStructuredOutputWithDiagnostics(
        executableStep,
        response,
        executionRuntime,
      );
      if (normalizedPhase1.invalidDetail !== undefined) {
        const provider = this.deps.optionsBuilder
          .resolveStepProviderModel(executableStep, runtime)
          .provider;
        throw new Error(
          `Step "${executableStep.name}" requires structured_output for provider "${provider}": ${normalizedPhase1.invalidDetail}`,
        );
      }
      response = normalizedPhase1.response;
      if (executableStep.internalFreshSession !== true && response.sessionId !== undefined) {
        updatePersonaSession(sessionKey, response.sessionId);
      }
      completeObservedPhase1Attempt({
        eventStep: step,
        iteration: state.iteration,
        attempt: phase1Result.finalAttempt,
        response,
        onPhaseComplete: this.deps.onPhaseComplete,
      });
    } else {
      response = this.finalizeObservedReviewerAttempt({
        eventStep: step,
        executableStep,
        iteration: state.iteration,
        attempt: phase1Result.finalAttempt,
        response,
        runtime: executionRuntime,
      });
      if (response.sessionId !== undefined) {
        updatePersonaSession(sessionKey, response.sessionId);
      }
    }

    // Provider failures should abort immediately.
    if (response.status === 'error' || response.status === 'rate_limited') {
      state.stepOutputs.set(step.name, response);
      state.lastOutput = response;
      return { response, instruction: phase1Instruction, providerInfo };
    }

    // Blocked responses should be handled by WorkflowEngine's blocked flow.
    // Persist snapshot so re-execution receives the latest blocked context.
    if (response.status === 'blocked') {
      state.stepOutputs.set(step.name, response);
      state.lastOutput = response;
      this.persistPreviousResponseSnapshot(state, step.name, stepIteration, response.content);
      return { response, instruction: phase1Instruction, providerInfo };
    }

    let reviewerPhaseExecutionSequence = phase1Result.finalAttempt.sequence + 1;
    response = await this.completeReviewerCompanion({
      eventStep: step,
      executableStep,
      state,
      initialResponse: response,
      agentOptions,
      runtime: executionRuntime,
      companionRuntime: activeCompanionRuntime,
      providerInfo,
      nextSequence: () => reviewerPhaseExecutionSequence++,
    });
    if (response.sessionId !== undefined) {
      updatePersonaSession(sessionKey, response.sessionId);
    }
    if (response.status === 'error' || response.status === 'rate_limited') {
      state.stepOutputs.set(step.name, response);
      state.lastOutput = response;
      return { response, instruction: phase1Instruction, providerInfo };
    }
    if (response.status === 'blocked') {
      state.stepOutputs.set(step.name, response);
      state.lastOutput = response;
      this.persistPreviousResponseSnapshot(state, step.name, stepIteration, response.content);
      return { response, instruction: phase1Instruction, providerInfo };
    }
    let completionRetryDiagnostic: string | undefined;
    if (executableStep.completionRetry !== undefined) {
      const completion = await this.completeReviewerResponse({
        step: executableStep,
        originalInstruction: phase1Instruction,
        initialResponse: response,
        executeRetry: async (retryInstruction, retrySessionId) => {
          const observedAttempts = new Map<number, Phase1Attempt>();
          const resolveObservedAttempt = (attempt: Phase1Attempt): Phase1Attempt => {
            const existing = observedAttempts.get(attempt.sequence);
            if (existing !== undefined) return existing;
            const created = { ...attempt, sequence: reviewerPhaseExecutionSequence++ };
            observedAttempts.set(attempt.sequence, created);
            return created;
          };
          const retryResponse = await runPhase1WithEmptyRecovery({
            instruction: retryInstruction,
            initialSessionId: retrySessionId,
            retryProviderErrorFresh: false,
            execute: async (attempt) => {
              const observedAttempt = resolveObservedAttempt(attempt);
              const observed = await executeObservedPhase1Attempt({
                enabled: this.deps.observabilityEnabled?.() === true,
                runId: this.deps.getObservabilityRunId?.(),
                workflowName: this.deps.getWorkflowName(),
                eventStep: step,
                spanStep: executableStep,
                iteration: state.iteration,
                attempt: observedAttempt,
                workflowStack: this.deps.getCurrentWorkflowStack?.(),
                sanitizeText: this.deps.sanitizeObservabilityText,
                providerInfo,
                execute: (attemptInstruction, attemptSessionId, onPromptResolved) => executeAgent(
                  executableStep.persona,
                  attemptInstruction,
                  { ...agentOptions, sessionId: attemptSessionId, onPromptResolved },
                ),
                onPhaseStart: this.deps.onPhaseStart,
                onPhaseComplete: this.deps.onPhaseComplete,
                failurePersona: executableStep.persona ?? executableStep.name,
                recordFailure: () => this.deps.recordSynthesizedAgentUsage(
                  step.name,
                  providerInfo,
                  false,
                  undefined,
                ),
              });
              return observed.response;
            },
            discardSession: () => undefined,
            recordSupersededAttempt: (supersededResponse, attempt) => {
              completeObservedPhase1Attempt({
                eventStep: step,
                iteration: state.iteration,
                attempt: resolveObservedAttempt(attempt),
                response: supersededResponse,
                onPhaseComplete: this.deps.onPhaseComplete,
              });
              this.deps.recordSynthesizedAgentUsage(
                step.name,
                providerInfo,
                supersededResponse.status === 'done',
                supersededResponse.providerUsage,
              );
            },
          });
          const normalized = this.finalizeObservedReviewerAttempt({
            eventStep: step,
            executableStep,
            iteration: state.iteration,
            attempt: resolveObservedAttempt(retryResponse.finalAttempt),
            response: retryResponse.response,
            runtime: executionRuntime,
            recordUsage: (success, usage) => this.deps.recordSynthesizedAgentUsage(
              step.name,
              providerInfo,
              success,
              usage,
            ),
          });
          return this.completeReviewerCompanion({
            eventStep: step,
            executableStep,
            state,
            initialResponse: normalized,
            agentOptions,
            runtime: executionRuntime,
            companionRuntime: activeCompanionRuntime,
            providerInfo,
            nextSequence: () => reviewerPhaseExecutionSequence++,
          });
        },
      });
      response = completion.response;
      updatePersonaSession(sessionKey, completion.reviewerSessionId);
      completionRetryDiagnostic = completion.diagnostic === undefined
        ? undefined
        : formatCompletionRetryDiagnostic(completion.diagnostic, this.deps.getLanguage());
      if (response.status === 'error' || response.status === 'rate_limited' || response.status === 'blocked') {
        state.stepOutputs.set(step.name, response);
        state.lastOutput = response;
        return { response, instruction: phase1Instruction, providerInfo };
      }
    }

    let terminalOperation: StepRunResult['terminalOperation'];
    try {
      response = await this.applyPostExecutionPhases(
        step,
        state,
        stepIteration,
        response,
        updatePersonaSession,
        executionRuntime,
        undefined,
        (operation) => {
          terminalOperation = operation;
        },
        completionRetryDiagnostic,
      );
    } catch (error) {
      if (error instanceof RuleDetectionExhaustedError) {
        invalidateExpectedPersonaSession(
          state,
          sessionKey,
          response,
          baseAgentOptions.sessionId,
          updatePersonaSession,
        );
      }
      throw error;
    }

    state.stepOutputs.set(step.name, response);
    state.lastOutput = response;
    if (response.status === 'rate_limited') {
      return {
        response,
        instruction: phase1Instruction,
        providerInfo,
        ...(terminalOperation !== undefined ? { terminalOperation } : {}),
      };
    }
    this.persistPreviousResponseSnapshot(state, step.name, stepIteration, response.content);
    this.emitStepReports(
      step,
      {
        iteration: state.iteration,
        resumeStepName: step.name,
        stepIteration,
        providerInfo,
      },
    );
    return {
      response,
      instruction: phase1Instruction,
      providerInfo,
      ...(terminalOperation !== undefined ? { terminalOperation } : {}),
    };
  }

  private createReportExecutionContext(input: {
    readonly iteration: number;
    readonly resumeStepName: string;
    readonly stepIteration: number;
    readonly providerInfo: StepProviderInfo;
  }): WorkflowStepExecutionEventContext {
    const workflowStack = requireWorkflowResumeStackSnapshot(
      this.deps.getCurrentWorkflowStack?.(),
    );
    const provider = input.providerInfo.provider
      ?? this.deps.executionProvider;
    if (provider === undefined) {
      throw new Error(
        `Step report "${input.resumeStepName}" has no resolved provider`,
      );
    }
    const model = input.providerInfo.modelSource !== undefined
      ? input.providerInfo.model ?? '(default)'
      : input.providerInfo.model
        ?? (
          provider === this.deps.executionProvider
            ? this.deps.executionModel
            : undefined
        )
        ?? '(default)';
    return Object.freeze({
      iteration: input.iteration,
      workflowName: this.deps.getWorkflowName(),
      resumeStepName: input.resumeStepName,
      stepIteration: input.stepIteration,
      providerInfo: Object.freeze({ ...input.providerInfo }),
      provider,
      model,
      workflowStack,
    });
  }

  /** Collect step:report events for each report file that exists */
  emitStepReports(
    step: WorkflowStep,
    execution: {
      readonly iteration: number;
      readonly resumeStepName: string;
      readonly stepIteration: number;
      readonly providerInfo: StepProviderInfo;
    },
  ): void {
    if (!step.outputContracts || step.outputContracts.length === 0) return;
    const context = this.createReportExecutionContext(execution);
    const baseDir = join(this.deps.getCwd(), this.deps.getReportDir());

    for (const entry of step.outputContracts) {
      const fileName = entry.name;
      this.checkReportFile(step, baseDir, fileName, context);
    }
  }

  // Collects report file paths that exist (used by WorkflowEngine to emit events)
  private reportFiles: Array<{
    step: WorkflowStep;
    filePath: string;
    fileName: string;
    context: WorkflowStepExecutionEventContext;
  }> = [];

  /** Check if report file exists and collect for emission */
  private checkReportFile(
    step: WorkflowStep,
    baseDir: string,
    fileName: string,
    context: WorkflowStepExecutionEventContext,
  ): void {
    const filePath = join(baseDir, fileName);
    if (existsSync(filePath)) {
      this.reportFiles.push({ step, filePath, fileName, context });
    }
  }

  /** Drain collected report files (called by engine after step execution) */
  drainReportFiles(): Array<{
    step: WorkflowStep;
    filePath: string;
    fileName: string;
    context: WorkflowStepExecutionEventContext;
  }> {
    const files = this.reportFiles;
    this.reportFiles = [];
    return files;
  }

}
