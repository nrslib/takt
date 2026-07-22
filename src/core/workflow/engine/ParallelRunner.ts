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
import { executeAgent } from '../../../agents/agent-usecases.js';
import { isWorkflowCallStep } from '../step-kind.js';
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
import { runWithPhaseSpan } from '../observability/workflowSpans.js';
import { resolveAutoRoutingBatch } from '../auto-routing/resolver.js';
import type { QualityGateRunResult } from '../quality-gates/types.js';
import { buildPhaseExecutionId } from '../../../shared/utils/phaseExecutionId.js';
import { sanitizeSensitiveText } from '../../../shared/utils/sensitiveText.js';
import type { FindingContractConfig } from '../../models/types.js';
import type { FindingLedgerStore } from '../findings/store.js';
import type { FindingManagerRunResult } from '../findings/manager-runner.js';
import {
  ingestFindingContractResults,
  withFindingContractStructuredOutput,
} from '../findings/contract-intake.js';
import { clarifyAmbiguousRawRelationsOnce, type ReviewerRelationClarification } from '../findings/relation-coherence.js';
import type { WorkflowCallRunner } from './WorkflowCallRunner.js';
import type { WorkflowCallIsolatedStateSync, WorkflowCallSessionUpdates } from './WorkflowCallExecutor.js';
import { compactSessionBeforePhase1 } from './session-compaction.js';
import { invalidateExpectedPersonaSession, invalidatePersonaSessionIfExpected } from './session-invalidation.js';
import { recordAgentUsageEvent } from './agent-usage-event.js';
import { formatWorkflowRuleCondition } from '../../models/workflow-rule-condition.js';
import { evaluatePostExecutionRules } from './post-execution-rule-evaluator.js';

const log = createLogger('parallel-runner');

type ParallelSubStepResult = {
  subStep: WorkflowStep;
  response: AgentResponse;
  /** レビュア1回突き返しの実施記録（engine 発行の taint 根拠。manager-runner が canonicalization へ渡す）。 */
  relationClarification?: ReviewerRelationClarification;
  instruction: string;
  providerInfo?: StepRunResult['providerInfo'];
  durationMs?: number;
  qualityGateFailure?: boolean;
  workflowCallSessionUpdates?: WorkflowCallSessionUpdates;
  workflowCallStateSync?: WorkflowCallIsolatedStateSync;
  workflowCallExecutionRejected?: boolean;
};

type ParallelTerminalStatus = 'error' | 'blocked' | 'rate_limited';

function isAgentParallelSubStep(step: WorkflowStep): step is AgentWorkflowStep {
  return !isWorkflowCallStep(step) && step.kind !== 'system';
}

