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
import { executeAgent } from '../../../agents/agent-usecases.js';
import { ParallelLogger } from './parallel-logger.js';
import { needsStatusJudgmentPhase, runReportPhase, ReportPhaseGenerationError, runStatusJudgmentPhase } from '../phase-runner.js';
import { detectMatchedRule } from '../evaluation/index.js';
import { evaluateWhenExpression } from '../evaluation/when-evaluator.js';
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
import { runWithPhaseSpan } from '../observability/workflowSpans.js';
import type { QualityGateRunResult } from '../quality-gates/types.js';
import { buildPhaseExecutionId } from '../../../shared/utils/phaseExecutionId.js';
import { sanitizeSensitiveText } from '../../../shared/utils/sensitiveText.js';
import type { FindingContractConfig } from '../../models/types.js';
import type { FindingLedgerStore } from '../findings/store.js';
import {
  RawFindingsStructuredOutput,
  type FindingManagerRunResult,
  runFindingManagerForParallelStep,
} from '../findings/manager-runner.js';
import { renderFindingLedgerInstructionSummary, renderFindingLedgerReportSummary } from '../findings/context.js';
import { isNonAiReturnValueRule } from '../evaluation/rule-utils.js';

const log = createLogger('parallel-runner');

type ParallelSubStepResult = {
  subStep: AgentWorkflowStep;
  response: AgentResponse;
  instruction: string;
  providerInfo?: StepRunResult['providerInfo'];
  qualityGateFailure?: boolean;
};

