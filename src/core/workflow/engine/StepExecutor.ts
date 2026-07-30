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
  FindingContractConfig,
  Language,
  FallbackContext,
  WorkflowConfig,
  WorkflowResumePointEntry,
} from '../../models/types.js';
import type { FindingIntakeNormalizeConfig } from '../../models/config-types.js';
import type { FindingManagerAuthority } from '../../models/finding-types.js';
import type {
  PhaseName,
  PhasePromptParts,
  JudgeStageEntry,
  RuntimeStepResolution,
  StepProviderInfo,
  StepRunResult,
  WorkflowStepExecutionEventContext,
} from '../types.js';
import type { ProviderUsageSnapshot } from '../../models/response.js';
import { executeAgent } from '../../../agents/agent-usecases.js';
import { InstructionBuilder } from '../instruction/InstructionBuilder.js';
import { runReportPhase, ReportPhaseGenerationError } from '../phase-runner.js';
import { RuleDetectionExhaustedError } from '../evaluation/RuleDetectionExhaustedError.js';
import type { BasePhaseRunnerContext } from '../phase-runner.js';
import { buildSessionKey } from '../session-key.js';
import { incrementStepIteration, getPreviousOutput } from './state-manager.js';
import { createLogger, getErrorMessage, slugify } from '../../../shared/utils/index.js';
import type { OptionsBuilder } from './OptionsBuilder.js';
import type { RunPaths } from '../run/run-paths.js';
import type { StructuredCaller } from '../../../agents/structured-caller.js';
import { waitForStepDelay } from './step-delay.js';
import { parseLastJsonBlock } from '../../../agents/structured-caller/shared.js';
import {
  assertProviderResolvedForCapabilitySensitiveOptions,
} from './engine-provider-options.js';
import {
  StructuredOutputSchemaError,
  StructuredOutputValueValidationError,
  validateStructuredOutputAgainstSchema,
} from './structured-output-schema-validator.js';
import { providerSupportsStructuredOutput } from '../../../infra/providers/provider-capabilities.js';
import { AGENT_FAILURE_CATEGORIES } from '../../../shared/types/agent-failure.js';
import { buildPhaseExecutionId } from '../../../shared/utils/phaseExecutionId.js';
import { buildStructuredJsonSchemaInstruction } from '../../../shared/prompts/index.js';
import { buildFindingIntakeExtractionPrompt } from '../../../shared/prompts/finding-intake-extraction.js';
import type {
  StructuredOutputFailureReason,
  StructuredOutputNormalizerRegistry,
} from './structured-output-normalizer.js';
import { runWithPhaseSpan } from '../observability/workflowSpans.js';
import type {
  FindingContractInstructionContext,
  FindingContractInstructionPolicy,
} from '../instruction/instruction-context.js';
import { compactSessionBeforePhase1 } from './session-compaction.js';
import type { FindingLedgerStore } from '../findings/store.js';
import type { FindingManagerRunResult } from '../findings/manager-runner.js';
import { createRawFindingsStructuredOutput } from '../findings/manager-runner.js';
import {
  ingestFindingContractResults,
  resolveFindingContractIntakeStep,
  withFindingContractStructuredOutput,
} from '../findings/contract-intake.js';
import { clarifyAmbiguousRawRelationsOnce, type ReviewerRelationClarification } from '../findings/relation-coherence.js';
import {
  RAW_FINDINGS_SCHEMA_REF,
  projectReviewerRawStructuredOutputWithEnvelope,
  type ReviewerRawResourceEnvelope,
} from '../findings/raw-canonicalization.js';
import { invalidateExpectedPersonaSession, invalidatePersonaSessionIfExpected } from './session-invalidation.js';
import type { InstructionBuildTransaction } from './instruction-build-transaction.js';
import { evaluatePostExecutionRules } from './post-execution-rule-evaluator.js';
import type { PullRequestContext } from '../pr-context.js';
import { requireWorkflowResumeStackSnapshot } from '../run/resume-point.js';
import {
  correctStructuredOutputOnce,
  type StructuredOutputNormalizationResult,
} from './structured-output-correction.js';
import {
  completeObservedPhase1Attempt,
  executeObservedPhase1Attempt,
  PHASE1_EMPTY_OUTPUT_ERROR,
  runPhase1WithEmptyRecovery,
} from './phase1-empty-recovery.js';
import type { RunAgentOptions } from '../../../agents/types.js';