function mergeTerminalCorrectionResponse(
  originalResponse: AgentResponse,
  correctionResponse: AgentResponse,
): AgentResponse {
  const baseResponse = { ...originalResponse };
  delete baseResponse.error;
  delete baseResponse.errorKind;
  delete baseResponse.rateLimitInfo;
  return {
    ...baseResponse,
    status: correctionResponse.status,
    timestamp: correctionResponse.timestamp,
    ...(correctionResponse.error !== undefined ? { error: correctionResponse.error } : {}),
    ...(correctionResponse.errorKind !== undefined ? { errorKind: correctionResponse.errorKind } : {}),
    ...(correctionResponse.rateLimitInfo !== undefined ? { rateLimitInfo: correctionResponse.rateLimitInfo } : {}),
    ...(correctionResponse.sessionId !== undefined ? { sessionId: correctionResponse.sessionId } : {}),
    ...(correctionResponse.providerUsage !== undefined ? { providerUsage: correctionResponse.providerUsage } : {}),
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
  readonly getReportDir: () => string;
  readonly getWorkflowName: () => string;
  readonly getInteractive: () => boolean;
  readonly observabilityEnabled: boolean;
  readonly observabilityRunId?: string;
  readonly sanitizeObservabilityText?: (text: string) => string;
  readonly getCurrentWorkflowStack?: () => WorkflowResumePointEntry[] | undefined;
  readonly refreshFindingsState: () => void;
  readonly emitEvent: (event: string, ...args: unknown[]) => void;
  readonly findingContract?: FindingContractConfig;
  /** findings-manager の provider/model 未指定時の fallback（manager-runner.ts 参照）。 */
  readonly workflowProvider?: WorkflowConfig['provider'];
  readonly workflowModel?: WorkflowConfig['model'];
  readonly findingLedgerStore?: FindingLedgerStore;
  readonly getWorkflowCallRunner?: () => WorkflowCallRunner;
  readonly updateMaxSteps: (maxSteps: WorkflowMaxSteps) => void;
  readonly setActiveResumePoint: (step: WorkflowStep, iteration: number) => void;
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
  ): Promise<StepRunResult> {
    if (!step.parallel) {
      throw new Error(`Step "${step.name}" has no parallel sub-steps`);
    }
    const subSteps = step.parallel;
    // 直前ステップ（通常は coder の fix）の応答。異議申告の裁定材料として
    // manager に渡すため、サブステップ実行で lastOutput が変わる前に捕捉する。
    const priorStepResponseText = state.lastOutput?.content;
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
      interactive: this.deps.getInteractive(),
    };

    // Create semaphore for concurrency control (if configured)
    const semaphore = step.concurrency != null
      ? new Semaphore(step.concurrency)
      : undefined;
    if (semaphore) {
      log.debug('Concurrency limit enabled', { step: step.name, concurrency: step.concurrency });
    }
    // WorkflowEngineSetup.buildFindingContractInstructionContext と同じヘルパを
    // ラウンドの先頭で1回だけ呼ぶ（sub-step ごとに再計算しない）。ledgerCopyPath /
    // reviewScopeSnapshotId は「このラウンドの reviewer 全員が同じ値を見る」ことが
    // 前提の値であり（後者は manager 検証時の再計算と一致する必要がある —
    // WorkflowEngineSetup.ts・snapshot.ts 参照）、ここで inline に再実装すると
    // reviewScopeSnapshotId の付与漏れのような配線バグを繰り返す。
    // findingContract 未設定のワークフローが大半のため、クロージャ呼び出し自体を
    // 避ける早期リターンは維持する（OptionsBuilder 側でも undefined を返すが、
    // 呼び出しコストを避けたい）。
    const findingContractContext = this.deps.findingContract
      ? this.deps.optionsBuilder.buildFindingContractInstructionContext(step, true)
      : undefined;
    const findingLedgerCopyPath = findingContractContext?.ledgerCopyPath;
    const agentSubSteps = subSteps.filter(isAgentParallelSubStep);
    const routedProviderInfoByStep = this.deps.engineOptions.autoRouting
      ? await resolveAutoRoutingBatch({
          autoRouting: this.deps.engineOptions.autoRouting,
          items: agentSubSteps.map((subStep) => ({
            id: subStep.name,
            step: {
              name: subStep.name,
              tags: subStep.tags,
              personaKey: subStep.providerRoutingPersonaKey,
              instruction: subStep.instruction,
            },
            currentProviderInfo: this.deps.optionsBuilder.resolveStepProviderModelBeforeAutoRouting(subStep, runtime),
          })),
          routeBatchWithAi: this.deps.engineOptions.autoRoutingAiRouter?.routeBatch,
          logger: log,
          abortSignal: this.deps.engineOptions.abortSignal,
        })
      : new Map();

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
            subStepInstructionByName.set(subStep.name, '');
            return await this.runWorkflowCallSubStep(subStep, state, runtime, startedAt);
          }
          if (!isAgentParallelSubStep(subStep)) {
            throw new Error(`Unsupported parallel sub-step kind for "${subStep.name}"`);
          }

          const executableSubStep = withFindingContractStructuredOutput(subStep, findingLedgerCopyPath);
          const subRuntime = routedProviderInfoByStep.has(subStep.name)
            ? {
                ...runtime,
                providerInfo: routedProviderInfoByStep.get(subStep.name)!,
              }
            : runtime;
          const subIteration = incrementStepIteration(state, subStep.name);
          const subInstruction = this.deps.stepExecutor.buildInstruction(
            executableSubStep,
            subIteration,
            state,
            task,
            maxSteps,
            subRuntime?.fallback,
            findingContractContext,
          );
          const phase1Instruction = findingLedgerCopyPath
            ? this.deps.stepExecutor.buildPhase1Instruction(subInstruction, executableSubStep, subRuntime)
            : subInstruction;
          subStepInstructionByName.set(subStep.name, phase1Instruction);
          const parentIteration = state.iteration;
          const subPm = subRuntime
            ? this.deps.optionsBuilder.resolveStepProviderModel(executableSubStep, subRuntime)
            : this.deps.optionsBuilder.resolveStepProviderModel(executableSubStep);
          const subRuleCtx = {
            state,
            interactive: this.deps.getInteractive(),
          };

        // Session key uses the same resolved provider as Phase 1 options and resume phases.
        const subSessionKey = buildSessionKey(executableSubStep, subPm.provider);

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
        let didEmitPhaseStart = false;
        let resolvedPromptParts: PhasePromptParts | undefined;
        const phaseExecutionId = buildPhaseExecutionId({
          step: subStep.name,
          iteration: parentIteration,
          phase: 1,
          sequence: 1,
        });
        let phase1CompletionExecutionId = phaseExecutionId;

        // Override onStream with parallel logger's prefixed handler (immutable)
        const agentOptions = parallelLogger
          ? {
              ...baseOptions,
              ...(compactionOutcome === 'fresh' ? { sessionId: undefined } : {}),
              onStream: parallelLogger.createStreamHandler(subStep.name, index),
            }
          : {
              ...baseOptions,
              ...(compactionOutcome === 'fresh' ? { sessionId: undefined } : {}),
            };
        agentOptions.onPromptResolved = (promptParts: PhasePromptParts) => {
          resolvedPromptParts = promptParts;
          this.deps.onPhaseStart?.(subStep, 1, 'execute', phase1Instruction, promptParts, phaseExecutionId, parentIteration);
          didEmitPhaseStart = true;
        };
        let subRelationClarification: ReviewerRelationClarification | undefined;
        let subResponse = await runWithPhaseSpan({
          enabled: this.deps.observabilityEnabled,
          runId: this.deps.observabilityRunId,
          workflowName: this.deps.getWorkflowName(),
          step: executableSubStep,
          iteration: parentIteration,
          phase: 1,
          phaseName: 'execute',
          instruction: phase1Instruction,
          phaseExecutionId,
          workflowStack: this.deps.getCurrentWorkflowStack?.(),
          sanitizeText: this.deps.sanitizeObservabilityText,
          providerInfo: subPm,
          getPromptParts: () => resolvedPromptParts,
        }, () => this.executeSubStepAgent(executableSubStep, subPm, phase1Instruction, agentOptions), (result) => ({
          status: result.status,
          content: result.content,
          error: result.error,
          providerUsage: result.providerUsage,
        }));
        if (
          compactionOutcome !== 'fresh'
          && subResponse.status === 'error'
          && subResponse.errorKind !== 'rate_limit'
        ) {
          // 並列レビューの1席のプロバイダ障害で走行全体を落とさない。
          // 空転はセッション文脈起因のことが多いため（長文脈での生成品質
          // 崩壊を実測）、再試行は resume を切った新しいセッションで行う。
          // rate limit は再試行で叩かず既存の rate_limited 経路に委ねる。
          log.warn('Parallel sub-step provider error; retrying once with a fresh session', {
            step: subStep.name,
            error: subResponse.error,
          });
          const retryPhaseExecutionId = buildPhaseExecutionId({
            step: subStep.name,
            iteration: parentIteration,
            phase: 1,
            sequence: 2,
          });
          // 再試行は専用IDで phase:start を発火する（初回IDの二重発火はしない）。
          // onPromptResolved を再試行自身のものに差し替えることで、初回試行が
          // プロンプト解決前に死んだ場合でも、再試行の成功が phase:start を
          // 発火させ、後段の Missing prompt parts 検査を正しく満たす。
          const retryOptions = {
            ...agentOptions,
            sessionId: undefined,
            onPromptResolved: (promptParts: PhasePromptParts) => {
              resolvedPromptParts = promptParts;
              this.deps.onPhaseStart?.(subStep, 1, 'execute', phase1Instruction, promptParts, retryPhaseExecutionId, parentIteration);
              phase1CompletionExecutionId = retryPhaseExecutionId;
              didEmitPhaseStart = true;
            },
          };
          subResponse = await runWithPhaseSpan({
            enabled: this.deps.observabilityEnabled,
            runId: this.deps.observabilityRunId,
            workflowName: this.deps.getWorkflowName(),
            step: executableSubStep,
            iteration: parentIteration,
            phase: 1,
            phaseName: 'execute',
            instruction: phase1Instruction,
            phaseExecutionId: retryPhaseExecutionId,
            workflowStack: this.deps.getCurrentWorkflowStack?.(),
            sanitizeText: this.deps.sanitizeObservabilityText,
            providerInfo: subPm,
          }, () => this.executeSubStepAgent(executableSubStep, subPm, phase1Instruction, retryOptions), (result) => ({
            status: result.status,
            content: result.content,
            error: result.error,
            providerUsage: result.providerUsage,
          }));
          if (subResponse.sessionId === undefined) {
            // 再試行がセッションIDを返さなかった場合、劣化していた旧セッションを
            // resume 対象に残さない（残すと次の実行で文脈崩壊が再発する）
            invalidateExpectedPersonaSession(
              state,
              subSessionKey,
              subResponse,
              baseOptions.sessionId,
              updatePersonaSession,
            );
          }
        }
        if (findingLedgerCopyPath) {
          const normalized = this.deps.stepExecutor.normalizeStructuredOutputWithDiagnostics(
            executableSubStep,
            subResponse,
            subRuntime,
          );
          subResponse = normalized.response;
          if (normalized.invalidDetail !== undefined) {
            // 弱いモデルは大きな構造化出力で JSON を壊しやすい。1回だけ
            // 同一セッションで是正を求め、直れば元の応答（レポート本文）に
            // 構造化出力だけをマージして続行する。
            log.info('Structured output invalid for parallel sub-step, requesting one correction', {
              step: subStep.name,
              detail: normalized.invalidDetail,
            });
            const correctionInstruction = [
              'Your structured output failed schema validation:',
              normalized.invalidDetail,
              '',
              'Re-emit ONLY the corrected structured output matching the schema.',
              'Do not repeat the report text. Do not add commentary.',
            ].join('\n');
            // 是正は JSON 再出力のみ: ツール・編集権限は不要なので絞り、
            // Phase 1 のイベントコールバックも引き継がない。
            const correctiveResponse = await this.executeSubStepAgent(executableSubStep, subPm, correctionInstruction, {
              ...agentOptions,
              permissionMode: 'readonly',
              allowedTools: [],
              onPromptResolved: undefined,
              onStream: undefined,
              ...(subResponse.sessionId !== undefined ? { sessionId: subResponse.sessionId } : {}),
            });
            // 非ネイティブ構造化出力プロバイダでは是正 JSON が content に入る
            // ため、是正応答をそのまま正規化する（本文の差し替えはマージ時）。
            const renormalized = this.deps.stepExecutor.normalizeStructuredOutputWithDiagnostics(
              executableSubStep,
              correctiveResponse,
              subRuntime,
            );
            if (correctiveResponse.status === 'rate_limited' || correctiveResponse.status === 'blocked') {
              // レート制限・ブロックは専用フロー（メタデータ伝播・バックオフ）
              // が上位にあるため、error に潰さず、Phase 1 本文を保持して伝える。
              subResponse = mergeTerminalCorrectionResponse(subResponse, correctiveResponse);
            } else if (renormalized.invalidDetail !== undefined || renormalized.response.status !== 'done') {
              subResponse = {
                ...subResponse,
                status: 'error',
                error: `Step "${subStep.name}" structured output remained invalid after one correction: ${renormalized.invalidDetail ?? renormalized.response.error ?? 'correction failed'}`,
              };
            } else {
              subResponse = {
                ...subResponse,
                structuredOutput: renormalized.response.structuredOutput,
                ...(correctiveResponse.sessionId !== undefined ? { sessionId: correctiveResponse.sessionId } : {}),
              };
            }
          }
          // レビュア1回突き返し: relation/target/kind の意味
          // 矛盾がある raw について同一セッションで1回だけ明確化を求める。
          // 直らなかった raw は drop せず ambiguous のまま manager 解釈 /
          // provisional へ進む。clarification は engine 発行の taint 根拠として
          // manager-runner の canonicalization に渡す。
          if (subResponse.status === 'done' && this.deps.findingLedgerStore) {
            const clarified = await clarifyAmbiguousRawRelationsOnce({
              stepName: subStep.name,
              persona: executableSubStep.persona,
              response: subResponse,
              ledger: this.deps.findingLedgerStore.loadLedger(),
              agentOptions,
              normalize: (candidate: AgentResponse) => this.deps.stepExecutor.normalizeStructuredOutputWithDiagnostics(
                executableSubStep,
                candidate,
                subRuntime,
              ),
            });
            subResponse = clarified.response;
            subRelationClarification = clarified.clarification;
          }
        }
        if (!didEmitPhaseStart) {
          throw new Error(`Missing prompt parts for phase start: ${subStep.name}:1`);
        }
        if (subResponse.sessionId !== undefined) {
          updatePersonaSession(subSessionKey, subResponse.sessionId);
        }
        this.deps.onPhaseComplete?.(subStep, 1, 'execute', subResponse.content, subResponse.status, subResponse.error, phase1CompletionExecutionId, parentIteration);
        if (
          subResponse.status === 'done'
          && subResponse.structuredOutput === undefined
          && subResponse.content.trim().length === 0
        ) {
          log.info('Phase 1 returned empty output for parallel sub-step, treating as error', { step: subStep.name });
          subResponse = { ...subResponse, status: 'error', error: 'Phase 1 returned empty output' };
        }
        if (subResponse.status === 'error' || subResponse.status === 'blocked' || subResponse.status === 'rate_limited') {
          state.stepOutputs.set(subStep.name, subResponse);
          return {
            subStep,
            response: subResponse,
            ...(subRelationClarification !== undefined ? { relationClarification: subRelationClarification } : {}),
            instruction: phase1Instruction,
            providerInfo: subPm,
            durationMs: Math.max(0, subResponse.timestamp.getTime() - startedAt),
          };
        }

        // Phase 2/3 context resolves the same runtime-aware session key as Phase 1.
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

        // Phase 2: report output for sub-step
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
                durationMs: Math.max(0, blockedResponse.timestamp.getTime() - startedAt),
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
                durationMs: Math.max(0, rateLimitedResponse.timestamp.getTime() - startedAt),
              };
            }
          } catch (reportError) {
            if (reportError instanceof ReportPhaseGenerationError) {
              log.info('Report phase failed for parallel sub-step, continuing to status judgment', {
                step: subStep.name,
                error: getErrorMessage(reportError),
              });
            } else {
              throw reportError;
            }
          }
        }

        let finalResponse: AgentResponse;
        {
          let match;
          try {
            match = await evaluatePostExecutionRules(subStep, () => phaseCtx, subRuleCtx);
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
            ? { ...subResponse, matchedRuleIndex: match.index, matchedRuleMethod: match.method }
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
        this.deps.stepExecutor.emitStepReports(subStep);

        return {
          subStep,
          response: finalResponse,
          ...(subRelationClarification !== undefined ? { relationClarification: subRelationClarification } : {}),
          instruction: phase1Instruction,
          providerInfo: subPm,
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

    // v2 梯子設計: 取り込みは常に 'updated' で完了する（manager の壊れた応答・
    // 予算超過は provisional として台帳へ着地し、run-level の失敗経路は無い）。
    await this.runFindingContractManager(step, stepIteration, subResults, findingLedgerCopyPath, priorStepResponseText);

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

  private async runWorkflowCallSubStep(
    subStep: WorkflowStep,
    state: WorkflowState,
    runtime: RuntimeStepResolution | undefined,
    startedAt: number,
  ): Promise<ParallelSubStepResult> {
    if (!isWorkflowCallStep(subStep)) {
      throw new Error(`Parallel sub-step "${subStep.name}" is not a workflow_call`);
    }

    incrementStepIteration(state, subStep.name);
    const workflowCallRunner = this.deps.getWorkflowCallRunner?.();
    if (!workflowCallRunner) {
      throw new Error(`Parallel workflow_call sub-step "${subStep.name}" requires workflowCallRunner`);
    }
    const subRuntime = runtime?.fallback
      ? runtime
      : workflowCallRunner.resolveRuntime(subStep);
    const result = await workflowCallRunner.runIsolated(subStep, subRuntime);
    return {
      subStep,
      response: result.result.response,
      instruction: result.result.instruction,
      providerInfo: result.result.providerInfo,
      durationMs: Math.max(0, result.result.response.timestamp.getTime() - startedAt),
      workflowCallSessionUpdates: result.sessionUpdates,
      workflowCallStateSync: result.stateSync,
    };
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
      this.deps.setActiveResumePoint(step, state.iteration);
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
    subResults: ParallelSubStepResult[],
    ledgerCopyPath: string | undefined,
    priorStepResponseText: string | undefined,
  ): Promise<FindingManagerRunResult | undefined> {
    if (!this.deps.findingContract) {
      return undefined;
    }
    const ledgerStore = this.deps.findingLedgerStore;
    if (!ledgerStore) {
      throw new Error('Finding contract is configured but finding ledger store is not available');
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
      subResults,
      // 台帳の workflowName スタンプは店（ledgerStore）が束縛する正準名を使う。
      // workflow_call の子が親の台帳を継承した場合、この engine 自身の
      // getWorkflowName()（子のワークフロー名）を使うと reconcile 後の
      // ledger.workflowName が親の台帳と食い違い、次回 load/save で
      // assertLedgerWorkflowName が例外を投げる。
      workflowName: ledgerStore.workflowName,
      runId: this.deps.getRunId(),
      callNamespace: this.deps.getFindingCallNamespace(),
      timestamp: new Date().toISOString(),
      ledgerCopyPath,
      priorStepResponseText,
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

    return {
      response,
      instruction: options.subResults.map((result) => result.instruction).join('\n\n'),
      providerInfo: options.providerInfo,
      consumedStepIterations: [
        options.step.name,
        ...options.subResults.map((result) => result.subStep.name),
      ],
    };
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
