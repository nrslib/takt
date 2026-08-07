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
  NormalAgentWorkflowStep,
  ResolvedFacetPool,
  ResolvedFacetContent,
  WorkflowMaxSteps,
} from '../../models/types.js';
import { isNormalAgentWorkflowStep } from '../../models/types.js';
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
import type { DynamicFacetSelectorCoordinator } from '../dynamic-facets/dynamicFacetSelectorCoordinator.js';
import {
  generateReportPhase,
  runReportPhase,
  ReportPhaseGenerationError,
} from '../phase-runner.js';
import { writeReportFile } from '../report-writer.js';
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
} from '../instruction/instruction-context.js';
import { compactSessionBeforePhase1 } from './session-compaction.js';
import type { FindingLedgerStore } from '../findings/store.js';
import type {
  FindingManagerRunResult,
  FindingManagerSubStepResult,
} from '../findings/manager-runner.js';
import { runFindingEscalationReviewer } from '../findings/escalation-reviewer-runner.js';
import type { ProviderRoutingEntry } from '../../models/config-types.js';
import {
  assertFindingIntakeNormalizerProvider,
  buildFindingIntakeNormalizerSteps,
  supportsFindingIntakeNormalizerExecution,
} from '../findings/intake-normalize-policy.js';
import {
  assertFindingContractReviewerStep,
  ingestFindingContractResults,
  resolveFindingContractIntakeStep,
} from '../findings/contract-intake.js';
import {
  describeRawFindingExtractionFidelityFailure,
  describeRawFindingExtractionFidelityFailures,
  EXTRACTION_FIDELITY_INVALID_DETAIL,
} from '../findings/extraction-fidelity.js';
import type { ReviewerRelationClarification } from '../findings/relation-coherence.js';
import {
  RAW_FINDINGS_SCHEMA_REF,
  projectReviewerRawStructuredOutputWithEnvelope,
  type ReviewerRawResourceEnvelope,
} from '../findings/raw-canonicalization.js';
import { invalidateExpectedPersonaSession, invalidatePersonaSessionIfExpected } from './session-invalidation.js';
import type { InstructionBuildTransaction } from './instruction-build-transaction.js';
import { evaluatePostExecutionRules } from './post-execution-rule-evaluator.js';
import type { PullRequestContext } from '../pr-context.js';
import type { TaskReviewScope } from '../review-scope.js';
import { requireWorkflowResumeStackSnapshot } from '../run/resume-point.js';
import type { StructuredOutputNormalizationResult } from './structured-output-normalization.js';
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
  discardPendingFindingReviewNormalization,
  FindingReviewPublicationSourceBindingError,
  loadFindingReviewPublication,
  loadPendingFindingReviewNormalization,
  persistFindingReviewPublication,
  persistPendingFindingReviewNormalization,
  publishFindingReviewPublication,
  PLAIN_TEXT_NORMALIZED_FINDING_REVIEW_PUBLICATION_PROTOCOL,
  type CanonicalFindingReviewPublication,
  type FindingReviewPresentationContext,
  type FindingReviewPublicationIdentity,
  type ReviewerExecutionIdentity,
} from '../findings/review-publication.js';
import { recordVerdictClaimsMismatchAnomalies } from '../findings/verdict-claims-integrity.js';
import {
  recordReviewReportProtocolAnomalies,
  reviewReportProtocolRejectionResponse,
  type ReviewReportProtocolRejection,
} from '../findings/review-report-protocol.js';
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
  readonly structuredCaller?: StructuredCaller;
  /** runtime.yaml の `intake-normalizer` seat。正規化係の最優先上書き。 */
  readonly intakeNormalizerProvider?: ProviderRoutingEntry;
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
  readonly dynamicFacetSelectorCoordinator?: DynamicFacetSelectorCoordinator;
  readonly getFacetPool?: (name: string) => ResolvedFacetPool | undefined;
}

/**
 * 通常 agent ステップを実行前に確定した結果。RunLoop の観測イベント、
 * StepExecutor、provider がこの同じ値を共有する。
 */
export interface PreparedNormalStepExecution {
  readonly executableStep: AgentWorkflowStep;
  readonly findingContractContext?: FindingContractInstructionContext;
  /** owner context を組んだときの ledger / presentation counts 凍結キー（escalation slot と共有する）。 */
  readonly findingContractFreezeKey?: string;
  readonly phase1Instruction: string;
  readonly priorStepResponseText?: string;
  readonly stepIteration: number;
}

/** prepareFindingReviewPublication の入力。通常レビュアーと格上げ再レビューで共有する。 */
export interface FindingReviewPublicationPreparationInput {
  readonly step: AgentWorkflowStep;
  readonly executableStep: AgentWorkflowStep;
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
  readonly presentationContext?: FindingReviewPresentationContext;
  /**
   * Phase 2 で使う Finding Contract context。Phase 1 で凍結したものをそのまま
   * 渡すこと。省略すると Phase 2 が step 名から組み直し、ledger と提示回数を
   * 読み直して再提示 batch を作り直すため、Phase 1 と Phase 2 で request 集合が
   * 食い違う（escalation slot では restatement-only 契約そのものが消える）。
   */
  readonly findingContractContext?: FindingContractInstructionContext;
}