const log = createLogger('step-executor');

export interface StepExecutorDeps {
  readonly optionsBuilder: OptionsBuilder;
  readonly getCwd: () => string;
  readonly getProjectCwd: () => string;
  readonly getReportDir: () => string;
  readonly getRunPaths: () => RunPaths;
  readonly getLanguage: () => Language | undefined;
  readonly getInteractive: () => boolean;
  readonly getWorkflowSteps: () => ReadonlyArray<{ name: string; description?: string }>;
  readonly getWorkflowName: () => string;
  readonly getTask: () => string;
  readonly getWorkflowDescription: () => string | undefined;
  readonly getRetryNote: () => string | undefined;
  readonly getPrContext?: () => PullRequestContext | undefined;
  readonly getObservabilityRunId?: () => string | undefined;
  readonly observabilityEnabled?: () => boolean;
  readonly sanitizeObservabilityText?: (text: string) => string;
  readonly getCurrentWorkflowStack?: () => WorkflowResumePointEntry[] | undefined;
  readonly structuredCaller: StructuredCaller;
  readonly structuredOutputNormalizers: StructuredOutputNormalizerRegistry;
  readonly intakeNormalize?: FindingIntakeNormalizeConfig;
  readonly abortSignal?: AbortSignal;
  /** 自前 or workflow_call 親から継承した、この engine で有効な Finding Contract。 */
  readonly findingContract?: FindingContractConfig;
  readonly findingManagerAuthority: FindingManagerAuthority;
  /** findings-manager の provider/model 未指定時の fallback（manager-runner.ts 参照）。 */
  readonly workflowProvider?: WorkflowConfig['provider'];
  readonly workflowModel?: WorkflowConfig['model'];
  readonly executionProvider: WorkflowConfig['provider'];
  readonly executionModel: WorkflowConfig['model'];
  readonly findingLedgerStore?: FindingLedgerStore;
  readonly refreshFindingsState: () => void;
  readonly emitEvent: (event: string, ...args: unknown[]) => void;
  /** 合成ステップ（findings-manager 等）の LLM 呼び出しを usage-events へ記録する。 */
  readonly recordSynthesizedAgentUsage: (
    stepName: string,
    providerInfo: StepProviderInfo,
    success: boolean,
    usage: ProviderUsageSnapshot | undefined,
  ) => void;
  readonly getRunId: () => string;
  /** raw finding id 衝突対策の呼び出し名前空間。トップレベルでは空文字列。 */
  readonly getFindingCallNamespace: () => string;
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

/**
 * 通常 agent ステップを実行前に確定した結果。RunLoop の観測イベント、
 * StepExecutor、provider がこの同じ値を共有する。
 */
export interface PreparedNormalStepExecution {
  readonly executableStep: AgentWorkflowStep;
  readonly findingContractContext?: FindingContractInstructionContext;
  readonly phase1Instruction: string;
  readonly priorStepResponseText?: string;
  readonly stepIteration: number;
}

export class StepExecutor {
  private readonly structuredOutputNormalizers: StructuredOutputNormalizerRegistry;