type ParallelTerminalStatus = 'error' | 'blocked' | 'rate_limited';

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
  readonly detectRuleIndex: (content: string, stepName: string) => number;
  readonly structuredCaller: StructuredCaller;
  readonly refreshFindingsState: () => void;
  readonly emitEvent: (event: string, ...args: unknown[]) => void;
  readonly findingContract?: FindingContractConfig;
  readonly findingLedgerStore?: FindingLedgerStore;
  readonly getRunId: () => string;
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
      childProcessEnv: this.deps.engineOptions.childProcessEnv,
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
    const findingLedgerCopyPath = this.prepareFindingContractLedgerCopy();

    // Run all sub-steps concurrently (failures are captured, not thrown)
    // When semaphore is set, at most `concurrency` sub-steps execute simultaneously.
    const settled = await Promise.allSettled(
      subSteps.map(async (subStep, index) => {
        if (semaphore) {
          await semaphore.acquire();
        }
        try {
          const executableSubStep = this.withFindingContractStructuredOutput(subStep, findingLedgerCopyPath);
          const subIteration = incrementStepIteration(state, subStep.name);
          const subInstruction = this.deps.stepExecutor.buildInstruction(
            executableSubStep,
            subIteration,
            state,
            task,
            maxSteps,
            runtime?.fallback,
            findingLedgerCopyPath
              ? {
                  ledgerCopyPath: findingLedgerCopyPath,
                  ledgerSummary: this.renderFindingLedgerSummary(),
                  reportLedgerSummary: this.renderFindingLedgerReportSummary(),
                  rawFindingsJsonSchema: RawFindingsStructuredOutput.schema,
                }
              : undefined,
          );
          const phase1Instruction = findingLedgerCopyPath
            ? this.deps.stepExecutor.buildPhase1Instruction(subInstruction, executableSubStep, runtime)
            : subInstruction;
          const parentIteration = state.iteration;
          const subPm = runtime
            ? this.deps.optionsBuilder.resolveStepProviderModel(executableSubStep, runtime)
            : this.deps.optionsBuilder.resolveStepProviderModel(executableSubStep);
          const subRuleCtx = {
            ...parentRuleCtx,
            provider: subPm.provider,
            resolvedProvider: subPm.provider,
            resolvedModel: subPm.model,
            childProcessEnv: this.deps.engineOptions.childProcessEnv,
          };

        // Session key uses the same resolved provider as Phase 1 options and resume phases.
        const subSessionKey = buildSessionKey(executableSubStep, subPm.provider);

        // Phase 1: main execution (Write excluded if sub-step has report)
        const baseOptions = this.deps.optionsBuilder.buildAgentOptions(executableSubStep, runtime);
        let didEmitPhaseStart = false;
        let resolvedPromptParts: PhasePromptParts | undefined;
        const phaseExecutionId = buildPhaseExecutionId({
          step: subStep.name,
          iteration: parentIteration,
          phase: 1,
          sequence: 1,
        });

        // Override onStream with parallel logger's prefixed handler (immutable)
        const agentOptions = parallelLogger
          ? { ...baseOptions, onStream: parallelLogger.createStreamHandler(subStep.name, index) }
          : { ...baseOptions };
        agentOptions.onPromptResolved = (promptParts: PhasePromptParts) => {
          resolvedPromptParts = promptParts;
          this.deps.onPhaseStart?.(subStep, 1, 'execute', phase1Instruction, promptParts, phaseExecutionId, parentIteration);
          didEmitPhaseStart = true;
        };
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
        }, () => executeAgent(executableSubStep.persona, phase1Instruction, agentOptions), (result) => ({
          status: result.status,
          content: result.content,
          error: result.error,
          providerUsage: result.providerUsage,
        }));
        if (findingLedgerCopyPath) {
          const normalized = this.deps.stepExecutor.normalizeStructuredOutputWithDiagnostics(executableSubStep, subResponse, runtime);
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
            const correctiveResponse = await executeAgent(executableSubStep.persona, correctionInstruction, {
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
              runtime,
            );
            if (correctiveResponse.status === 'rate_limited' || correctiveResponse.status === 'blocked') {
              // レート制限・ブロックは専用フロー（メタデータ伝播・バックオフ）
              // が上位にあるため、error に潰さずそのまま伝える。
              subResponse = correctiveResponse;
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
        }
        if (!didEmitPhaseStart) {
          throw new Error(`Missing prompt parts for phase start: ${subStep.name}:1`);
        }
        if (subResponse.sessionId !== undefined) {
          updatePersonaSession(subSessionKey, subResponse.sessionId);
        }
        this.deps.onPhaseComplete?.(subStep, 1, 'execute', subResponse.content, subResponse.status, subResponse.error, phaseExecutionId, parentIteration);
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
          return { subStep, response: subResponse, instruction: phase1Instruction, providerInfo: subPm };
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
          try {
            const reportResult = await runReportPhase(subStep, subIteration, phaseCtx);
            if (reportResult && 'blocked' in reportResult) {
              const blockedResponse: AgentResponse = {
                ...subResponse,
                status: 'blocked',
                content: reportResult.response.content,
              };
              state.stepOutputs.set(subStep.name, blockedResponse);
              return { subStep, response: blockedResponse, instruction: phase1Instruction, providerInfo: subPm };
            }
            if (reportResult && 'rateLimited' in reportResult) {
              const rateLimitedResponse: AgentResponse = {
                ...reportResult.response,
                persona: subStep.name,
              };
              state.stepOutputs.set(subStep.name, rateLimitedResponse);
              return { subStep, response: rateLimitedResponse, instruction: phase1Instruction, providerInfo: subPm };
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

        // Phase 3 はルール番号を直接採用するため、ガード（findings 条件）を
        // ここで評価する。不成立なら採用せず、ガード対応済みの通常ルール
        // 評価へフォールバックする（StepExecutor 側と同じ扱い）。
        const subPhase3Rule = subPhase3 !== undefined ? subStep.rules?.[subPhase3.ruleIndex] : undefined;
        const subPhase3GuardFailed = subPhase3Rule?.guardCondition !== undefined
          && !evaluateWhenExpression(subPhase3Rule.guardCondition, state);
        if (subPhase3GuardFailed && subPhase3 !== undefined) {
          log.debug('Phase 3 rule guard failed for sub-step; falling back to rule evaluation', {
            step: subStep.name,
            ruleIndex: subPhase3.ruleIndex,
            guardCondition: subPhase3Rule?.guardCondition,
          });
        }

        let finalResponse: AgentResponse;
        if (subPhase3 && !subPhase3GuardFailed) {
          finalResponse = { ...subResponse, matchedRuleIndex: subPhase3.ruleIndex, matchedRuleMethod: subPhase3.method };
        } else {
          const match = await detectMatchedRule(subStep, subResponse.content, '', subRuleCtx);
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
            qualityGateFailure: true,
          };
        }

        state.stepOutputs.set(subStep.name, finalResponse);
        this.deps.stepExecutor.emitStepReports(subStep);

        return { subStep, response: finalResponse, instruction: phase1Instruction, providerInfo: subPm };
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
      return { subStep: failedStep, response: errorResponse, instruction: '', providerInfo: undefined };
    });

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

    const findingManagerResult = await this.runFindingContractManager(step, stepIteration, subResults, findingLedgerCopyPath);
    if (findingManagerResult?.status === 'invalid_manager_output') {
      const response = this.createFindingManagerInvalidOutputResult({
        step,
        state,
        stepIteration,
        subResults,
        managerResult: findingManagerResult,
        providerInfo: findingManagerResult.providerInfo,
      });
      return response;
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

  private async runFindingContractManager(
    step: WorkflowStep,
    stepIteration: number,
    subResults: ParallelSubStepResult[],
    ledgerCopyPath: string | undefined,
  ): Promise<FindingManagerRunResult | undefined> {
    if (!this.deps.findingContract) {
      return undefined;
    }
    if (!this.deps.findingLedgerStore) {
      throw new Error('Finding contract is configured but finding ledger store is not available');
    }
    const result = await runFindingManagerForParallelStep({
      contract: this.deps.findingContract,
      ledgerStore: this.deps.findingLedgerStore,
      optionsBuilder: this.deps.optionsBuilder,
      stepExecutor: this.deps.stepExecutor,
      parentStep: step,
      stepIteration,
      subResults,
      workflowName: this.deps.getWorkflowName(),
      runId: this.deps.getRunId(),
      timestamp: new Date().toISOString(),
      ledgerCopyPath,
    });
    if (result.status === 'updated') {
      this.deps.refreshFindingsState();
      this.deps.emitEvent('findings:ledger', result.ledger);
    }
    return result;
  }

  private prepareFindingContractLedgerCopy(): string | undefined {
    if (!this.deps.findingContract) {
      return undefined;
    }
    if (!this.deps.findingLedgerStore) {
      throw new Error('Finding contract is configured but finding ledger store is not available');
    }
    return this.deps.findingLedgerStore.createRunCopy();
  }

  private renderFindingLedgerSummary(): string {
    if (!this.deps.findingLedgerStore) {
      throw new Error('Finding contract is configured but finding ledger store is not available');
    }
    return renderFindingLedgerInstructionSummary(this.deps.findingLedgerStore.loadLedger());
  }

  private renderFindingLedgerReportSummary(): string {
    if (!this.deps.findingLedgerStore) {
      throw new Error('Finding contract is configured but finding ledger store is not available');
    }
    return renderFindingLedgerReportSummary(this.deps.findingLedgerStore.loadLedger());
  }

  private withFindingContractStructuredOutput(
    subStep: AgentWorkflowStep,
    ledgerCopyPath: string | undefined,
  ): AgentWorkflowStep {
    if (!ledgerCopyPath) {
      return subStep;
    }
    if (subStep.structuredOutput) {
      throw new Error(`Step "${subStep.name}" cannot combine finding_contract raw findings with structured_output`);
    }
    return {
      ...subStep,
      structuredOutput: RawFindingsStructuredOutput,
    };
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

  private createFindingManagerInvalidOutputResult(options: {
    step: WorkflowStep;
    state: WorkflowState;
    stepIteration: number;
    subResults: ParallelSubStepResult[];
    managerResult: Extract<FindingManagerRunResult, { status: 'invalid_manager_output' }>;
    providerInfo: StepRunResult['providerInfo'];
  }): StepRunResult {
    const content = [
      `Finding manager output remained semantically invalid after ${options.managerResult.retryCount} retry.`,
      '',
      'Validation errors:',
      ...options.managerResult.errors.map((error) => `- ${error}`),
      '',
      `Validation report: ${options.managerResult.reportPath}`,
      'Ledger was not updated.',
    ].join('\n');

    const matchedRuleIndex = this.selectInvalidManagerOutputRuleIndex(options.step);
    const response: AgentResponse = {
      persona: options.step.name,
      status: 'done',
      content,
      timestamp: new Date(),
      ...(matchedRuleIndex !== undefined ? { matchedRuleIndex, matchedRuleMethod: 'auto_select' } : {}),
    };

    options.state.stepOutputs.set(options.step.name, response);
    options.state.lastOutput = response;
    this.deps.stepExecutor.persistPreviousResponseSnapshot(
      options.state,
      options.step.name,
      options.stepIteration,
      response.content,
    );
    this.deps.stepExecutor.emitStepReports(options.step);

    return {
      response,
      instruction: options.subResults.map((result) => result.instruction).join('\n\n'),
      providerInfo: options.providerInfo,
    };
  }

  private selectInvalidManagerOutputRuleIndex(step: WorkflowStep): number {
    const rules = step.rules;
    if (!rules) {
      throw new Error(`Invalid finding_contract step "${step.name}": missing invalid manager output rule`);
    }

    const needReplanIndex = rules.findIndex((rule) => isNonAiReturnValueRule(rule, 'need_replan'));
    if (needReplanIndex >= 0) {
      return needReplanIndex;
    }

    const needsFixIndex = rules.findIndex((rule) => isNonAiReturnValueRule(rule, 'needs_fix'));
    if (needsFixIndex >= 0) {
      return needsFixIndex;
    }

    const fixIndex = rules.findIndex((rule) => !rule.isAiCondition && rule.next === 'fix');
    if (fixIndex >= 0) {
      return fixIndex;
    }

    throw new Error(`Invalid finding_contract step "${step.name}": missing invalid manager output rule`);
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