/** 正規化係の1候補（解決チェーンの1段）。 */
interface FindingIntakeNormalizerCandidate {
  readonly step: AgentWorkflowStep;
  readonly providerInfo: StepProviderInfo;
}

type FindingIntakeNormalizationResult = StructuredOutputNormalizationResult & {
  readonly providerInfo: StepProviderInfo;
  readonly publication?: CanonicalFindingReviewPublication;
  /**
   * 失敗の原因がレビュアーの報告側にある（rawExcerpt が報告本文に byte-exact で
   * 束縛できない）。正規化係を乗り換えても解消しない種類の失敗。
   */
  readonly reportSourceBinding?: true;
  /** 報告側原因が訂正1回でも解消しなかった。値は言い直し要求へ載せる具体的理由。 */
  readonly reportSourceRejection?: string;
};

type FindingIntakeNormalizerAttempt =
  | { readonly kind: 'published'; readonly result: FindingIntakeNormalizationResult }
  | { readonly kind: 'terminal'; readonly result: FindingIntakeNormalizationResult }
  | {
      readonly kind: 'report_source';
      readonly reason: string;
      readonly result: FindingIntakeNormalizationResult;
    }
  | {
      readonly kind: 'failed';
      readonly reason: string;
      /** engine 側スキーマの不備。別 provider でやり直しても直らないので後退しない。 */
      readonly engineFault: boolean;
      readonly result: FindingIntakeNormalizationResult;
    };

/** 報告側原因で publication が成立しなかった1レビュアー分の結果。 */
export interface FindingReviewPublicationReportRejection {
  readonly reason: string;
  readonly reportContent: string;
}

export type FindingReviewPublicationPreparation =
  | {
      readonly reportRejection: FindingReviewPublicationReportRejection;
      readonly reviewerProviderInfo?: StepProviderInfo;
      readonly reviewerRuntime?: RuntimeStepResolution;
    }
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
    };

export class StepExecutor {
  private readonly structuredOutputNormalizers: StructuredOutputNormalizerRegistry;

  private findingContractFreezeSequence = 0;

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

  private resolveDynamicFacetPool(step: NormalAgentWorkflowStep): ResolvedFacetPool | undefined {
    if (step.dynamicFacets === undefined) return undefined;
    return this.deps.getFacetPool?.(step.dynamicFacets.pool);
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
    return this.deps.optionsBuilder.buildFindingContractInstructionContext?.(step, false);
  }

  /**
   * 単独ステップの Finding Contract 取り込み対象かどうかを判定する。
   * 述語の実体は contract-intake.ts の resolveFindingContractIntakeStep
   * （workflowPreview.ts と共有）。
   */
  private resolveFindingContractIntakeStep(step: WorkflowStep): AgentWorkflowStep | undefined {
    return resolveFindingContractIntakeStep(step, this.deps.findingContract);
  }

  /**
   * 単独 FC reviewer step の格上げ再レビュー。owner publication 成立後・manager
   * 取り込み前に一度だけ実行する（parallel 経路と同型）。owner が格上げ先を
   * 持たない、または今ラウンドに格上げ対象の anomaly も未取り込みの stored
   * publication も無い場合は undefined。
   *
   * 提示回数の判定は owner context を組んだ時点で凍結した ledger /
   * presentation counts を使う。owner publication 永続化後に数え直すと、
   * 同じ iteration で owner の (limit-1) 回目と escalation が二重に走る。
   */
  private async runEscalationReviewerForNormalStep(input: {
    parentStepName: string;
    ownerReviewerStep: AgentWorkflowStep;
    findingContractContext: FindingContractInstructionContext | undefined;
    findingContractFreezeKey: string | undefined;
    stepIteration: number;
    state: WorkflowState;
    task: string;
    maxSteps: WorkflowMaxSteps;
    updatePersonaSession: (persona: string, sessionId: string | undefined) => void;
    runtime?: RuntimeStepResolution;
  }): Promise<
    | { reviewerResults: readonly FindingManagerSubStepResult[] }
    | {
        terminalResponse: AgentResponse;
        providerInfo?: StepProviderInfo;
        terminalOperation?: NonNullable<StepRunResult['terminalOperation']>;
      }
    | undefined
  > {
    const ownerReviewer = input.findingContractContext?.reviewer;
    if (
      this.deps.findingContract === undefined
      || ownerReviewer === undefined
      || input.findingContractFreezeKey === undefined
    ) {
      return undefined;
    }
    const escalationContexts = this.deps.optionsBuilder.buildFindingEscalationInstructionContexts({
      // owner 名は publication identity の reviewerStepName（= anomaly の
      // presentationOwnerReviewer）と同じ値でなければならない。単独ステップでは
      // parent step 名と一致するが、意味が違う値なので reviewer step から取る。
      ownerReviewerSteps: [input.ownerReviewerStep],
      reviewScopeSnapshotId: ownerReviewer.reviewScopeSnapshotId,
      findingContractFreezeKey: input.findingContractFreezeKey,
    });
    const outcome = await runFindingEscalationReviewer({
      escalationContexts,
      ownerReviewerSteps: [input.ownerReviewerStep],
      parentStepName: input.parentStepName,
      stepIteration: input.stepIteration,
      state: input.state,
      task: input.task,
      maxSteps: input.maxSteps,
      optionsBuilder: this.deps.optionsBuilder,
      stepExecutor: this,
      updatePersonaSession: input.updatePersonaSession,
      runtime: input.runtime,
    });
    if (outcome === undefined) {
      return undefined;
    }
    if (outcome.kind === 'published') {
      return {
        reviewerResults: outcome.results.map((result) => ({
          subStep: result.step,
          publication: result.publication,
          ...(result.relationClarification === undefined
            ? {}
            : { relationClarification: result.relationClarification }),
        })),
      };
    }
    return {
      terminalResponse: outcome.response,
      ...(outcome.providerInfo === undefined ? {} : { providerInfo: outcome.providerInfo }),
      ...(outcome.terminalOperation === undefined
        ? {}
        : { terminalOperation: outcome.terminalOperation }),
    };
  }