  constructor(
    private readonly deps: StepExecutorDeps,
  ) {
    this.structuredOutputNormalizers = deps.structuredOutputNormalizers;
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

  private buildFindingContractInstructionContext(
    step: WorkflowStep,
    policy: FindingContractInstructionPolicy | undefined,
  ): FindingContractInstructionContext | undefined {
    if (policy?.mode === 'omit') {
      return undefined;
    }
    if (policy?.mode === 'explicit') {
      return policy.context;
    }
    return this.deps.optionsBuilder.buildFindingContractInstructionContext?.(
      step,
      undefined,
    );
  }

  /**
   * 単独ステップの Finding Contract 取り込み対象かどうかを判定する。
   * 述語の実体は contract-intake.ts の resolveFindingContractIntakeStep
   * （workflowPreview.ts と共有）。
   */
  private resolveFindingContractIntakeStep(step: WorkflowStep): AgentWorkflowStep | undefined {
    return resolveFindingContractIntakeStep(step, this.deps.findingContract);
  }

  private async ingestFindingContractForNormalStep(input: {
    step: AgentWorkflowStep;
    stepIteration: number;
    iteration: number;
    response: AgentResponse;
    reviewerRawResourceEnvelope?: ReviewerRawResourceEnvelope;
    priorStepResponseText: string | undefined;
    relationClarification?: ReviewerRelationClarification;
  }): Promise<FindingManagerRunResult> {
    if (!this.deps.findingLedgerStore) {
      throw new Error('Finding contract is configured but finding ledger store is not available');
    }
    return ingestFindingContractResults({
      contract: this.deps.findingContract!,
      workflowProvider: this.deps.workflowProvider,
      workflowModel: this.deps.workflowModel,
      ledgerStore: this.deps.findingLedgerStore,
      optionsBuilder: this.deps.optionsBuilder,
      stepExecutor: this,
      cwd: this.deps.getCwd(),
      parentStep: input.step,
      stepIteration: input.stepIteration,
      iteration: input.iteration,
      // 単独ステップでは「レビュアー1件」を自分自身として渡す
      // （manager-runner.ts の subResults は並列・単独どちらも同じ形で扱う）。
      subResults: [{
        subStep: input.step,
        response: input.response,
        ...(input.reviewerRawResourceEnvelope !== undefined
          ? { reviewerRawResourceEnvelope: input.reviewerRawResourceEnvelope }
          : {}),
        ...(input.relationClarification !== undefined ? { relationClarification: input.relationClarification } : {}),
      }],
      // 台帳の workflowName スタンプは店（ledgerStore）が束縛する正準名を使う。
      // workflow_call の子が親の台帳を継承した場合、この engine 自身の
      // getWorkflowName()（子のワークフロー名）を使うと reconcile 後の
      // ledger.workflowName が親の台帳と食い違う（ParallelRunner と同じ理由）。
      workflowName: this.deps.findingLedgerStore.workflowName,
      workflowTask: this.deps.getTask(),
      analyticsWorkflowName: this.deps.getWorkflowName(),
      callNamespace: this.deps.getFindingCallNamespace(),
      timestamp: new Date().toISOString(),
      priorStepResponseText: input.priorStepResponseText,
      managerAuthority: this.deps.findingManagerAuthority,
      refreshFindingsState: this.deps.refreshFindingsState,
      emitEvent: this.deps.emitEvent,
    });
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
    contents: string[] | undefined,
    transaction?: InstructionBuildTransaction,
  ): { content: string[]; sourcePath: string } | undefined {
    if (!contents || contents.length === 0) return undefined;
    const merged = contents.join('\n\n---\n\n');
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

  prepareNormalStepExecution(
    step: WorkflowStep,
    state: WorkflowState,
    task: string,
    maxSteps: number | 'infinite',
    stepIteration: number,
    runtime?: RuntimeStepResolution,
  ): PreparedNormalStepExecution {
    const findingContractIntakeStep = this.resolveFindingContractIntakeStep(step);
    const reviewerMode = this.deps.intakeNormalize === undefined ? 'structured' : 'freeform';
    const findingContractContext = findingContractIntakeStep
      ? this.deps.optionsBuilder.buildFindingContractInstructionContext(
          findingContractIntakeStep,
          reviewerMode,
        )
      : this.buildFindingContractInstructionContext(step, undefined);
    const executableStep = findingContractIntakeStep && reviewerMode === 'structured'
      ? withFindingContractStructuredOutput(
          findingContractIntakeStep,
          findingContractContext,
        )
      : step as AgentWorkflowStep;
    const instruction = this.buildInstruction(
      executableStep,
      stepIteration,
      state,
      task,
      maxSteps,
      undefined,
      findingContractContext === undefined
        ? undefined
        : { mode: 'explicit', context: findingContractContext },
    );

    return {
      executableStep,
      ...(findingContractContext !== undefined ? { findingContractContext } : {}),
      phase1Instruction: this.buildPhase1Instruction(instruction, executableStep, runtime),
      ...(state.lastOutput?.content !== undefined ? { priorStepResponseText: state.lastOutput.content } : {}),
      stepIteration,
    };
  }

  /**
   * 実行ループを通らない合成ステップ（findings-manager / findings-interpreter）
   * の LLM 呼び出しを usage-events へ記録する。通常ステップは step:complete
   * イベント経由、parallel / team_leader は recordDelegatedAgentUsage 経由で
   * 記録されるが、合成ステップの executeAgent 直呼びはどちらの経路にも
   * 乗らず、トークン集計の死角になっていた。
   */
  recordSynthesizedAgentUsage(step: WorkflowStep, success: boolean, usage: ProviderUsageSnapshot | undefined): void {
    this.deps.recordSynthesizedAgentUsage(
      step.name,
      this.deps.optionsBuilder.resolveStepProviderModel(step),
      success,
      usage,
    );
  }

  isFindingIntakeNormalizeActive(): boolean {
    return this.deps.intakeNormalize !== undefined;
  }

  async normalizeFindingIntakeReport(
    step: AgentWorkflowStep,
    reviewerResponse: AgentResponse,
    iteration: number,
  ): Promise<StructuredOutputNormalizationResult> {
    const config = this.deps.intakeNormalize;
    if (config === undefined) {
      throw new Error('Finding intake normalizer is not configured');
    }

    const normalizerStep: AgentWorkflowStep = {
      name: `${step.name}:intake-normalize`,
      personaDisplayName: 'Finding intake normalizer',
      instruction: 'Normalize one reviewer report for Finding Contract intake.',
      edit: false,
      engineSynthesized: true,
    };
    const providerInfo = {
      provider: config.provider,
      model: config.model,
      providerOptions: config.providerOptions,
    };
    const instruction = buildFindingIntakeExtractionPrompt(reviewerResponse.content);
    const phaseExecutionId = buildPhaseExecutionId({
      step: normalizerStep.name,
      iteration,
      phase: 1,
      sequence: 1,
    });
    let resolvedPromptParts: PhasePromptParts | undefined;
    let phaseStarted = false;
    let phaseCompleted = false;
    let normalizationSucceeded = false;
    let normalizerResponse: AgentResponse | undefined;
    let normalized: StructuredOutputNormalizationResult | undefined;
    try {
      resolvedPromptParts = {
        systemPrompt: '',
        userInstruction: instruction,
      };
      this.deps.onPhaseStart?.(
        normalizerStep,
        1,
        'execute',
        instruction,
        resolvedPromptParts,
        phaseExecutionId,
        iteration,
      );
      phaseStarted = true;
      normalizerResponse = await runWithPhaseSpan({
        enabled: this.deps.observabilityEnabled?.() === true,
        runId: this.deps.getObservabilityRunId?.(),
        workflowName: this.deps.getWorkflowName(),
        step: normalizerStep,
        iteration,
        phase: 1,
        phaseName: 'execute',
        instruction,
        phaseExecutionId,
        workflowStack: this.deps.getCurrentWorkflowStack?.(),
        sanitizeText: this.deps.sanitizeObservabilityText,
        providerInfo,
        getPromptParts: () => resolvedPromptParts,
      }, () => this.deps.structuredCaller.normalizeFindingIntake(
        reviewerResponse.content,
        {
          provider: config.provider,
          model: config.model,
          providerOptions: config.providerOptions,
          language: this.deps.getLanguage(),
          abortSignal: this.deps.abortSignal,
          onPromptResolved: (promptParts) => {
            resolvedPromptParts = promptParts;
          },
        },
      ), (result) => ({
        status: result.status,
        content: result.content,
        error: result.error,
        providerUsage: result.providerUsage,
      }));
      if (normalizerResponse.status !== 'done') {
        throw new Error(
          `Finding intake normalizer failed for step "${step.name}": ${
            normalizerResponse.error ?? normalizerResponse.content
          }`,
        );
      }
      if (normalizerResponse.structuredOutput === undefined) {
        throw new Error(`Finding intake normalizer returned no structured output for step "${step.name}"`);
      }

      normalized = this.normalizeStructuredOutputWithDiagnostics(
        {
          ...step,
          structuredOutput: createRawFindingsStructuredOutput(),
        },
        {
          ...reviewerResponse,
          structuredOutput: normalizerResponse.structuredOutput,
        },
        { providerInfo },
      );
      if (normalized.invalidDetail !== undefined) {
        throw new Error(
          `Finding intake normalizer returned invalid structured output for step "${step.name}": ${
            normalized.invalidDetail
          }`,
        );
      }
      this.deps.onPhaseComplete?.(
        normalizerStep,
        1,
        'execute',
        normalizerResponse.content,
        normalizerResponse.status,
        normalizerResponse.error,
        phaseExecutionId,
        iteration,
      );
      phaseCompleted = true;
      normalizationSucceeded = true;
    } catch (error) {
      if (phaseStarted && !phaseCompleted) {
        this.deps.onPhaseComplete?.(
          normalizerStep,
          1,
          'execute',
          normalizerResponse?.content ?? '',
          'error',
          getErrorMessage(error),
          phaseExecutionId,
          iteration,
        );
      }
      throw error;
    } finally {
      this.deps.recordSynthesizedAgentUsage(
        normalizerStep.name,
        providerInfo,
        normalizationSucceeded,
        normalizerResponse?.providerUsage,
      );
    }
    if (normalized === undefined) {
      throw new Error(`Finding intake normalizer produced no normalization result for step "${step.name}"`);
    }
    return normalized;
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

  /**
   * Like normalizeStructuredOutput, but returns the validation failure as a
   * diagnostic instead of throwing, so callers can attempt a corrective
   * retry with the agent (weak models frequently emit malformed JSON on
   * large structured outputs).
   */
  normalizeStructuredOutputWithDiagnostics(
    step: WorkflowStep,
    response: AgentResponse,
    runtime?: RuntimeStepResolution,
  ): StructuredOutputNormalizationResult {
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
      let reviewerRawResourceEnvelope: ReviewerRawResourceEnvelope | undefined;

      if (structuredOutput === undefined) {
        if (supportsStructuredOutput !== false) {
          throw new Error('Structured output response is missing');
        }

        const parsed = parseLastJsonBlock(response.content);
        if (typeof parsed !== 'object' || parsed == null || Array.isArray(parsed)) {
          throw new Error('Structured output JSON must be an object');
        }
        structuredOutput = parsed as Record<string, unknown>;
      }

      if (step.structuredOutput.schemaRef === RAW_FINDINGS_SCHEMA_REF) {
        const projected = projectReviewerRawStructuredOutputWithEnvelope(structuredOutput);
        structuredOutput = projected.structuredOutput;
        reviewerRawResourceEnvelope = projected.resourceEnvelope;
      }

      // post-hoc 検証は寛容版（validationSchema）を優先する。provider へ渡る
      // 生成拘束用 schema（strict 様式）とは役割が異なる — 詳細は
      // WorkflowStructuredOutput の doc コメント参照。
      validateStructuredOutputAgainstSchema(
        structuredOutput,
        step.structuredOutput.validationSchema ?? step.structuredOutput.schema,
      );
      structuredOutput = this.structuredOutputNormalizers.normalize(structuredOutput, {
        step,
        language: this.deps.getLanguage(),
      });
      if (structuredOutput === response.structuredOutput) {
        return {
          response,
          ...(reviewerRawResourceEnvelope !== undefined
            ? { reviewerRawResourceEnvelope }
            : {}),
        };
      }

      return {
        response: {
          ...response,
          structuredOutput,
        },
        ...(reviewerRawResourceEnvelope !== undefined
          ? { reviewerRawResourceEnvelope }
          : {}),
      };
    } catch (error) {
      const detail = getErrorMessage(error);
      const fallback = this.buildStructuredOutputFailureFallback(
        step,
        response,
        supportsStructuredOutput !== false && response.structuredOutput === undefined ? 'missing' : 'schema_error',
        detail,
      );
      if (fallback) {
        return { response: fallback };
      }
      this.logStructuredOutputFailure(
        step,
        supportsStructuredOutput !== false && response.structuredOutput === undefined ? 'missing' : 'schema_error',
        detail,
      );
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
    findingContractPolicy?: FindingContractInstructionPolicy,
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
      retryNote: this.deps.getRetryNote(),
      prContext: this.deps.getPrContext?.(),
      policyContents: policySnapshot?.content ?? step.policyContents,
      policySourcePath: policySnapshot?.sourcePath,
      knowledgeContents: knowledgeSnapshot?.content ?? step.knowledgeContents,
      knowledgeSourcePath: knowledgeSnapshot?.sourcePath,
      previousResponseSourcePath: state.previousResponseSourcePath,
      fallbackContext: fallbackContext ?? state.pendingFallback,
      workflowState: state,
      findingContract: this.buildFindingContractInstructionContext(step, findingContractPolicy),
    }).build();
    if (fallbackContext === undefined) {
      state.pendingFallback = undefined;
    }
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
    const phaseCtx = this.deps.optionsBuilder.buildPhaseRunnerContext(
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

    // Phase 2: report output (resume same session, Write only)
    // Report generation is only valid after a completed Phase 1 response.
    if (nextResponse.status === 'done' && step.outputContracts && step.outputContracts.length > 0) {
      try {
        const reportResult = await runReportPhase(step, stepIteration, phaseCtx);
        if (reportResult && 'blocked' in reportResult) {
          nextResponse = { ...nextResponse, status: 'blocked', content: reportResult.response.content };
          return nextResponse;
        }
        if (reportResult && 'rateLimited' in reportResult) {
          return {
            ...reportResult.response,
            persona: step.name,
          };
        }
      } catch (reportError) {
        if (reportError instanceof ReportPhaseGenerationError) {
          log.info('Report phase failed, continuing to status judgment', {
            step: step.name,
            error: getErrorMessage(reportError),
          });
        } else {
          throw reportError;
        }
      }
    }

    if (nextResponse.structuredOutput) {
      state.structuredOutputs.set(step.name, nextResponse.structuredOutput);
    }

    const match = await evaluatePostExecutionRules(step, () => phaseCtx, {
      state,
      interactive: this.deps.getInteractive(),
    });
    if (match) {
      log.debug('Rule matched', { step: step.name, ruleIndex: match.index, method: match.method });
      nextResponse = {
        ...nextResponse,
        matchedRuleIndex: match.index,
        matchedRuleMethod: match.method,
      };
    }

    return nextResponse;
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

    const findingContractIntakeStep = this.resolveFindingContractIntakeStep(step);
    if (findingContractIntakeStep !== undefined) {
      if (preparedExecution === undefined) {
        throw new Error(
          `Finding contract reviewer step "${step.name}" requires prepared execution input`,
        );
      }
      if (preparedExecution.findingContractContext === undefined) {
        throw new Error(`Prepared reviewer step "${step.name}" is missing finding contract context`);
      }
      const reviewer = preparedExecution.findingContractContext.reviewer;
      if (reviewer === undefined) {
        throw new Error(`Prepared reviewer step "${step.name}" is missing reviewer context`);
      }
      if (reviewer.mode === 'structured') {
        if (
          preparedExecution.executableStep.structuredOutput
          !== reviewer.rawFindingsStructuredOutput
        ) {
          throw new Error(`Prepared reviewer step "${step.name}" has mismatched structured output`);
        }
      } else if (preparedExecution.executableStep.structuredOutput !== undefined) {
        throw new Error(`Prepared free-form reviewer step "${step.name}" must not require structured output`);
      }
    }
    const findingContractContext = preparedExecution?.findingContractContext;
    const executableStep = preparedExecution?.executableStep ?? step as AgentWorkflowStep;
    // 直前ステップ（通常は coder の fix）の応答。異議申告の裁定材料として
    // manager に渡すため、Phase 1 実行で lastOutput が上書きされる前に捕捉する
    // （ParallelRunner の priorStepResponseText 捕捉と同じタイミング）。
    const priorStepResponseText = preparedExecution?.priorStepResponseText ?? state.lastOutput?.content;

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
      ?? this.buildPhase1Instruction(instruction, executableStep, runtime);
    const providerInfo = this.deps.optionsBuilder.resolveStepProviderModel(executableStep, runtime);
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
    const baseAgentOptions = this.deps.optionsBuilder.buildAgentOptions(executableStep, runtime);
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
    const intakeNormalizeActive = findingContractIntakeStep !== undefined
      && this.deps.intakeNormalize !== undefined;
    const promptResolvedAttempts = new Set<number>();
    const phase1Result = await runPhase1WithEmptyRecovery({
      instruction: phase1Instruction,
      initialSessionId: agentOptions.sessionId,
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
          execute: (attemptInstruction, sessionId, onPromptResolved) => executeAgent(
            executableStep.persona,
            attemptInstruction,
            {
              ...agentOptions,
              sessionId,
              onPromptResolved,
            },
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
    if (intakeNormalizeActive) {
      if (response.sessionId !== undefined) {
        updatePersonaSession(sessionKey, response.sessionId);
      }
      completeObservedPhase1Attempt({
        eventStep: step,
        iteration: state.iteration,
        attempt: phase1Result.finalAttempt,
        response,
        onPhaseComplete: this.deps.onPhaseComplete,
      });
    }
    let normalizedPhase1 = intakeNormalizeActive && response.status === 'done'
      ? await this.normalizeFindingIntakeReport(
          findingContractIntakeStep,
          response,
          state.iteration,
        )
      : this.normalizeStructuredOutputWithDiagnostics(
          executableStep,
          response,
          runtime,
        );
    if (
      !intakeNormalizeActive
      && findingContractIntakeStep !== undefined
      && normalizedPhase1.invalidKind === 'model_output'
    ) {
      log.info('Structured output invalid for step, requesting one correction', {
        step: step.name,
        detail: normalizedPhase1.invalidDetail,
      });
    }
    if (findingContractIntakeStep !== undefined && !intakeNormalizeActive) {
      normalizedPhase1 = await correctStructuredOutputOnce({
        stepName: executableStep.name,
        initial: normalizedPhase1,
        executeCorrection: (correctionInstruction, sessionId) => executeAgent(
          executableStep.persona,
          correctionInstruction,
          {
            ...agentOptions,
            permissionMode: 'readonly',
            allowedTools: [],
            onPromptResolved: undefined,
            onStream: undefined,
            sessionId,
          },
        ),
        normalize: (candidate) => this.normalizeStructuredOutputWithDiagnostics(
          executableStep,
          candidate,
          runtime,
        ),
      });
    }
    if (normalizedPhase1.invalidDetail !== undefined) {
      const provider = this.deps.optionsBuilder.resolveStepProviderModel(executableStep, runtime).provider;
      throw new Error(
        `Step "${executableStep.name}" requires structured_output for provider "${provider}": ${normalizedPhase1.invalidDetail}`,
      );
    }
    response = normalizedPhase1.response;
    let reviewerRawResourceEnvelope = normalizedPhase1.reviewerRawResourceEnvelope;
    if (!intakeNormalizeActive) {
      if (response.sessionId !== undefined) {
        updatePersonaSession(sessionKey, response.sessionId);
      }
      completeObservedPhase1Attempt({
        eventStep: step,
        iteration: state.iteration,
        attempt: phase1Result.finalAttempt,
        response,
        onPhaseComplete: this.deps.onPhaseComplete,
      });
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

    // レビュア1回突き返し: relation/target/kind の意味矛盾が
    // ある raw について同一セッションで1回だけ明確化を求める（ParallelRunner の
    // 同名処理と同じ一般経路）。clarification は engine 発行の taint 根拠として
    // 取り込み（manager-runner の canonicalization）へ渡す。
    let relationClarification: ReviewerRelationClarification | undefined;
    if (
      !intakeNormalizeActive
      && findingContractIntakeStep
      && findingContractContext
      && this.deps.findingLedgerStore
      && response.status === 'done'
    ) {
      const clarified = await clarifyAmbiguousRawRelationsOnce({
        stepName: step.name,
        persona: executableStep.persona,
        response,
        ledger: this.deps.findingLedgerStore.loadLedger(),
        agentOptions,
        normalize: (candidate: AgentResponse) => this.normalizeStructuredOutputWithDiagnostics(executableStep, candidate, runtime),
        reviewerRawResourceEnvelope,
      });
      response = clarified.response;
      reviewerRawResourceEnvelope = clarified.reviewerRawResourceEnvelope;
      relationClarification = clarified.clarification;
      if (response.sessionId !== undefined) {
        updatePersonaSession(sessionKey, response.sessionId);
      }
    }

    // Finding Contract の取り込みはルール評価の前に行う。when(findings.*) の
    // ガードがこの回の取り込み結果を見る必要があるため
    // （ParallelRunner が manager 実行後にルール評価する構成と同じ）。
    if (findingContractIntakeStep && findingContractContext) {
      // v2 梯子設計: 取り込みは常に 'updated' で完了する（manager の壊れた応答・
      // 予算超過は provisional として台帳へ着地し、run-level の失敗経路は無い）。
      await this.ingestFindingContractForNormalStep({
        step: findingContractIntakeStep,
        stepIteration,
        iteration: state.iteration,
        response,
        reviewerRawResourceEnvelope,
        priorStepResponseText,
        relationClarification,
      });
    }

    try {
      response = await this.applyPostExecutionPhases(
        step,
        state,
        stepIteration,
        response,
        updatePersonaSession,
        runtime,
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
      return { response, instruction: phase1Instruction, providerInfo };
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
    return { response, instruction: phase1Instruction, providerInfo };
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
    const findingScopeIdentity = this.deps.findingLedgerStore?.ledgerIdentity;
    const findingIds = findingScopeIdentity === undefined
      ? undefined
      : this.deps.findingLedgerStore
        ?.loadLedger()
        .findings
        .map((finding) => finding.id);
    if (findingScopeIdentity !== undefined && findingIds === undefined) {
      throw new Error(
        `Finding IDs are missing for scope "${findingScopeIdentity}"`,
      );
    }
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
      findingScopeIdentity,
      findingIds: findingIds === undefined
        ? undefined
        : Object.freeze([...findingIds]),
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
