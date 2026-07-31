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
import type { StructuredCaller } from '../../../agents/structured-caller.js';
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
import {
  generateReportPhase,
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
  providerSupportsIsolatedStructuredExecution,
  providerSupportsStructuredOutput,
} from '../../../infra/providers/provider-capabilities.js';
import { AGENT_FAILURE_CATEGORIES } from '../../../shared/types/agent-failure.js';
import { buildStructuredJsonSchemaInstruction } from '../../../shared/prompts/index.js';
import type {
  StructuredOutputFailureReason,
  StructuredOutputNormalizerRegistry,
} from './structured-output-normalizer.js';
import type {
  FindingContractInstructionContext,
  FindingContractInstructionPolicy,
  FindingContractReviewerOutputStrategy,
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
import { resolveFindingContractReviewerOutputStrategy } from '../findings/reviewer-output-strategy.js';
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
import {
  createFindingReviewPublication,
  createPendingFindingReviewNormalization,
  loadFindingReviewPublication,
  loadPendingFindingReviewNormalization,
  persistFindingReviewPublication,
  persistPendingFindingReviewNormalization,
  publishFindingReviewPublication,
  PLAIN_TEXT_NORMALIZED_FINDING_REVIEW_PUBLICATION_PROTOCOL,
  STRUCTURED_FINDING_REVIEW_PUBLICATION_PROTOCOL,
  type CanonicalFindingReviewPublication,
  type FindingReviewPublicationIdentity,
  type FindingReviewPublicationProtocol,
  type ReviewerExecutionIdentity,
} from '../findings/review-publication.js';
import {
  FINDING_REVIEW_PUBLICATION_SCHEMA_REF,
  createFindingReviewPublicationStructuredOutput,
  findingReviewPublicationReportContent,
} from '../findings/review-publication-structured-output.js';
import type {
  FindingReviewPublicationCorrectionInput,
} from '../findings/review-publication-correction.js';
import {
  fallbackContextForOperation,
  findingIntakeNormalizerOperationOrigin,
  reviewerOperationOrigin,
  runtimeForOperation,
} from './fallback-operation.js';

const log = createLogger('step-executor');

function reviewerExecutionIdentity(
  providerInfo: StepProviderInfo,
): ReviewerExecutionIdentity {
  if (providerInfo.provider === undefined) {
    throw new Error('Reviewer execution identity requires a resolved provider');
  }
  return Object.freeze({
    provider: providerInfo.provider,
    ...(providerInfo.model !== undefined ? { model: providerInfo.model } : {}),
    ...(providerInfo.providerOptions !== undefined
      ? { providerOptions: structuredClone(providerInfo.providerOptions) }
      : {}),
  });
}

function reviewerRuntime(
  identity: ReviewerExecutionIdentity,
): RuntimeStepResolution {
  return {
    providerInfoResolution: 'fully_resolved',
    providerInfo: {
      provider: identity.provider,
      model: identity.model,
      providerSource: 'step',
      modelSource: identity.model !== undefined ? 'step' : undefined,
      ...(identity.providerOptions !== undefined
        ? { providerOptions: structuredClone(identity.providerOptions) }
        : {}),
    },
  };
}

function replaceResponseProviderUsage(
  response: AgentResponse,
  providerUsage: ProviderUsageSnapshot | undefined,
): AgentResponse {
  const withoutProviderUsage = { ...response };
  delete withoutProviderUsage.providerUsage;
  return providerUsage === undefined
    ? withoutProviderUsage
    : { ...withoutProviderUsage, providerUsage };
}

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
  readonly structuredOutputNormalizers: StructuredOutputNormalizerRegistry;
  readonly structuredCaller?: StructuredCaller;
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
  readonly reviewerOutputStrategy?: FindingContractReviewerOutputStrategy;
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
    publication: CanonicalFindingReviewPublication;
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
        publication: input.publication,
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
    const reviewerRuntime = findingContractIntakeStep === undefined
      ? runtime
      : this.resolveReviewerRuntime(findingContractIntakeStep, runtime);
    const reviewerOutputStrategy = findingContractIntakeStep
      ? this.requireFindingContractReviewerOutputStrategy(
          findingContractIntakeStep,
          reviewerRuntime,
        )
      : undefined;
    const findingContractContext = findingContractIntakeStep
      ? this.deps.optionsBuilder.buildFindingContractInstructionContext(
          findingContractIntakeStep,
          reviewerOutputStrategy,
        )
      : this.buildFindingContractInstructionContext(step, undefined);
    const executableStep = findingContractIntakeStep
      && reviewerOutputStrategy?.reportGeneration === 'structured'
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
      fallbackContextForOperation(
        reviewerRuntime,
        reviewerOperationOrigin(step.name),
      ),
      findingContractContext === undefined
        ? undefined
        : { mode: 'explicit', context: findingContractContext },
    );

    return {
      executableStep,
      ...(findingContractContext !== undefined ? { findingContractContext } : {}),
      ...(reviewerOutputStrategy !== undefined ? { reviewerOutputStrategy } : {}),
      phase1Instruction: this.buildPhase1Instruction(
        instruction,
        executableStep,
        reviewerRuntime,
      ),
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

  private findingReviewPublicationIdentity(input: {
    readonly parentStepName: string;
    readonly stepIteration: number;
    readonly reviewerStepName: string;
    readonly reportName: string;
  }): FindingReviewPublicationIdentity {
    const ledgerStore = this.deps.findingLedgerStore;
    if (ledgerStore === undefined) {
      throw new Error('Finding contract reviewer requires a finding ledger store');
    }
    return {
      scopeIdentity: ledgerStore.ledgerIdentity,
      callNamespace: this.deps.getFindingCallNamespace(),
      parentStepName: input.parentStepName,
      stepIteration: input.stepIteration,
      reviewerStepName: input.reviewerStepName,
      reportName: input.reportName,
    };
  }

  private rawFindingsFromResponse(
    stepName: string,
    response: AgentResponse,
  ): readonly unknown[] {
    const rawFindings = response.structuredOutput?.rawFindings;
    if (!Array.isArray(rawFindings)) {
      throw new Error(
        `Finding contract reviewer "${stepName}" produced no rawFindings array`,
      );
    }
    return rawFindings;
  }

  private findingReviewPublicationProtocolForStrategy(
    strategy: FindingContractReviewerOutputStrategy,
  ): FindingReviewPublicationProtocol {
    switch (strategy.intake) {
      case 'reviewer_structured':
        return STRUCTURED_FINDING_REVIEW_PUBLICATION_PROTOCOL;
      case 'isolated_normalizer':
        return PLAIN_TEXT_NORMALIZED_FINDING_REVIEW_PUBLICATION_PROTOCOL;
    }
  }

  requireFindingContractReviewerOutputStrategy(
    step: AgentWorkflowStep,
    runtime?: RuntimeStepResolution,
  ): FindingContractReviewerOutputStrategy {
    const reviewerProviderInfo = this.deps.optionsBuilder.resolveStepProviderModel(
      step,
      runtime,
    );
    const strategy = resolveFindingContractReviewerOutputStrategy(
      this.deps.findingContract,
      this.deps.intakeNormalize,
      reviewerProviderInfo,
    );
    if (strategy === undefined) {
      throw new Error(
        'Finding contract reviewer output strategy is not configured',
      );
    }
    return strategy;
  }

  private resolveReviewerRuntime(
    step: AgentWorkflowStep,
    runtime?: RuntimeStepResolution,
  ): RuntimeStepResolution | undefined {
    const runtimeProviderBelongsToNormalizer =
      runtime?.fallback?.origin.stage === 'finding_intake_normalizer'
      && runtime.fallback.origin.reviewerStepName === step.name;
    const reviewerBaseProviderInfo = runtimeProviderBelongsToNormalizer
      ? this.deps.optionsBuilder.resolveStepProviderModel(step)
      : runtime?.providerInfo;
    return runtimeForOperation(
      runtime,
      reviewerOperationOrigin(step.name),
      reviewerBaseProviderInfo,
    );
  }

  private requireFindingIntakeNormalizer(): {
    readonly structuredCaller: StructuredCaller;
    readonly config: FindingIntakeNormalizeConfig;
  } {
    if (this.deps.structuredCaller === undefined || this.deps.intakeNormalize === undefined) {
      throw new Error(
        'Finding intake normalizer is not configured for plain_text_normalized reviewer output',
      );
    }
    return {
      structuredCaller: this.deps.structuredCaller,
      config: this.deps.intakeNormalize,
    };
  }

  private async normalizePlainTextFindingReview(input: {
    readonly reviewerStep: AgentWorkflowStep;
    readonly reportResponse: AgentResponse;
    readonly reportContent: string;
    readonly state: WorkflowState;
    readonly identity: FindingReviewPublicationIdentity;
    readonly runtime?: RuntimeStepResolution;
  }): Promise<
    StructuredOutputNormalizationResult
    & {
      readonly providerInfo: StepProviderInfo;
      readonly publication?: CanonicalFindingReviewPublication;
    }
  > {
    const { structuredCaller, config } = this.requireFindingIntakeNormalizer();
    const normalizerStep: AgentWorkflowStep = {
      kind: 'agent',
      name: `${input.reviewerStep.name}:intake-normalize`,
      personaDisplayName: 'Finding intake normalizer',
      instruction: 'Extract raw findings from one reviewer report.',
      engineSynthesized: true,
      provider: config.provider,
      providerSpecified: true,
      model: config.model,
      modelSpecified: true,
      providerOptions: config.providerOptions,
      session: 'refresh',
      edit: false,
      structuredOutput: createRawFindingsStructuredOutput(),
    };
    const configuredProviderInfo: StepProviderInfo = {
      provider: config.provider,
      model: config.model,
      providerOptions: config.providerOptions,
      providerSource: 'step',
      modelSource: 'step',
    };
    const normalizerRuntime = runtimeForOperation(
      input.runtime,
      findingIntakeNormalizerOperationOrigin(input.reviewerStep.name),
      configuredProviderInfo,
    );
    const resolvedProviderInfo = normalizerRuntime?.providerInfo ?? configuredProviderInfo;
    const providerInfo: StepProviderInfo = {
      ...resolvedProviderInfo,
      providerOptions: config.providerOptions,
    };
    if (
      providerInfo.provider === undefined
      || providerSupportsIsolatedStructuredExecution(providerInfo.provider) !== true
    ) {
      throw new Error(
        `Finding intake normalizer provider "${providerInfo.provider ?? '(unresolved)'}" `
        + 'does not support isolated structured execution',
      );
    }
    const normalizerProvider = providerInfo.provider;
    const runtime: RuntimeStepResolution = { providerInfo };
    const execute = async (
      mode: 'initial' | 'correction',
    ): Promise<
      StructuredOutputNormalizationResult
      & {
        readonly providerInfo: StepProviderInfo;
        readonly publication?: CanonicalFindingReviewPublication;
      }
    > => {
      let response: AgentResponse;
      let promptParts: PhasePromptParts | undefined;
      try {
        response = await structuredCaller.normalizeFindingIntake(input.reportContent, {
          provider: normalizerProvider,
          model: providerInfo.model,
          providerOptions: providerInfo.providerOptions,
          language: this.deps.getLanguage(),
          abortSignal: this.deps.abortSignal,
          mode,
          onPromptResolved: (resolved) => {
            promptParts = resolved;
            this.deps.onPhaseStart?.(
              normalizerStep,
              1,
              'execute',
              resolved.userInstruction,
              resolved,
              undefined,
              input.state.iteration,
            );
          },
        });
      } catch (error) {
        this.deps.recordSynthesizedAgentUsage(
          normalizerStep.name,
          providerInfo,
          false,
          undefined,
        );
        throw new Error(
          `Finding intake normalizer for reviewer "${input.reviewerStep.name}" failed: ${
            getErrorMessage(error)
          }`,
          { cause: error },
        );
      }
      if (promptParts !== undefined) {
        this.deps.onPhaseComplete?.(
          normalizerStep,
          1,
          'execute',
          response.content,
          response.status,
          response.error,
          undefined,
          input.state.iteration,
        );
      }
      this.deps.recordSynthesizedAgentUsage(
        normalizerStep.name,
        providerInfo,
        response.status === 'done',
        response.providerUsage,
      );
      const normalized = this.normalizeStructuredOutputWithDiagnostics(
        normalizerStep,
        response,
        runtime,
      );
      if (normalized.invalidDetail !== undefined || normalized.response.status !== 'done') {
        return { ...normalized, providerInfo };
      }
      try {
        return {
          ...normalized,
          providerInfo,
          publication: createFindingReviewPublication({
            identity: input.identity,
            protocol: PLAIN_TEXT_NORMALIZED_FINDING_REVIEW_PUBLICATION_PROTOCOL,
            reportContent: input.reportContent,
            rawFindings: this.rawFindingsFromResponse(
              input.reviewerStep.name,
              normalized.response,
            ),
            reviewerRawResourceEnvelope: normalized.reviewerRawResourceEnvelope,
          }),
        };
      } catch (error) {
        return {
          ...normalized,
          providerInfo,
          invalidDetail: getErrorMessage(error),
          invalidKind: 'model_output',
        };
      }
    };

    const initial = await execute('initial');
    const normalized = initial.invalidDetail !== undefined
      && initial.invalidKind === 'model_output'
      ? await execute('correction')
      : initial;
    if (
      initial.invalidDetail !== undefined
      && initial.invalidKind === 'model_output'
      && normalized.invalidDetail !== undefined
    ) {
      return {
        response: {
          ...normalized.response,
          status: 'error',
          error: `Finding intake normalizer for reviewer "${input.reviewerStep.name}" remained invalid after one correction: ${
            normalized.invalidDetail
          }`,
        },
        providerInfo,
        reviewerRawResourceEnvelope: normalized.reviewerRawResourceEnvelope,
      };
    }
    if (
      initial.invalidDetail !== undefined
      && initial.invalidKind === 'model_output'
      && normalized.response.status !== 'done'
      && normalized.response.status !== 'blocked'
      && normalized.response.status !== 'rate_limited'
    ) {
      return {
        ...normalized,
        response: {
          ...normalized.response,
          status: 'error',
          error: `Finding intake normalizer for reviewer "${input.reviewerStep.name}" correction failed: ${
            normalized.response.error ?? normalized.response.content
          }`,
        },
      };
    }
    if (normalized.invalidDetail !== undefined || normalized.response.status !== 'done') {
      return normalized;
    }
    if (normalized.publication === undefined) {
      throw new Error(
        `Finding intake normalizer for reviewer "${input.reviewerStep.name}" produced no validated publication`,
      );
    }
    return {
      response: {
        ...input.reportResponse,
        content: input.reportContent,
        structuredOutput: normalized.response.structuredOutput,
      },
      providerInfo,
      reviewerRawResourceEnvelope: normalized.reviewerRawResourceEnvelope,
      publication: normalized.publication,
    };
  }

  async resumeFindingReviewPublication(input: {
    readonly step: AgentWorkflowStep;
    readonly parentStepName: string;
    readonly stepIteration: number;
    readonly state: WorkflowState;
    readonly runtime?: RuntimeStepResolution;
  }): Promise<{
    readonly publication: CanonicalFindingReviewPublication;
    readonly response: AgentResponse;
    readonly relationClarification?: ReviewerRelationClarification;
    readonly reviewerProviderInfo?: StepProviderInfo;
    readonly reviewerRuntime?: RuntimeStepResolution;
  } | {
    readonly terminalResponse: AgentResponse;
    readonly reviewerProviderInfo?: StepProviderInfo;
    readonly reviewerRuntime?: RuntimeStepResolution;
    readonly terminalOperation: NonNullable<StepRunResult['terminalOperation']>;
  } | undefined> {
    const reportFiles = input.step.outputContracts?.map((entry) => entry.name) ?? [];
    if (reportFiles.length !== 1) {
      throw new Error(
        `Finding contract reviewer "${input.step.name}" requires exactly one report`,
      );
    }
    const identity = this.findingReviewPublicationIdentity({
      parentStepName: input.parentStepName,
      stepIteration: input.stepIteration,
      reviewerStepName: input.step.name,
      reportName: reportFiles[0]!,
    });
    const reportDir = this.deps.getRunPaths().reportsAbs;
    const preparation = loadFindingReviewPublication(
      reportDir,
      identity,
    );
    const pending = preparation === undefined
      ? loadPendingFindingReviewNormalization(
          reportDir,
          identity,
          this.deps.getWorkflowName(),
        )
      : undefined;
    if (pending !== undefined) {
      const reportResponse: AgentResponse = {
        persona: input.step.name,
        status: 'done',
        content: pending.reportContent,
        timestamp: new Date(),
      };
      const persistedReviewerRuntime = reviewerRuntime(
        pending.reviewerExecutionIdentity,
      );
      const normalized = await this.normalizePlainTextFindingReview({
        reviewerStep: input.step,
        reportResponse,
        reportContent: pending.reportContent,
        state: input.state,
        identity,
        runtime: input.runtime,
      });
      if (
        normalized.response.status === 'blocked'
        || normalized.response.status === 'rate_limited'
      ) {
        return {
          terminalResponse: normalized.response,
          reviewerProviderInfo: persistedReviewerRuntime.providerInfo,
          reviewerRuntime: persistedReviewerRuntime,
          terminalOperation: {
            origin: findingIntakeNormalizerOperationOrigin(input.step.name),
            providerInfo: normalized.providerInfo,
          },
        };
      }
      if (
        normalized.invalidDetail !== undefined
        || normalized.response.status !== 'done'
        || normalized.publication === undefined
      ) {
        throw new Error(
          `Finding intake normalizer for reviewer "${input.step.name}" failed while resuming pending publication: ${
            normalized.invalidDetail
              ?? normalized.response.error
              ?? normalized.response.content
          }`,
        );
      }
      const persisted = persistFindingReviewPublication(reportDir, {
        publication: normalized.publication,
        reviewerExecutionIdentity: pending.reviewerExecutionIdentity,
      });
      publishFindingReviewPublication(reportDir, persisted.publication);
      return {
        publication: persisted.publication,
        response: {
          ...normalized.response,
          content: persisted.publication.reportContent,
          structuredOutput: {
            rawFindings: [...persisted.publication.rawFindings],
          },
        },
        reviewerProviderInfo: persistedReviewerRuntime.providerInfo,
        reviewerRuntime: persistedReviewerRuntime,
      };
    }
    if (preparation === undefined) {
      return undefined;
    }
    const { publication } = preparation;
    publishFindingReviewPublication(reportDir, publication);
    return {
      publication,
      response: {
        persona: input.step.name,
        status: 'done',
        content: publication.reportContent,
        structuredOutput: { rawFindings: [...publication.rawFindings] },
        timestamp: new Date(),
      },
      ...(preparation.relationClarification !== undefined
        ? { relationClarification: preparation.relationClarification }
        : {}),
      ...(preparation.reviewerExecutionIdentity !== undefined
        ? {
            reviewerProviderInfo: reviewerRuntime(
              preparation.reviewerExecutionIdentity,
            ).providerInfo,
            reviewerRuntime: reviewerRuntime(preparation.reviewerExecutionIdentity),
          }
        : {}),
    };
  }

  async prepareFindingReviewPublication(input: {
    readonly step: AgentWorkflowStep;
    readonly executableStep: AgentWorkflowStep;
    readonly reviewerOutputStrategy: FindingContractReviewerOutputStrategy;
    readonly parentStepName: string;
    readonly stepIteration: number;
    readonly state: WorkflowState;
    readonly phase1Response: AgentResponse;
    readonly agentOptions: RunAgentOptions;
    readonly onProviderAttempt: NonNullable<
      BasePhaseRunnerContext['onProviderAttempt']
    >;
    readonly updatePersonaSession: (persona: string, sessionId: string | undefined) => void;
    readonly runtime?: RuntimeStepResolution;
  }): Promise<
    | {
        readonly publication: CanonicalFindingReviewPublication;
        readonly response: AgentResponse;
        readonly relationClarification?: ReviewerRelationClarification;
        readonly reviewerProviderInfo?: StepProviderInfo;
        readonly reviewerRuntime?: RuntimeStepResolution;
      }
    | {
        readonly terminalResponse: AgentResponse;
        readonly reviewerProviderInfo?: StepProviderInfo;
        readonly reviewerRuntime?: RuntimeStepResolution;
        readonly terminalOperation?: NonNullable<StepRunResult['terminalOperation']>;
      }
  > {
    const reviewerOutputStrategy = input.reviewerOutputStrategy;
    const reviewerSelectionIdentity = reviewerExecutionIdentity(
      this.deps.optionsBuilder.resolveStepProviderModel(
        input.step,
        input.runtime,
      ),
    );
    const reportStep = reviewerOutputStrategy.reportGeneration === 'structured'
      ? {
          ...input.executableStep,
          structuredOutput: createFindingReviewPublicationStructuredOutput(),
        }
      : input.step;
    const buildPhaseContext = (phase1Response: AgentResponse) => (
      this.deps.optionsBuilder.buildPhaseRunnerContext(
        reportStep,
        input.state,
        phase1Response.content,
        input.updatePersonaSession,
        this.deps.onPhaseStart,
        this.deps.onPhaseComplete,
        this.deps.onJudgeStage,
        input.state.iteration,
        input.runtime,
        input.onProviderAttempt,
      )
    );
    const phaseContext = buildPhaseContext(input.phase1Response);
    const reportFiles = input.step.outputContracts?.map((entry) => entry.name) ?? [];
    if (reportFiles.length !== 1) {
      throw new Error(
        `Finding contract reviewer "${input.step.name}" requires exactly one report`,
      );
    }
    const identity = this.findingReviewPublicationIdentity({
      parentStepName: input.parentStepName,
      stepIteration: input.stepIteration,
      reviewerStepName: input.step.name,
      reportName: reportFiles[0]!,
    });
    const publicationReportDir = this.deps.getRunPaths().reportsAbs;
    const publicationProtocol = this.findingReviewPublicationProtocolForStrategy(
      reviewerOutputStrategy,
    );
    const stored = loadFindingReviewPublication(
      publicationReportDir,
      identity,
    );
    if (stored !== undefined) {
      publishFindingReviewPublication(publicationReportDir, stored.publication);
      return {
        publication: stored.publication,
        response: {
          ...input.phase1Response,
          content: stored.publication.reportContent,
          structuredOutput: { rawFindings: [...stored.publication.rawFindings] },
        },
        ...(stored.relationClarification !== undefined
          ? { relationClarification: stored.relationClarification }
          : {}),
        ...(stored.reviewerExecutionIdentity !== undefined
          ? {
              reviewerProviderInfo: reviewerRuntime(
                stored.reviewerExecutionIdentity,
              ).providerInfo,
              reviewerRuntime: reviewerRuntime(stored.reviewerExecutionIdentity),
            }
          : {}),
      };
    }

    let phaseSequence = 0;
    const nextPhaseSequence = (): number => ++phaseSequence;
    const activePhase1Response = input.phase1Response;
    const generated = await generateReportPhase(
      reportStep,
      input.stepIteration,
      phaseContext,
      {
        reviewerOutputStrategy,
        nextPhaseSequence,
      },
    );
    if ('blocked' in generated) {
      return {
        terminalResponse: {
          ...activePhase1Response,
          status: 'blocked',
          content: generated.response.content,
        },
        reviewerProviderInfo: generated.providerInfo,
        reviewerRuntime: reviewerRuntime(
          reviewerExecutionIdentity(generated.providerInfo),
        ),
        terminalOperation: {
          origin: reviewerOperationOrigin(input.step.name),
          providerInfo: generated.providerInfo,
        },
      };
    }
    if ('rateLimited' in generated) {
      return {
        terminalResponse: {
          ...generated.response,
          persona: input.step.name,
        },
        reviewerProviderInfo: generated.providerInfo,
        reviewerRuntime: reviewerRuntime(
          reviewerExecutionIdentity(generated.providerInfo),
        ),
        terminalOperation: {
          origin: reviewerOperationOrigin(input.step.name),
          providerInfo: generated.providerInfo,
        },
      };
    }
    if (generated.reports.length !== 1) {
      throw new Error(
        `Finding contract reviewer "${input.step.name}" generated ${generated.reports.length} reports`,
      );
    }
    const report = generated.reports[0]!;
    const reportResponse = report.response;
    const completedReviewerExecutionIdentity = reviewerExecutionIdentity(
      report.attemptIdentity.providerInfo,
    );
    const completedReviewerRuntime = reviewerRuntime(
      completedReviewerExecutionIdentity,
    );
    if (reviewerOutputStrategy.intake === 'isolated_normalizer') {
      persistPendingFindingReviewNormalization(
        publicationReportDir,
        createPendingFindingReviewNormalization({
          identity,
          workflowName: this.deps.getWorkflowName(),
          reportContent: report.reportContent,
          reviewerExecutionIdentity: reviewerSelectionIdentity,
        }),
      );
    }
    const reportRuntime: RuntimeStepResolution = {
      ...input.runtime,
      providerInfo: report.attemptIdentity.providerInfo,
    };
    let normalizedPlainPublication: CanonicalFindingReviewPublication | undefined;
    let normalizerProviderInfo: StepProviderInfo | undefined;
    let normalized: StructuredOutputNormalizationResult;
    if (reviewerOutputStrategy.intake === 'isolated_normalizer') {
      const plainNormalization = await this.normalizePlainTextFindingReview({
        reviewerStep: input.step,
        reportResponse,
        reportContent: report.reportContent,
        state: input.state,
        identity,
        runtime: input.runtime,
      });
      normalized = plainNormalization;
      normalizerProviderInfo = plainNormalization.providerInfo;
      normalizedPlainPublication = plainNormalization.publication;
    } else {
      normalized = this.normalizeStructuredOutputWithDiagnostics(
        reportStep,
        reportResponse,
        reportRuntime,
      );
    }
    if (reviewerOutputStrategy.intake === 'reviewer_structured') {
      const reportStructuredOutput = reportResponse.structuredOutput
        ?? parseStructuredOutputObject(reportResponse.content);
      const publicationCorrectionInput: FindingReviewPublicationCorrectionInput = {
        reportContent: report.reportContent,
        rawFindings: reportStructuredOutput.rawFindings ?? null,
      };
      normalized = await correctStructuredOutputOnce({
        stepName: input.executableStep.name,
        initial: normalized,
        executeCorrection: (correctionInstruction) => executeAgent(
          input.executableStep.persona,
          correctionInstruction,
          {
            ...report.attemptIdentity.agentOptions,
            permissionMode: 'readonly',
            allowedTools: [],
            onPromptResolved: undefined,
            onStream: undefined,
            sessionId: report.attemptIdentity.sessionId,
          },
        ),
        normalize: (candidate) => this.normalizeStructuredOutputWithDiagnostics(
          reportStep,
          candidate,
          reportRuntime,
        ),
        publicationInput: publicationCorrectionInput,
      });
    }
    if (normalized.invalidDetail !== undefined) {
      throw new Error(
        `${
          reviewerOutputStrategy.intake === 'isolated_normalizer'
            ? `Finding intake normalizer for reviewer "${input.step.name}"`
            : `Finding contract reviewer "${input.step.name}"`
        } produced invalid intake: ${
          normalized.invalidDetail
        }`,
      );
    }
    if (
      normalized.response.status === 'blocked'
      || normalized.response.status === 'rate_limited'
    ) {
      return {
        terminalResponse: normalized.response,
        reviewerProviderInfo: report.attemptIdentity.providerInfo,
        reviewerRuntime: completedReviewerRuntime,
        ...(normalizerProviderInfo !== undefined
          ? {
              terminalOperation: {
                origin: findingIntakeNormalizerOperationOrigin(input.step.name),
                providerInfo: normalizerProviderInfo,
              },
            }
          : {}),
      };
    }
    if (normalized.response.status !== 'done') {
      throw new Error(
        `${
          reviewerOutputStrategy.intake === 'isolated_normalizer'
            ? `Finding intake normalizer for reviewer "${input.step.name}"`
            : `Finding contract reviewer "${input.step.name}"`
        } failed: ${
          normalized.response.error ?? normalized.response.content
        }`,
      );
    }
    if (
      reviewerOutputStrategy.intake === 'reviewer_structured'
      && findingReviewPublicationReportContent(normalized.response.structuredOutput)
        !== report.reportContent
    ) {
      throw new Error(
        `Finding contract reviewer "${input.step.name}" changed reportContent during intake correction`,
      );
    }

    let normalizedResponse = {
      ...normalized.response,
      content: report.reportContent,
    };
    let publicationResourceEnvelope = normalized.reviewerRawResourceEnvelope;
    let relationClarification: ReviewerRelationClarification | undefined;
    if (reviewerOutputStrategy.intake === 'reviewer_structured') {
      const ledgerStore = this.deps.findingLedgerStore;
      if (ledgerStore === undefined) {
        throw new Error('Finding contract reviewer requires a finding ledger store');
      }
      const currentSessionId = normalizedResponse.sessionId
        ?? report.attemptIdentity.sessionId;
      const clarified = await clarifyAmbiguousRawRelationsOnce({
        stepName: input.step.name,
        persona: input.executableStep.persona,
        response: {
          ...normalizedResponse,
          ...(currentSessionId !== undefined ? { sessionId: currentSessionId } : {}),
        },
        ledger: ledgerStore.loadLedger(),
        agentOptions: {
          ...report.attemptIdentity.agentOptions,
          sessionId: report.attemptIdentity.sessionId,
        },
        normalize: (candidate) => this.normalizeStructuredOutputWithDiagnostics(
          reportStep,
          candidate,
          reportRuntime,
        ),
        reviewerRawResourceEnvelope: normalized.reviewerRawResourceEnvelope,
        publicationInput: {
          reportContent: report.reportContent,
          rawFindings: normalizedResponse.structuredOutput?.rawFindings ?? [],
        },
      });
      normalizedResponse = {
        ...clarified.response,
        content: report.reportContent,
        structuredOutput: {
          reportContent: report.reportContent,
          rawFindings: clarified.response.structuredOutput?.rawFindings,
        },
      };
      publicationResourceEnvelope = clarified.reviewerRawResourceEnvelope;
      relationClarification = clarified.clarification;
    }
    if (normalizedResponse.sessionId !== undefined) {
      input.updatePersonaSession(
        report.attemptIdentity.sessionKey,
        normalizedResponse.sessionId,
      );
    }
    const publication = reviewerOutputStrategy.intake === 'isolated_normalizer'
      ? normalizedPlainPublication
      : createFindingReviewPublication({
          identity,
          protocol: publicationProtocol,
          reportContent: report.reportContent,
          rawFindings: this.rawFindingsFromResponse(
            input.step.name,
            normalizedResponse,
          ),
          reviewerRawResourceEnvelope: publicationResourceEnvelope,
        });
    if (publication === undefined) {
      throw new Error(
        `Finding intake normalizer for reviewer "${input.step.name}" produced no validated publication`,
      );
    }
    const persisted = persistFindingReviewPublication(
      publicationReportDir,
      {
        publication,
        ...(relationClarification !== undefined ? { relationClarification } : {}),
        reviewerExecutionIdentity: reviewerSelectionIdentity,
      },
    );
    const finalPublication = persisted.publication;
    publishFindingReviewPublication(publicationReportDir, finalPublication);
    return {
      publication: finalPublication,
      response: {
        ...normalizedResponse,
        content: finalPublication.reportContent,
        structuredOutput: { rawFindings: [...finalPublication.rawFindings] },
      },
      ...(persisted.relationClarification !== undefined
        ? { relationClarification: persisted.relationClarification }
        : {}),
      reviewerProviderInfo: report.attemptIdentity.providerInfo,
      reviewerRuntime: completedReviewerRuntime,
    };
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

        structuredOutput = parseStructuredOutputObject(response.content);
      }

      if (step.structuredOutput.schemaRef === FINDING_REVIEW_PUBLICATION_SCHEMA_REF) {
        const reportContent = findingReviewPublicationReportContent(structuredOutput);
        if (reportContent === undefined) {
          throw new Error('Finding review publication reportContent is missing');
        }
        const projected = projectReviewerRawStructuredOutputWithEnvelope({
          rawFindings: structuredOutput.rawFindings,
        });
        structuredOutput = {
          reportContent,
          ...projected.structuredOutput,
        };
        reviewerRawResourceEnvelope = projected.resourceEnvelope;
      } else if (step.structuredOutput.schemaRef === RAW_FINDINGS_SCHEMA_REF) {
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
      fallbackContext,
      workflowState: state,
      findingContract: this.buildFindingContractInstructionContext(step, findingContractPolicy),
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
          log.info('Report phase failed, continuing to status judgment', {
            step: step.name,
            error: getErrorMessage(reportError),
          });
        } else {
          throw reportError;
        }
      }
    }

    return this.applyPostExecutionRules(step, state, nextResponse, () => phaseCtx);
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
      if (preparedExecution.reviewerOutputStrategy === undefined) {
        throw new Error(`Prepared reviewer step "${step.name}" is missing reviewer output strategy`);
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
        throw new Error(`Prepared normalized reviewer step "${step.name}" must not require structured output`);
      }
    }
    const findingContractContext = preparedExecution?.findingContractContext;
    const reviewerOutputStrategy = preparedExecution?.reviewerOutputStrategy;
    const executableStep = preparedExecution?.executableStep ?? step as AgentWorkflowStep;
    const executionRuntime = this.resolveReviewerRuntime(executableStep, runtime);
    const publicationResumeRuntime = runtimeForOperation(
      runtime,
      findingIntakeNormalizerOperationOrigin(step.name),
      runtime?.providerInfo,
    );
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
      ?? this.buildPhase1Instruction(instruction, executableStep, executionRuntime);
    const providerInfo = this.deps.optionsBuilder.resolveStepProviderModel(
      executableStep,
      executionRuntime,
    );
    const sessionKey = buildSessionKey(executableStep, {
      provider: providerInfo.provider,
      model: providerInfo.model,
    });
    if (findingContractIntakeStep !== undefined) {
      if (reviewerOutputStrategy === undefined) {
        throw new Error(`Prepared reviewer step "${step.name}" is missing reviewer output strategy`);
      }
      const resumedPublication = await this.resumeFindingReviewPublication({
        step: findingContractIntakeStep,
        parentStepName: step.name,
        stepIteration,
        state,
        runtime: publicationResumeRuntime,
      });
      if (resumedPublication !== undefined) {
        if ('terminalResponse' in resumedPublication) {
          const response = resumedPublication.terminalResponse;
          state.stepOutputs.set(step.name, response);
          state.lastOutput = response;
          if (response.status === 'blocked') {
            this.persistPreviousResponseSnapshot(
              state,
              step.name,
              stepIteration,
              response.content,
            );
          }
          return {
            response,
            instruction: phase1Instruction,
            providerInfo: resumedPublication.reviewerProviderInfo ?? providerInfo,
            terminalOperation: resumedPublication.terminalOperation,
          };
        }
        await this.ingestFindingContractForNormalStep({
          step: findingContractIntakeStep,
          stepIteration,
          iteration: state.iteration,
          publication: resumedPublication.publication,
          priorStepResponseText,
          ...(resumedPublication.relationClarification !== undefined
            ? { relationClarification: resumedPublication.relationClarification }
            : {}),
        });
        const response = await this.applyPostExecutionRulesOnly(
          step,
          state,
          resumedPublication.response,
          updatePersonaSession,
          resumedPublication.reviewerRuntime
            ?? (
              resumedPublication.reviewerProviderInfo === undefined
                ? executionRuntime
                : { providerInfo: resumedPublication.reviewerProviderInfo }
            ),
        );
        state.stepOutputs.set(step.name, response);
        state.lastOutput = response;
        this.persistPreviousResponseSnapshot(
          state,
          step.name,
          stepIteration,
          response.content,
        );
        this.emitStepReports(
          step,
          {
            iteration: state.iteration,
            resumeStepName: step.name,
            stepIteration,
            providerInfo: resumedPublication.reviewerProviderInfo ?? providerInfo,
          },
        );
        return {
          response,
          instruction: phase1Instruction,
          providerInfo: resumedPublication.reviewerProviderInfo ?? providerInfo,
        };
      }
    }
    log.debug('Running step', {
      step: step.name,
      persona: step.persona ?? '(none)',
      stepIteration,
      iteration: state.iteration,
      sessionId: state.personaSessions.get(sessionKey) ?? 'new',
    });

    // Phase 1: main execution (Write excluded if step has report)
    const baseAgentOptions = this.deps.optionsBuilder.buildAgentOptions(
      executableStep,
      executionRuntime,
    );
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

    if (findingContractIntakeStep !== undefined) {
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
    } else {
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

    let completedReviewerProviderInfo = providerInfo;
    let completedReviewerRuntime: RuntimeStepResolution = {
      providerInfo,
    };
    if (findingContractIntakeStep && findingContractContext) {
      if (reviewerOutputStrategy === undefined) {
        throw new Error(`Prepared reviewer step "${step.name}" is missing reviewer output strategy`);
      }
      const phase1ProviderUsage = response.providerUsage;
      const prepared = await this.prepareFindingReviewPublication({
        step: findingContractIntakeStep,
        executableStep,
        reviewerOutputStrategy,
        parentStepName: step.name,
        stepIteration,
        state,
        phase1Response: response,
        agentOptions,
        onProviderAttempt: (providerInfo, success, usage) => {
          this.deps.recordSynthesizedAgentUsage(
            step.name,
            providerInfo,
            success,
            usage,
          );
        },
        updatePersonaSession,
        runtime: executionRuntime,
      });
      if ('terminalResponse' in prepared) {
        response = replaceResponseProviderUsage(
          prepared.terminalResponse,
          phase1ProviderUsage,
        );
        state.stepOutputs.set(step.name, response);
        state.lastOutput = response;
        if (response.status === 'blocked') {
          this.persistPreviousResponseSnapshot(
            state,
            step.name,
            stepIteration,
            response.content,
          );
        }
        return {
          response,
          instruction: phase1Instruction,
          providerInfo: prepared.reviewerProviderInfo ?? providerInfo,
          ...(prepared.terminalOperation !== undefined
            ? { terminalOperation: prepared.terminalOperation }
            : {}),
        };
      }
      completedReviewerProviderInfo = prepared.reviewerProviderInfo ?? providerInfo;
      completedReviewerRuntime = prepared.reviewerRuntime ?? {
        providerInfo: completedReviewerProviderInfo,
      };
      response = replaceResponseProviderUsage(
        prepared.response,
        phase1ProviderUsage,
      );
      await this.ingestFindingContractForNormalStep({
        step: findingContractIntakeStep,
        stepIteration,
        iteration: state.iteration,
        publication: prepared.publication,
        priorStepResponseText,
        relationClarification: prepared.relationClarification,
      });
    }

    let terminalOperation: StepRunResult['terminalOperation'];
    try {
      response = findingContractIntakeStep !== undefined
        ? await this.applyPostExecutionRulesOnly(
            step,
            state,
            response,
            updatePersonaSession,
            completedReviewerRuntime,
          )
        : await this.applyPostExecutionPhases(
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
        providerInfo: completedReviewerProviderInfo,
      },
    );
    return {
      response,
      instruction: phase1Instruction,
      providerInfo: completedReviewerProviderInfo,
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