  private escalationTerminalStepResult(input: {
    step: WorkflowStep;
    state: WorkflowState;
    stepIteration: number;
    instruction: string;
    fallbackProviderInfo: StepProviderInfo;
    escalation: {
      terminalResponse: AgentResponse;
      providerInfo?: StepProviderInfo;
      terminalOperation?: NonNullable<StepRunResult['terminalOperation']>;
    };
  }): StepRunResult {
    const response = input.escalation.terminalResponse;
    input.state.stepOutputs.set(input.step.name, response);
    input.state.lastOutput = response;
    if (response.status === 'blocked') {
      this.persistPreviousResponseSnapshot(
        input.state,
        input.step.name,
        input.stepIteration,
        response.content,
      );
    }
    return {
      response,
      instruction: input.instruction,
      providerInfo: input.escalation.providerInfo ?? input.fallbackProviderInfo,
      ...(input.escalation.terminalOperation === undefined
        ? {}
        : { terminalOperation: input.escalation.terminalOperation }),
    };
  }

  /**
   * 報告側原因で publication が成立しなかったレビュアーを台帳へ記録する。
   * ParallelRunner も同じ入口を使う（記録規則を1箇所に保つ）。
   */
  async recordReviewReportProtocolRejections(input: {
    readonly parentStepName: string;
    readonly stepIteration: number;
    /** そのラウンドで成立した publication の ID 全件。round marker の同一性に使う。 */
    readonly publicationIds: readonly string[];
    readonly rejections: readonly ReviewReportProtocolRejection[];
  }): Promise<void> {
    if (input.rejections.length === 0 || this.deps.findingContract === undefined) {
      return;
    }
    await recordReviewReportProtocolAnomalies({
      ledgerStore: this.deps.findingLedgerStore,
      findingContract: this.deps.findingContract,
      rejections: input.rejections,
      publicationIds: input.publicationIds,
      runId: this.deps.getRunId(),
      callNamespace: this.deps.getFindingCallNamespace(),
      parentStepName: input.parentStepName,
      stepIteration: input.stepIteration,
      timestamp: new Date().toISOString(),
      refreshFindingsState: this.deps.refreshFindingsState,
    });
  }

