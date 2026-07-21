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
import type { PhaseName, PhasePromptParts, JudgeStageEntry, RuntimeStepResolution, StepProviderInfo, StepRunResult } from '../types.js';
import type { ProviderUsageSnapshot } from '../../models/response.js';
import { executeAgent } from '../../../agents/agent-usecases.js';
import { InstructionBuilder } from '../instruction/InstructionBuilder.js';
import { needsStatusJudgmentPhase, runReportPhase, ReportPhaseGenerationError, runStatusJudgmentPhase } from '../phase-runner.js';
import { detectMatchedRule } from '../evaluation/index.js';
import { RuleDetectionExhaustedError } from '../evaluation/RuleDetectionExhaustedError.js';
import { evaluateWhenExpression } from '../evaluation/when-evaluator.js';
import { resolvePhase3Adoption } from '../evaluation/rule-utils.js';
import type { BasePhaseRunnerContext, StatusJudgmentPhaseResult } from '../phase-runner.js';
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
  validateStructuredOutputAgainstSchema,
} from './structured-output-schema-validator.js';
import { providerSupportsStructuredOutput } from '../../../infra/providers/provider-capabilities.js';
import { resolveReportHandles } from '../instruction/report-handles.js';
import { AGENT_FAILURE_CATEGORIES } from '../../../shared/types/agent-failure.js';
import { buildPhaseExecutionId } from '../../../shared/utils/phaseExecutionId.js';
import { buildStructuredJsonSchemaInstruction } from '../../../shared/prompts/index.js';
import type {
  StructuredOutputFailureReason,
  StructuredOutputNormalizerRegistry,
} from './structured-output-normalizer.js';
import { runWithPhaseSpan } from '../observability/workflowSpans.js';
import type { FindingContractInstructionContext } from '../instruction/instruction-context.js';
import { compactSessionBeforePhase1 } from './session-compaction.js';
import type { FindingLedgerStore } from '../findings/store.js';
import type { FindingManagerRunResult } from '../findings/manager-runner.js';
import {
  ingestFindingContractResults,
  resolveFindingContractIntakeStep,
  withFindingContractStructuredOutput,
} from '../findings/contract-intake.js';
import { clarifyAmbiguousRawRelationsOnce, type ReviewerRelationClarification } from '../findings/relation-coherence.js';
import { invalidateExpectedPersonaSession, invalidatePersonaSessionIfExpected } from './session-invalidation.js';
import type { InstructionBuildTransaction } from './instruction-build-transaction.js';

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
  readonly getWorkflowDefinitionSteps: () => ReadonlyArray<WorkflowStep>;
  readonly getWorkflowName: () => string;
  readonly getWorkflowDescription: () => string | undefined;
  readonly getInheritedPeerReportPaths: (step: WorkflowStep) => readonly string[];
  readonly getRetryNote: () => string | undefined;
  readonly getObservabilityRunId?: () => string | undefined;
  readonly observabilityEnabled?: () => boolean;
  readonly sanitizeObservabilityText?: (text: string) => string;
  readonly getCurrentWorkflowStack?: () => WorkflowResumePointEntry[] | undefined;
  readonly detectRuleIndex: (content: string, stepName: string) => number;
  readonly structuredCaller: StructuredCaller;
  readonly structuredOutputNormalizers: StructuredOutputNormalizerRegistry;
  /** 自前 or workflow_call 親から継承した、この engine で有効な Finding Contract。 */
  readonly findingContract?: FindingContractConfig;
  /** findings-manager の provider/model 未指定時の fallback（manager-runner.ts 参照）。 */
  readonly workflowProvider?: WorkflowConfig['provider'];
  readonly workflowModel?: WorkflowConfig['model'];
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
    explicitContext: FindingContractInstructionContext | undefined,
  ): FindingContractInstructionContext | undefined {
    if (explicitContext !== undefined) {
      return explicitContext;
    }
    return this.deps.optionsBuilder.buildFindingContractInstructionContext?.(
      step,
      false,
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
    response: AgentResponse;
    ledgerCopyPath: string;
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
      // 単独ステップでは「レビュアー1件」を自分自身として渡す
      // （manager-runner.ts の subResults は並列・単独どちらも同じ形で扱う）。
      subResults: [{
        subStep: input.step,
        response: input.response,
        ...(input.relationClarification !== undefined ? { relationClarification: input.relationClarification } : {}),
      }],
      // 台帳の workflowName スタンプは店（ledgerStore）が束縛する正準名を使う。
      // workflow_call の子が親の台帳を継承した場合、この engine 自身の
      // getWorkflowName()（子のワークフロー名）を使うと reconcile 後の
      // ledger.workflowName が親の台帳と食い違う（ParallelRunner と同じ理由）。
      workflowName: this.deps.findingLedgerStore.workflowName,
      runId: this.deps.getRunId(),
      callNamespace: this.deps.getFindingCallNamespace(),
      timestamp: new Date().toISOString(),
      ledgerCopyPath: input.ledgerCopyPath,
      priorStepResponseText: input.priorStepResponseText,
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
  ): { response: AgentResponse; invalidDetail?: string } {
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

        const parsed = parseLastJsonBlock(response.content);
        if (typeof parsed !== 'object' || parsed == null || Array.isArray(parsed)) {
          throw new Error('Structured output JSON must be an object');
        }
        structuredOutput = parsed as Record<string, unknown>;
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
      return { response, invalidDetail: detail };
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
    findingContract?: FindingContractInstructionContext,
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
    const workflowDefinitionSteps = this.deps.getWorkflowDefinitionSteps();
    const reportDir = join(this.deps.getCwd(), this.deps.getReportDir());
    // workflow_call の子（subworkflows 名前空間）の {report:X} が親成果物へ
    // read-only フォールバックするための reports ルート。engine の runPaths から
    // 明示的に渡す（リゾルバ側でパス文字列から推測しない）。
    const reportsRootDir = this.deps.getRunPaths().reportsRootAbs;
    const reportHandles = resolveReportHandles({
      step,
      reportDir,
      workflowSteps: workflowDefinitionSteps,
      inheritedPeerReportPaths: this.deps.getInheritedPeerReportPaths(step),
    });
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
      currentReport: reportHandles.currentReport,
      previousReport: reportHandles.previousReport,
      reportHistory: reportHandles.reportHistory,
      peerReports: reportHandles.peerReports,
      language: this.deps.getLanguage(),
      interactive: this.deps.getInteractive(),
      workflowSteps,
      currentStepIndex: workflowSteps.findIndex(s => s.name === step.name),
      workflowName: this.deps.getWorkflowName(),
      workflowDescription: this.deps.getWorkflowDescription(),
      retryNote: this.deps.getRetryNote(),
      policyContents: policySnapshot?.content ?? step.policyContents,
      policySourcePath: policySnapshot?.sourcePath,
      knowledgeContents: knowledgeSnapshot?.content ?? step.knowledgeContents,
      knowledgeSourcePath: knowledgeSnapshot?.sourcePath,
      previousResponseSourcePath: state.previousResponseSourcePath,
      fallbackContext: fallbackContext ?? state.pendingFallback,
      workflowState: state,
      findingContract: this.buildFindingContractInstructionContext(step, findingContract),
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
      onProviderAttempt,
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

    // Phase 3: status judgment (new session, no tools, determines matched rule)
    let phase3Result: StatusJudgmentPhaseResult | undefined;
    try {
      phase3Result = needsStatusJudgmentPhase(step)
        ? await runStatusJudgmentPhase(step, phaseCtx)
        : undefined;
    } catch (error) {
      if (error instanceof StructuredOutputSchemaError) {
        throw error;
      }
      log.info('Phase 3 status judgment failed, falling back to phase1 rule evaluation', {
        step: step.name,
        error: getErrorMessage(error),
      });
    }

    if (phase3Result) {
      // Phase 3 の判定はタグ/構造化出力からルール番号を直接採用するため、
      // ここでガード（findings 条件）を評価する。不成立なら採用せず、
      // ガード対応済みの通常ルール評価へフォールバックする。
      // 採用判定は共通ヘルパに委譲（先行決定的評価 + ガード/決定的再評価）。
      const adoption = resolvePhase3Adoption(step.rules, phase3Result, state, this.deps.getInteractive(), evaluateWhenExpression);
      phase3Result = adoption.result;
      if (adoption.blocked) {
        log.debug('Phase 3 rule guard failed; falling back to rule evaluation', {
          step: step.name,
          ruleIndex: phase3Result.ruleIndex,
          ruleCondition: step.rules?.[phase3Result.ruleIndex]?.condition,
        });
      } else {
        log.debug('Rule matched (Phase 3)', {
          step: step.name,
          ruleIndex: phase3Result.ruleIndex,
          method: phase3Result.method,
        });
        nextResponse = {
          ...nextResponse,
          matchedRuleIndex: phase3Result.ruleIndex,
          matchedRuleMethod: phase3Result.method,
        };
        return nextResponse;
      }
    }

    // No Phase 3 — use rule evaluator with Phase 1 content
    const stepProviderModel = this.deps.optionsBuilder.resolveStepProviderModel(step, runtime);
    const match = await detectMatchedRule(step, nextResponse.content, '', {
      state,
      cwd: this.deps.getCwd(),
      provider: stepProviderModel.provider,
      resolvedProvider: stepProviderModel.provider,
      resolvedModel: stepProviderModel.model,
      childProcessEnv: phaseCtx.childProcessEnv,
      interactive: this.deps.getInteractive(),
      detectRuleIndex: this.deps.detectRuleIndex,
      structuredCaller: this.deps.structuredCaller,
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
  ): Promise<StepRunResult> {
    await waitForStepDelay(step);
    const stepIteration = prebuiltInstruction
      ? state.stepIterations.get(step.name) ?? 1
      : incrementStepIteration(state, step.name);

    // Finding Contract の単独ステップ取り込み。対象なら raw findings の構造化
    // 出力を強制し、Phase 1 の結果をルール評価の前に台帳へ反映する
    // （ParallelRunner の findingLedgerCopyPath 準備と同じタイミング）。
    const findingContractIntakeStep = this.resolveFindingContractIntakeStep(step);
    const findingContractContext = findingContractIntakeStep
      ? this.deps.optionsBuilder.buildFindingContractInstructionContext(findingContractIntakeStep, true)
      : undefined;
    const executableStep = findingContractIntakeStep && findingContractContext
      ? withFindingContractStructuredOutput(findingContractIntakeStep, findingContractContext.ledgerCopyPath)
      : step;
    // 直前ステップ（通常は coder の fix）の応答。異議申告の裁定材料として
    // manager に渡すため、Phase 1 実行で lastOutput が上書きされる前に捕捉する
    // （ParallelRunner の priorStepResponseText 捕捉と同じタイミング）。
    const priorStepResponseText = state.lastOutput?.content;

    const instruction = prebuiltInstruction ?? this.buildInstruction(
      executableStep,
      stepIteration,
      state,
      task,
      maxSteps,
      undefined,
      findingContractContext,
    );
    const phase1Instruction = this.buildPhase1Instruction(instruction, executableStep, runtime);
    const providerInfo = this.deps.optionsBuilder.resolveStepProviderModel(executableStep, runtime);
    const sessionKey = buildSessionKey(executableStep, providerInfo.provider);
    log.debug('Running step', {
      step: step.name,
      persona: step.persona ?? '(none)',
      stepIteration,
      iteration: state.iteration,
      sessionId: state.personaSessions.get(sessionKey) ?? 'new',
    });

    // Phase 1: main execution (Write excluded if step has report)
    let didEmitPhaseStart = false;
    let resolvedPromptParts: PhasePromptParts | undefined;
    const phaseExecutionId = buildPhaseExecutionId({
      step: step.name,
      iteration: state.iteration,
      phase: 1,
      sequence: 1,
    });
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
    const agentOptions = {
      ...baseAgentOptions,
      ...(compactionOutcome === 'fresh' ? { sessionId: undefined } : {}),
      onPromptResolved: (promptParts: PhasePromptParts) => {
        resolvedPromptParts = promptParts;
        this.deps.onPhaseStart?.(step, 1, 'execute', phase1Instruction, promptParts, phaseExecutionId, state.iteration);
        didEmitPhaseStart = true;
      },
    };
    let response = await runWithPhaseSpan({
      enabled: this.deps.observabilityEnabled?.() === true,
      runId: this.deps.getObservabilityRunId?.(),
      workflowName: this.deps.getWorkflowName(),
      step: executableStep,
      iteration: state.iteration,
      phase: 1,
      phaseName: 'execute',
      instruction: phase1Instruction,
      phaseExecutionId,
      workflowStack: this.deps.getCurrentWorkflowStack?.(),
      sanitizeText: this.deps.sanitizeObservabilityText,
      providerInfo,
      getPromptParts: () => resolvedPromptParts,
    }, () => executeAgent(executableStep.persona, phase1Instruction, agentOptions), (result) => ({
      status: result.status,
      content: result.content,
      error: result.error,
      providerUsage: result.providerUsage,
    }));
    response = this.normalizeStructuredOutput(executableStep, response, runtime);
    if (!didEmitPhaseStart) {
      throw new Error(`Missing prompt parts for phase start: ${step.name}:1`);
    }
    if (response.sessionId !== undefined) {
      updatePersonaSession(sessionKey, response.sessionId);
    }
    this.deps.onPhaseComplete?.(step, 1, 'execute', response.content, response.status, response.error, phaseExecutionId, state.iteration);

    // Empty output with done status is treated as an error to prevent
    // downstream phases from running with no content.
    if (
      response.status === 'done'
      && response.structuredOutput === undefined
      && response.content.trim().length === 0
    ) {
      log.info('Phase 1 returned empty output, treating as error', { step: step.name });
      response = { ...response, status: 'error', error: 'Phase 1 returned empty output' };
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
    if (findingContractIntakeStep && findingContractContext && this.deps.findingLedgerStore && response.status === 'done') {
      const clarified = await clarifyAmbiguousRawRelationsOnce({
        stepName: step.name,
        persona: executableStep.persona,
        response,
        ledger: this.deps.findingLedgerStore.loadLedger(),
        agentOptions,
        normalize: (candidate: AgentResponse) => this.normalizeStructuredOutputWithDiagnostics(executableStep, candidate, runtime),
      });
      response = clarified.response;
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
        response,
        ledgerCopyPath: findingContractContext.ledgerCopyPath,
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
    this.emitStepReports(step);
    return { response, instruction: phase1Instruction, providerInfo };
  }

  /** Collect step:report events for each report file that exists */
  emitStepReports(step: WorkflowStep): void {
    if (!step.outputContracts || step.outputContracts.length === 0) return;
    const baseDir = join(this.deps.getCwd(), this.deps.getReportDir());

    for (const entry of step.outputContracts) {
      const fileName = entry.name;
      this.checkReportFile(step, baseDir, fileName);
    }
  }

  // Collects report file paths that exist (used by WorkflowEngine to emit events)
  private reportFiles: Array<{ step: WorkflowStep; filePath: string; fileName: string }> = [];

  /** Check if report file exists and collect for emission */
  private checkReportFile(step: WorkflowStep, baseDir: string, fileName: string): void {
    const filePath = join(baseDir, fileName);
    if (existsSync(filePath)) {
      this.reportFiles.push({ step, filePath, fileName });
    }
  }

  /** Drain collected report files (called by engine after step execution) */
  drainReportFiles(): Array<{ step: WorkflowStep; filePath: string; fileName: string }> {
    const files = this.reportFiles;
    this.reportFiles = [];
    return files;
  }

}