  private async ingestFindingContractForNormalStep(input: {
    step: AgentWorkflowStep;
    stepIteration: number;
    iteration: number;
    publication: CanonicalFindingReviewPublication;
    priorStepResponseText: string | undefined;
    relationClarification?: ReviewerRelationClarification;
    escalationResults?: readonly FindingManagerSubStepResult[];
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
      subResults: [
        {
          subStep: input.step,
          publication: input.publication,
          ...(input.relationClarification !== undefined ? { relationClarification: input.relationClarification } : {}),
        },
        ...(input.escalationResults ?? []),
      ],
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
      reviewPublicationDir: this.deps.getRunPaths().reportsAbs,
      refreshFindingsState: this.deps.refreshFindingsState,
      emitEvent: this.deps.emitEvent,
    });
  }

  /**
   * 単独 FC レビュアーの判定/claim 整合ゲート。新規実行と保存済み publication の
   * 再開で共有する — 片方だけに配線すると、その副経路でだけ非承認判定が黙殺される。
   */
  private async recordVerdictClaimsMismatch(input: {
    step: WorkflowStep;
    response: AgentResponse;
    publication: CanonicalFindingReviewPublication;
    roundMarker: string;
  }): Promise<void> {
    if (this.deps.findingContract === undefined) {
      return;
    }
    await recordVerdictClaimsMismatchAnomalies({
      ledgerStore: this.deps.findingLedgerStore,
      findingContract: this.deps.findingContract,
      observations: [{
        step: input.step,
        response: input.response,
        publication: input.publication,
      }],
      interactive: this.deps.getInteractive(),
      runId: this.deps.getRunId(),
      parentStepName: input.step.name,
      roundMarker: input.roundMarker,
      timestamp: new Date().toISOString(),
      refreshFindingsState: this.deps.refreshFindingsState,
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
    const findingContractIntakeStep = this.resolveFindingContractIntakeStep(step);
    const reviewerRuntime = findingContractIntakeStep === undefined
      ? runtime
      : this.resolveReviewerRuntime(findingContractIntakeStep, runtime);
    if (findingContractIntakeStep !== undefined) {
      assertFindingContractReviewerStep(findingContractIntakeStep);
    }
    // owner context と escalation slot が同じ ledger / presentation counts を
    // 見るよう、ここで一度だけ凍結する（parallel の共有 freeze と同じ役割）。
    const findingContractFreezeKey = findingContractIntakeStep === undefined
      ? undefined
      : `${step.name}\0${stepIteration}\0${++this.findingContractFreezeSequence}`;
    const findingContractContext = findingContractIntakeStep
      ? this.deps.optionsBuilder.buildFindingContractInstructionContext(
          findingContractIntakeStep,
          true,
          undefined,
          findingContractFreezeKey,
        )
      : this.buildFindingContractInstructionContext(step, undefined);
    let executableStep = step as AgentWorkflowStep;
    if (
      isNormalAgentWorkflowStep(step)
      && step.dynamicFacets !== undefined
    ) {
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
      );
      executableStep = {
        ...executableStep,
        policyContents: result.effectivePolicyContents.map((content) => ({ content })),
        knowledgeContents: result.effectiveKnowledgeContents.map((content) => ({ content })),
      } as AgentWorkflowStep;
    }
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
      ...(findingContractFreezeKey !== undefined ? { findingContractFreezeKey } : {}),
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
   *
   * `attemptProviderInfo` は、その呼び出しが実際に使った provider/model。
   * report phase の fallback のように attempt ごとに provider が変わる経路では
   * これを渡さないと、fallback で走った試行を primary として計上してしまう。
   * 単発呼び出し（findings-manager 等）は省略でき、ステップ解決結果を使う。
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

  /**
   * 正規化係の合成ステップ列（ロード時 preflight と共有する builder）。
   *
   * escalate の解決に runtime を渡さないのは、rate-limit fallback で一時的に別
   * provider へ振られていても格上げ先は構成上の profile から決まる値であり、
   * 提示フェーズの判定（WorkflowEngineSetup）と同じ基準にそろえるため。
   */
  private buildFindingIntakeNormalizerSteps(
    reviewerStep: AgentWorkflowStep,
  ): readonly AgentWorkflowStep[] {
    return buildFindingIntakeNormalizerSteps({
      reviewerStepName: reviewerStep.name,
      seat: this.deps.intakeNormalizerProvider,
      escalation: this.deps.optionsBuilder.resolveStepProviderModel(reviewerStep).escalation,
      workflowProvider: this.deps.workflowProvider,
      workflowModel: this.deps.workflowModel,
    });
  }

  /**
   * 実際に走らせる正規化係の候補。
   *
   * 先頭は必ず走るので、隔離 structured 実行に対応しないなら理由付きで止める。
   * 2件目は「先頭と provider/model が異なり、かつ隔離 structured 実行に対応する
   * チェーン上の最初の候補」だけを取る。レビュアーが markdown しか書かなくなった
   * 以上、正規化係はラウンド唯一の関門であり、1モデルの出力事故でラウンド全体を
   * 落とさないための1段だけの後退である。
   */
  private resolveFindingIntakeNormalizerCandidates(
    reviewerStep: AgentWorkflowStep,
    runtime: RuntimeStepResolution | undefined,
  ): readonly FindingIntakeNormalizerCandidate[] {
    const resolved = this.buildFindingIntakeNormalizerSteps(reviewerStep).map(
      (step): FindingIntakeNormalizerCandidate => {
        const baseProviderInfo = this.deps.optionsBuilder.resolveStepProviderModel(step);
        const normalizerRuntime = runtimeForOperation(
          runtime,
          findingIntakeNormalizerOperationOrigin(reviewerStep.name),
          baseProviderInfo,
        );
        return {
          step,
          providerInfo: {
            ...(normalizerRuntime?.providerInfo ?? baseProviderInfo),
            providerOptions: baseProviderInfo.providerOptions,
          },
        };
      },
    );
    const primary = resolved[0];
    if (primary === undefined) {
      throw new Error(
        `Finding intake normalizer has no resolution candidate for reviewer "${reviewerStep.name}"`,
      );
    }
    assertFindingIntakeNormalizerProvider(primary.providerInfo.provider, reviewerStep.name);
    const retry = resolved.slice(1).find((candidate) => (
      supportsFindingIntakeNormalizerExecution(candidate.providerInfo.provider)
      && (
        candidate.providerInfo.provider !== primary.providerInfo.provider
        || candidate.providerInfo.model !== primary.providerInfo.model
      )
    ));
    return retry === undefined ? [primary] : [primary, retry];
  }

  private requireStructuredCaller(): StructuredCaller {
    if (this.deps.structuredCaller === undefined) {
      throw new Error(
        'Finding intake normalizer requires a structured caller',
      );
    }
    return this.deps.structuredCaller;
  }

  /**
   * 1回の正規化呼び出しが「取り込める publication を作れなかった」理由を、必ず
   * 非空の文字列で返す。undefined は成功。
   *
   * provider 応答の error / content がどちらも空になる経路があるため、
   * `?? ''` 相当の連鎖で理由を組み立てない — 実走で「correction failed:」の後ろが
   * 空文字になり、原因の特定が不能になった。
   */
  private static describeNormalizerAttemptFailure(
    result: FindingIntakeNormalizationResult,
  ): string | undefined {
    if (result.invalidDetail !== undefined) {
      return result.invalidDetail;
    }
    if (result.response.status !== 'done') {
      const detail = result.response.error ?? result.response.content;
      return `status=${result.response.status}: ${
        detail !== undefined && detail.trim().length > 0 ? detail : 'no provider detail'
      }`;
    }
    const fidelityFailures = describeRawFindingExtractionFidelityFailures(
      result.response.structuredOutput,
    );
    if (fidelityFailures.length > 0) {
      // 判定は projection 後の structuredOutput に対して行うため、モデルが出した
      // 最終テキストだけではなく status と projection 後の内訳を必ず添える。
      return `${EXTRACTION_FIDELITY_INVALID_DETAIL} [status=${result.response.status}; ${
        describeRawFindingExtractionFidelityFailure(result.response.structuredOutput)
      }]`;
    }
    return result.publication === undefined
      ? 'produced no validated publication'
      : undefined;
  }

  private static describeNormalizerCandidate(
    candidate: FindingIntakeNormalizerCandidate,
  ): string {
    const { provider, model } = candidate.providerInfo;
    return model === undefined ? `${provider}` : `${provider}/${model}`;
  }

  private static isTerminalNormalizerResponse(response: AgentResponse): boolean {
    return response.status === 'blocked' || response.status === 'rate_limited';
  }

  /**
   * 1候補の正規化係を「初回 + 訂正1回」まで走らせる。訂正を試みるのはモデル出力
   * 起因の不正（invalidKind='model_output' / 抽出忠実性の退行）だけで、
   * engine 側スキーマの不備（'schema_config'）は訂正もやり直しもせず即座に上げる。
   */
  private async runFindingIntakeNormalizerCandidate(input: {
    readonly reviewerStep: AgentWorkflowStep;
    readonly reportContent: string;
    readonly state: WorkflowState;
    readonly identity: FindingReviewPublicationIdentity;
    readonly presentationContext?: FindingReviewPresentationContext;
    readonly candidate: FindingIntakeNormalizerCandidate;
  }): Promise<FindingIntakeNormalizerAttempt> {
    const structuredCaller = this.requireStructuredCaller();
    const normalizerStep = input.candidate.step;
    const providerInfo = input.candidate.providerInfo;
    assertFindingIntakeNormalizerProvider(providerInfo.provider, input.reviewerStep.name);
    const normalizerProvider = providerInfo.provider;
    const runtime: RuntimeStepResolution = { providerInfo };
    const execute = async (
      mode: 'initial' | 'correction',
      extractionFidelityCorrection = false,
    ): Promise<FindingIntakeNormalizationResult> => {
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
          extractionFidelityCorrection,
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
            ...(input.presentationContext === undefined
              ? {}
              : { presentationContext: input.presentationContext }),
          }),
        };
      } catch (error) {
        return {
          ...normalized,
          providerInfo,
          invalidDetail: getErrorMessage(error),
          invalidKind: 'model_output',
          // 報告本文へ束縛できないのはレビュアーの報告側の問題。正規化係の
          // 出力形の問題（スキーマ不成立・candidate 喪失）とは切り分ける。
          ...(error instanceof FindingReviewPublicationSourceBindingError
            ? { reportSourceBinding: true as const }
            : {}),
        };
      }
    };

    const initial = await execute('initial');
    if (StepExecutor.isTerminalNormalizerResponse(initial.response)) {
      return { kind: 'terminal', result: initial };
    }
    const initialFailure = StepExecutor.describeNormalizerAttemptFailure(initial);
    if (initialFailure === undefined) {
      return { kind: 'published', result: initial };
    }
    if (initial.invalidKind === 'schema_config') {
      return { kind: 'failed', reason: initialFailure, engineFault: true, result: initial };
    }
    const extractionFidelityCorrection = initial.invalidDetail === undefined
      && initial.response.status === 'done';
    const corrected = await execute('correction', extractionFidelityCorrection);
    if (StepExecutor.isTerminalNormalizerResponse(corrected.response)) {
      return { kind: 'terminal', result: corrected };
    }
    const correctedFailure = StepExecutor.describeNormalizerAttemptFailure(corrected);
    if (correctedFailure === undefined) {
      return { kind: 'published', result: corrected };
    }
    if (initial.reportSourceBinding === true && corrected.reportSourceBinding === true) {
      // 訂正しても報告本文へ束縛できない = 報告側の問題。別の正規化係でも
      // 同じ報告を読む以上結果は変わらないので、やり直さず言い直しへ回す。
      return {
        kind: 'report_source',
        reason: `report text could not be bound after one correction (initial: ${initialFailure}; corrected: ${correctedFailure})`,
        result: corrected,
      };
    }
    return {
      kind: 'failed',
      reason: `remained invalid after one correction (initial: ${initialFailure}; corrected: ${correctedFailure})`,
      engineFault: corrected.invalidKind === 'schema_config',
      result: corrected,
    };
  }

  /**
   * レビュアーの markdown レポートから raw findings を取り出す。経路はこれ1本で、
   * 先頭候補が検証と訂正1回でも通らなければ解決チェーンの次の候補で1度だけ
   * やり直す。それでも通らなければ理由を連ねて fail-loud にする。
   */
  private async normalizePlainTextFindingReview(input: {
    readonly reviewerStep: AgentWorkflowStep;
    readonly reportResponse: AgentResponse;
    readonly reportContent: string;
    readonly state: WorkflowState;
    readonly identity: FindingReviewPublicationIdentity;
    readonly runtime?: RuntimeStepResolution;
    readonly presentationContext?: FindingReviewPresentationContext;
  }): Promise<FindingIntakeNormalizationResult> {
    const candidates = this.resolveFindingIntakeNormalizerCandidates(
      input.reviewerStep,
      input.runtime,
    );
    const failures: string[] = [];
    let lastResult: FindingIntakeNormalizationResult | undefined;
    for (const candidate of candidates) {
      const attempt = await this.runFindingIntakeNormalizerCandidate({
        reviewerStep: input.reviewerStep,
        reportContent: input.reportContent,
        state: input.state,
        identity: input.identity,
        ...(input.presentationContext === undefined
          ? {}
          : { presentationContext: input.presentationContext }),
        candidate,
      });
      lastResult = attempt.result;
      if (attempt.kind === 'terminal') {
        // 終端メタデータ（status / error / errorKind / rateLimitInfo / timestamp）は
        // 正規化係の応答から取るが、本文はレビュアーのレポートを正本のまま残す。
        // 正規化係の終端メッセージが本文を置き換えると、後続 step の
        // {previous_response} と snapshot にレビュー結果でない文字列が流れる。
        const terminal = attempt.result.response;
        return {
          ...attempt.result,
          response: {
            ...input.reportResponse,
            content: input.reportContent,
            status: terminal.status,
            timestamp: terminal.timestamp,
            ...(terminal.error === undefined ? {} : { error: terminal.error }),
            ...(terminal.errorKind === undefined ? {} : { errorKind: terminal.errorKind }),
            ...(terminal.rateLimitInfo === undefined
              ? {}
              : { rateLimitInfo: terminal.rateLimitInfo }),
          },
        };
      }
      if (attempt.kind === 'report_source') {
        return {
          response: {
            ...attempt.result.response,
            status: 'error',
            error: `Finding intake normalizer for reviewer "${input.reviewerStep.name}" rejected the report: ${
              attempt.reason
            }`,
          },
          providerInfo: attempt.result.providerInfo,
          reportSourceRejection: attempt.reason,
        };
      }
      if (attempt.kind === 'published') {
        return {
          response: {
            ...input.reportResponse,
            content: input.reportContent,
            structuredOutput: attempt.result.response.structuredOutput,
          },
          providerInfo: attempt.result.providerInfo,
          reviewerRawResourceEnvelope: attempt.result.reviewerRawResourceEnvelope,
          publication: attempt.result.publication,
        };
      }
      failures.push(`${StepExecutor.describeNormalizerCandidate(candidate)}: ${attempt.reason}`);
      if (attempt.engineFault) {
        break;
      }
    }
    if (lastResult === undefined) {
      throw new Error(
        `Finding intake normalizer for reviewer "${input.reviewerStep.name}" ran no candidate`,
      );
    }
    return {
      response: {
        ...lastResult.response,
        status: 'error',
        error: `Finding intake normalizer for reviewer "${input.reviewerStep.name}" failed: ${
          failures.join(' | ')
        }`,
      },
      providerInfo: lastResult.providerInfo,
      reviewerRawResourceEnvelope: lastResult.reviewerRawResourceEnvelope,
    };
  }

  async resumeFindingReviewPublication(input: {
    readonly step: AgentWorkflowStep;
    readonly parentStepName: string;
    readonly stepIteration: number;
    readonly state: WorkflowState;
    readonly runtime?: RuntimeStepResolution;
    readonly presentationContext?: FindingReviewPresentationContext;
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
  } | {
    readonly reportRejection: FindingReviewPublicationReportRejection;
    readonly reviewerProviderInfo?: StepProviderInfo;
    readonly reviewerRuntime?: RuntimeStepResolution;
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
      // 保存済みの報告も「レポートは在る」状態にそろえる。正規化が拒否・失敗して
      // publication が成立しない経路でも、Phase 3 と後続 step は同じファイルを読む。
      writeReportFile(reportDir, pending.reportName, pending.reportContent);
      const normalized = await this.normalizePlainTextFindingReview({
        reviewerStep: input.step,
        reportResponse,
        reportContent: pending.reportContent,
        state: input.state,
        identity,
        runtime: input.runtime,
        presentationContext: pending.presentationContext,
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
      if (normalized.reportSourceRejection !== undefined) {
        // 保存済みの報告を読み直しても同じ結論になる（原因は報告側）。記録を
        // 残すと resume のたびに同じ拒否を再生産して枠が塞がるので破棄し、
        // 次の機会は新規レビューの生成経路から始める。
        discardPendingFindingReviewNormalization(reportDir, identity);
        return {
          reportRejection: {
            reason: normalized.reportSourceRejection,
            reportContent: pending.reportContent,
          },
          reviewerProviderInfo: persistedReviewerRuntime.providerInfo,
          reviewerRuntime: persistedReviewerRuntime,
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

  async prepareFindingReviewPublication(
    input: FindingReviewPublicationPreparationInput,
  ): Promise<FindingReviewPublicationPreparation> {
    const reviewerSelectionIdentity = reviewerExecutionIdentity(
      this.deps.optionsBuilder.resolveStepProviderModel(input.step, input.runtime),
    );
    const reportStep = input.step;
    const explicitFindingContractContext = input.findingContractContext;
    const buildPhaseContext = (phase1Response: AgentResponse) => {
      const phaseContext = this.deps.optionsBuilder.buildPhaseRunnerContext(
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
      );
      return explicitFindingContractContext === undefined
        ? phaseContext
        : {
            ...phaseContext,
            buildFindingContractInstructionContext: () => explicitFindingContractContext,
          };
    };
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
        findingContractReviewer: true,
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
    // レビュアーの markdown レポートはこの時点で実在する。取り込み（正規化）の
    // 成否はレポートの有無と関係ないので、publication の成立を待たずに書き出す。
    // Phase 3 の use_judge も後続 step のレポート参照もこのファイルを読むため、
    // 拒否・失敗した報告でも「レポートは在る」状態にそろえる。
    writeReportFile(publicationReportDir, report.reportName, report.reportContent);
    persistPendingFindingReviewNormalization(
      publicationReportDir,
      createPendingFindingReviewNormalization({
        identity,
        workflowName: this.deps.getWorkflowName(),
        reportContent: report.reportContent,
        reviewerExecutionIdentity: reviewerSelectionIdentity,
        ...(input.presentationContext === undefined ? {} : { presentationContext: input.presentationContext }),
      }),
    );
    const normalized = await this.normalizePlainTextFindingReview({
      reviewerStep: input.step,
      reportResponse,
      reportContent: report.reportContent,
      state: input.state,
      identity,
      runtime: input.runtime,
      presentationContext: input.presentationContext,
    });
    if (normalized.reportSourceRejection !== undefined) {
      return {
        reportRejection: {
          reason: normalized.reportSourceRejection,
          reportContent: report.reportContent,
        },
        reviewerProviderInfo: report.attemptIdentity.providerInfo,
        reviewerRuntime: completedReviewerRuntime,
      };
    }
    if (normalized.invalidDetail !== undefined) {
      throw new Error(
        `Finding intake normalizer for reviewer "${input.step.name}" produced invalid intake: ${
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
        terminalOperation: {
          origin: findingIntakeNormalizerOperationOrigin(input.step.name),
          providerInfo: normalized.providerInfo,
        },
      };
    }
    if (normalized.response.status !== 'done') {
      throw new Error(
        normalized.response.error
          ?? `Finding intake normalizer for reviewer "${input.step.name}" failed with status ${
            normalized.response.status
          }`,
      );
    }
    const normalizedResponse = {
      ...normalized.response,
      content: report.reportContent,
    };
    if (normalizedResponse.sessionId !== undefined) {
      input.updatePersonaSession(
        report.attemptIdentity.sessionKey,
        normalizedResponse.sessionId,
      );
    }
    const publication = normalized.publication;
    if (publication === undefined) {
      throw new Error(
        `Finding intake normalizer for reviewer "${input.step.name}" produced no validated publication`,
      );
    }
    const persisted = persistFindingReviewPublication(
      publicationReportDir,
      {
        publication,
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

      if (step.structuredOutput.schemaRef === RAW_FINDINGS_SCHEMA_REF) {
        const projected = projectReviewerRawStructuredOutputWithEnvelope(structuredOutput);
        structuredOutput = projected.structuredOutput;
        reviewerRawResourceEnvelope = projected.resourceEnvelope;
      }

      // post-hoc 検証は寛容版（validationSchema）を優先する。provider へ渡る
      // 生成拘束用 schema（strict 様式）とは役割が異なる — 詳細は
      // WorkflowStructuredOutput の doc コメント参照。
      const validationSchema = step.structuredOutput.validationSchema
        ?? step.structuredOutput.schema;
      validateStructuredOutputAgainstSchema(
        structuredOutput,
        validationSchema,
      );
      structuredOutput = this.structuredOutputNormalizers.normalize(structuredOutput, {
        step,
        language: this.deps.getLanguage(),
      });
      validateStructuredOutputAgainstSchema(structuredOutput, validationSchema);
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
      if (preparedExecution.findingContractContext.reviewer === undefined) {
        throw new Error(`Prepared reviewer step "${step.name}" is missing reviewer context`);
      }
      assertFindingContractReviewerStep(preparedExecution.executableStep);
    }
    const findingContractContext = preparedExecution?.findingContractContext;
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
      const resumedPublication = await this.resumeFindingReviewPublication({
        step: findingContractIntakeStep,
        parentStepName: step.name,
        stepIteration,
        state,
        runtime: publicationResumeRuntime,
        presentationContext: findingContractContext?.reviewer?.presentationContext,
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
        if ('reportRejection' in resumedPublication) {
          // 保存済み報告を読み直しても報告側原因。取り込みは行わず anomaly だけ
          // 記録し、ラン全体は落とさずに言い直し経路へ回す。
          await this.recordReviewReportProtocolRejections({
            parentStepName: step.name,
            stepIteration,
            publicationIds: [],
            rejections: [{
              reviewerStepName: findingContractIntakeStep.name,
              reviewerPersonaKey: findingContractIntakeStep.persona ?? findingContractIntakeStep.name,
              reportContent: resumedPublication.reportRejection.reportContent,
              reason: resumedPublication.reportRejection.reason,
            }],
          });
          const rejectedResponse = reviewReportProtocolRejectionResponse({
            stepName: step.name,
            reportContent: resumedPublication.reportRejection.reportContent,
          });
          const response = await this.applyPostExecutionRulesOnly(
            step,
            state,
            rejectedResponse,
            updatePersonaSession,
            resumedPublication.reviewerRuntime ?? executionRuntime,
          );
          state.stepOutputs.set(step.name, response);
          state.lastOutput = response;
          // 拒否された報告本文が後続 step の {previous_response} へ届くよう、
          // 受理経路・新規実行の拒否経路と同じく snapshot も更新する。
          this.persistPreviousResponseSnapshot(
            state,
            step.name,
            stepIteration,
            response.content,
          );
          return {
            response,
            instruction: phase1Instruction,
            providerInfo: resumedPublication.reviewerProviderInfo ?? providerInfo,
          };
        }
        const resumedEscalation = await this.runEscalationReviewerForNormalStep({
          parentStepName: step.name,
          // dynamic facets 適用後の実行用ステップを owner として渡す。設定上の
          // step を渡すと、その回の owner が実際に使った facet 集合と代打の
          // 判断基準がずれる（名前は同一なので publication identity は不変）。
          ownerReviewerStep: executableStep,
          findingContractContext,
          findingContractFreezeKey: preparedExecution?.findingContractFreezeKey,
          stepIteration,
          state,
          task,
          maxSteps,
          updatePersonaSession,
          runtime: executionRuntime,
        });
        if (resumedEscalation !== undefined && 'terminalResponse' in resumedEscalation) {
          return this.escalationTerminalStepResult({
            step,
            state,
            stepIteration,
            instruction: phase1Instruction,
            fallbackProviderInfo: resumedPublication.reviewerProviderInfo ?? providerInfo,
            escalation: resumedEscalation,
          });
        }
        const resumedIngest = await this.ingestFindingContractForNormalStep({
          step: findingContractIntakeStep,
          stepIteration,
          iteration: state.iteration,
          publication: resumedPublication.publication,
          priorStepResponseText,
          ...(resumedPublication.relationClarification !== undefined
            ? { relationClarification: resumedPublication.relationClarification }
            : {}),
          ...(resumedEscalation === undefined ? {} : { escalationResults: resumedEscalation.reviewerResults }),
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
        // 保存済み publication からの再開でも判定は今ここで確定する。この分岐を
        // 飛ばすと、resume 経路だけ非承認判定が台帳に何も残さず消える。
        await this.recordVerdictClaimsMismatch({
          step,
          response,
          publication: resumedPublication.publication,
          roundMarker: resumedIngest.roundMarker,
        });
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
    let reviewerPublication: CanonicalFindingReviewPublication | undefined;
    let reviewerRoundMarker: string | undefined;
    if (findingContractIntakeStep && findingContractContext) {
      const phase1ProviderUsage = response.providerUsage;
      const prepared = await this.prepareFindingReviewPublication({
        step: findingContractIntakeStep,
        executableStep,
        // Phase 1 で凍結した context をそのまま Phase 2 へ渡す。
        findingContractContext,
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
        presentationContext: findingContractContext?.reviewer?.presentationContext,
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
      if ('reportRejection' in prepared) {
        // 報告側原因（rawExcerpt が報告本文へ束縛できない）。ラン全体を落とさず、
        // そのレビュアーの protocol anomaly として記録して言い直し経路へ載せる。
        await this.recordReviewReportProtocolRejections({
          parentStepName: step.name,
          stepIteration,
          publicationIds: [],
          rejections: [{
            reviewerStepName: findingContractIntakeStep.name,
            reviewerPersonaKey: findingContractIntakeStep.persona ?? findingContractIntakeStep.name,
            reportContent: prepared.reportRejection.reportContent,
            reason: prepared.reportRejection.reason,
          }],
        });
        // ルールが読む本文は resume 経路と同じく「拒否されたその報告」にそろえる。
        response = reviewReportProtocolRejectionResponse({
          stepName: step.name,
          reportContent: prepared.reportRejection.reportContent,
        });
      } else {
        reviewerPublication = prepared.publication;
        response = replaceResponseProviderUsage(
          prepared.response,
          phase1ProviderUsage,
        );
        const escalation = await this.runEscalationReviewerForNormalStep({
          parentStepName: step.name,
          // dynamic facets 適用後の実行用ステップを owner として渡す（上と同じ理由）。
          ownerReviewerStep: executableStep,
          findingContractContext,
          findingContractFreezeKey: preparedExecution?.findingContractFreezeKey,
          stepIteration,
          state,
          task,
          maxSteps,
          updatePersonaSession,
          runtime: executionRuntime,
        });
        if (escalation !== undefined && 'terminalResponse' in escalation) {
          return this.escalationTerminalStepResult({
            step,
            state,
            stepIteration,
            instruction: phase1Instruction,
            fallbackProviderInfo: completedReviewerProviderInfo,
            escalation,
          });
        }
        reviewerRoundMarker = (await this.ingestFindingContractForNormalStep({
          step: findingContractIntakeStep,
          stepIteration,
          iteration: state.iteration,
          publication: prepared.publication,
          priorStepResponseText,
          relationClarification: prepared.relationClarification,
          ...(escalation === undefined ? {} : { escalationResults: escalation.reviewerResults }),
        })).roundMarker;
      }
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

    if (reviewerPublication !== undefined && reviewerRoundMarker !== undefined) {
      // 判定が確定した直後に、非承認判定 + claim ゼロ件を台帳へ残す。
      // ここを逃すと非承認判定は台帳に何の痕跡も残さずに消える。
      await this.recordVerdictClaimsMismatch({
        step,
        response,
        publication: reviewerPublication,
        roundMarker: reviewerRoundMarker,
      });
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
