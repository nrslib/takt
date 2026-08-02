import { createLogger } from '../../../shared/utils/index.js';
import type {
  AgentResponse,
  AgentWorkflowStep,
  LoopMonitorConfig,
  WorkflowPendingLoopJudge,
  WorkflowPendingLoopJudgeStarted,
  WorkflowState,
  WorkflowStep,
} from '../../models/types.js';
import { mergeProviderOptions } from '../../../infra/config/providerOptions.js';
import { providerSupportsClaudeAllowedTools } from '../../../infra/providers/provider-capabilities.js';
import { resolveLoopMonitorJudgeProviderModel } from '../provider-resolution.js';
import type { RuntimeStepResolution, StepProviderInfo, WorkflowEngineOptions } from '../types.js';
import type { OptionsBuilder } from './OptionsBuilder.js';
import type { StepExecutor } from './StepExecutor.js';
import { formatWorkflowRuleCondition } from '../../models/workflow-rule-condition.js';
import { isWorkflowCallStep } from '../step-kind.js';
import type { WorkflowStepBudget } from '../workflow-step-budget.js';
import type { WorkflowExecutionScope } from '../workflow-execution-scope.js';
import { InstructionBuildTransaction } from './instruction-build-transaction.js';
import { commitCountableStepStart } from './execution-checkpoint.js';

const log = createLogger('loop-monitor-judge-runner');

interface LoopMonitorJudgeRunnerDeps {
  optionsBuilder: OptionsBuilder;
  stepExecutor: StepExecutor;
  state: WorkflowState;
  task: string;
  stepBudget: WorkflowStepBudget;
  recordCountableProgress: () => void;
  interruptRequested: () => boolean;
  ignoreIterationLimit: boolean;
  requestIterationLimitExtension?: WorkflowEngineOptions['onIterationLimit'];
  setPendingLoopJudge: (
    triggeringStep: WorkflowStep,
    pending: WorkflowPendingLoopJudge,
    iteration: number,
  ) => void;
  startPendingLoopJudge: (
    judgeStep: WorkflowStep,
    pending: WorkflowPendingLoopJudgeStarted,
    iteration: number,
  ) => void;
  clearPendingLoopJudge: (triggeringStep: WorkflowStep, iteration: number) => void;
  syncMaxSteps: (maxSteps: import('../../models/types.js').WorkflowMaxSteps) => void;
  getExecutionScope: () => WorkflowExecutionScope;
  getLimitExecutionScope: (step: WorkflowStep, iteration: number) => WorkflowExecutionScope;
  emitIterationLimit: (
    iteration: number,
    maxSteps: number,
    currentStep: string,
    scope: WorkflowExecutionScope,
  ) => void;
  language?: string;
  updatePersonaSession: (persona: string, sessionId: string | undefined) => void;
  resolveNextStepFromDone: (step: WorkflowStep, response: AgentResponse) => string;
  onStepStart: (
    step: WorkflowStep,
    iteration: number,
    instruction: string,
    providerInfo: StepProviderInfo | undefined,
    resumeStepName: string,
    stepIteration: number,
    maxSteps: import('../../models/types.js').WorkflowMaxSteps,
    scope: WorkflowExecutionScope,
  ) => void;
  onStepComplete: (
    step: WorkflowStep,
    response: AgentResponse,
    instruction: string,
    resumeStepName: string,
    scope: WorkflowExecutionScope,
  ) => void;
  emitCollectedReports: (iteration: number, scope: WorkflowExecutionScope) => void;
  resetCycleDetector: () => void;
  /**
   * finding contract 有効時のみ。エンジン計算済みの findings 状態
   * （完了ゲートの充足状況・暫定の滞留ラウンド数・解消経路）を judge の
   * instruction 末尾へ注入する（loop-monitor-summary.ts 参照）。store を
   * runner に直接読ませず、Setup が構築した読み取り依存だけを渡す。
   */
  getFindingsSummaryForJudge?: () => string | undefined;
}

export type LoopMonitorJudgeRunResult =
  | { readonly nextStep: string; readonly response: AgentResponse }
  | { readonly iterationLimitReached: true };

export class LoopMonitorJudgeRunner {
  constructor(private readonly deps: LoopMonitorJudgeRunnerDeps) {}

  async run(
    monitor: LoopMonitorConfig,
    cycleCount: number,
    triggeringStep: WorkflowStep,
    triggeringRuntime: RuntimeStepResolution | undefined,
    fallbackNextStep: string,
    resumedStart?: WorkflowPendingLoopJudgeStarted,
  ): Promise<LoopMonitorJudgeRunResult> {
    this.throwIfInterrupted();
    const draftJudgeStep = this.createJudgeStep(monitor, cycleCount, undefined);
    const maxSteps = resumedStart === undefined
      ? await this.reserveJudgeBudget(draftJudgeStep, triggeringStep, monitor, cycleCount, fallbackNextStep)
      : this.deps.stepBudget.currentMaxSteps();
    if (maxSteps === undefined) return { iterationLimitReached: true };

    const resolvedRuntime = this.resolveJudgeRuntime(monitor, cycleCount, triggeringStep, triggeringRuntime);
    const judgeStep = this.createJudgeStep(monitor, cycleCount, resolvedRuntime.providerInfo);
    const providerInfo = this.deps.optionsBuilder.resolveStepProviderModel(judgeStep, resolvedRuntime);
    if (providerInfo.provider === undefined) {
      throw new Error(`Loop monitor judge "${judgeStep.name}" has no resolved provider`);
    }
    this.throwIfInterrupted();
    const executionRuntime = { ...resolvedRuntime, providerInfo };
    log.info('Running loop monitor judge', {
      cycle: monitor.cycle,
      cycleCount,
      threshold: monitor.threshold,
    });

    const pendingIteration = resumedStart?.iteration ?? this.deps.state.iteration + 1;
    const pendingStepIteration = resumedStart?.step_iteration
      ?? (this.deps.state.stepIterations.get(judgeStep.name) ?? 0) + 1;
    const transaction = new InstructionBuildTransaction();
    const previousResponseSourcePath = this.deps.state.previousResponseSourcePath;
    const pendingFallback = this.deps.state.pendingFallback;
    const rollbackPreparation = () => {
      transaction.rollback();
      this.deps.state.previousResponseSourcePath = previousResponseSourcePath;
      this.deps.state.pendingFallback = pendingFallback;
    };
    let prebuiltInstruction: string;
    try {
      const baseInstruction = this.deps.stepExecutor.buildInstruction(
        judgeStep,
        pendingStepIteration,
        this.deps.state,
        this.deps.task,
        maxSteps,
        {
          iteration: pendingIteration,
          transaction,
        },
      );
      const findingsSummary = this.deps.getFindingsSummaryForJudge?.();
      prebuiltInstruction = findingsSummary !== undefined
        ? `${baseInstruction}\n\n## Findings state (engine-computed)\n${findingsSummary}`
        : baseInstruction;
    } catch (error) {
      rollbackPreparation();
      throw error;
    }
    if (this.deps.interruptRequested()) {
      rollbackPreparation();
      this.throwIfInterrupted();
    }
    let stepIteration: number;
    if (resumedStart === undefined) {
      const startedPending: WorkflowPendingLoopJudgeStarted = {
        status: 'started',
        triggering_step: triggeringStep.name,
        cycle: [...monitor.cycle],
        cycle_count: cycleCount,
        fallback_next_step: fallbackNextStep,
        judge_step: judgeStep.name,
        iteration: pendingIteration,
        step_iteration: pendingStepIteration,
      };
      stepIteration = commitCountableStepStart({
        state: this.deps.state,
        stepName: judgeStep.name,
        iteration: pendingIteration,
        expectedStepIteration: pendingStepIteration,
        recordProgress: this.deps.recordCountableProgress,
        persist: () => this.deps.startPendingLoopJudge(judgeStep, startedPending, pendingIteration),
      });
    } else {
      if (resumedStart.judge_step !== judgeStep.name
        || this.deps.state.iteration !== resumedStart.iteration
        || this.deps.state.stepIterations.get(judgeStep.name) !== resumedStart.step_iteration) {
        rollbackPreparation();
        throw new Error(`Started loop monitor judge "${judgeStep.name}" has inconsistent resume state`);
      }
      stepIteration = resumedStart.step_iteration;
    }
    const scope = this.deps.getExecutionScope();
    this.deps.onStepStart(
      judgeStep,
      this.deps.state.iteration,
      prebuiltInstruction,
      providerInfo,
      triggeringStep.name,
      stepIteration,
      maxSteps,
      scope,
    );

    const phase1Instruction = this.deps.stepExecutor.buildPhase1Instruction(
      prebuiltInstruction,
      judgeStep,
      executionRuntime,
    );
    const { response, instruction } = await this.deps.stepExecutor.runNormalStep(
      judgeStep,
      this.deps.state,
      this.deps.updatePersonaSession,
      executionRuntime,
      {
        executableStep: judgeStep,
        phase1Instruction,
        ...(this.deps.state.lastOutput?.content !== undefined
          ? { priorStepResponseText: this.deps.state.lastOutput.content }
          : {}),
        stepIteration,
        rollbackPreparation,
      },
      { iteration: this.deps.state.iteration, scope },
    );

    this.deps.emitCollectedReports(this.deps.state.iteration, scope);
    this.deps.onStepComplete(judgeStep, response, instruction, triggeringStep.name, scope);
    this.deps.clearPendingLoopJudge(triggeringStep, this.deps.state.iteration);

    if (response.status !== 'done') {
      // 監視は衛生装置であり、判定役自身の障害（プロバイダエラー等）で
      // 走行本体を落とさない。介入しなかった場合の自然な遷移で続行する。
      // リセットしないと次のサイクル末尾ステップ完了のたびに壊れた判定役を
      // 呼び直すため、成功時と同様に検出状態をリセットする。
      log.warn('Loop monitor judge did not produce a decision; continuing with the natural transition', {
        cycle: monitor.cycle,
        status: response.status,
        error: response.error,
        fallbackNextStep,
      });
      this.deps.resetCycleDetector();
      return { nextStep: fallbackNextStep, response };
    }
    const nextStep = this.deps.resolveNextStepFromDone(judgeStep, response);
    log.info('Loop monitor judge decision', {
      cycle: monitor.cycle,
      nextStep,
      matchedRuleIndex: response.matchedRuleIndex,
    });
    this.deps.resetCycleDetector();
    return { nextStep, response };
  }

  private throwIfInterrupted(): void {
    if (this.deps.interruptRequested()) {
      throw new Error('Loop monitor judge interrupted before start');
    }
  }

  private async reserveJudgeBudget(
    judgeStep: WorkflowStep,
    triggeringStep: WorkflowStep,
    monitor: LoopMonitorConfig,
    cycleCount: number,
    fallbackNextStep: string,
  ): Promise<import('../../models/types.js').WorkflowMaxSteps | undefined> {
    const limitScope = this.deps.getLimitExecutionScope(judgeStep, this.deps.state.iteration);
    const budgetCheck = await this.deps.stepBudget.check({
      request: {
        currentIteration: this.deps.state.iteration,
        currentStep: judgeStep.name,
        scope: limitScope,
      },
      ignoreLimit: this.deps.ignoreIterationLimit,
      onLimitReached: (maxSteps) => {
        this.deps.setPendingLoopJudge(triggeringStep, {
          status: 'budget_wait',
          triggering_step: triggeringStep.name,
          cycle: [...monitor.cycle],
          cycle_count: cycleCount,
          fallback_next_step: fallbackNextStep,
        }, this.deps.state.iteration);
        this.deps.emitIterationLimit(
          this.deps.state.iteration,
          maxSteps,
          judgeStep.name,
          limitScope,
        );
      },
      onMaxStepsExtended: this.deps.syncMaxSteps,
      requestExtension: this.deps.requestIterationLimitExtension,
    });
    this.throwIfInterrupted();
    return budgetCheck.allowed ? budgetCheck.maxSteps : undefined;
  }

  private createJudgeStep(
    monitor: LoopMonitorConfig,
    cycleCount: number,
    providerInfo: StepProviderInfo | undefined,
  ): AgentWorkflowStep {
    const instruction = (monitor.judge.instruction ?? this.buildDefaultInstruction(monitor, cycleCount))
      .replace(/\{cycle_count\}/g, String(cycleCount));
    const defaultProviderOptions = this.buildDefaultProviderOptions(providerInfo?.provider);

    return {
      name: `_loop_judge_${monitor.cycle.join('_')}`,
      sessionKey: monitor.judge.sessionKey,
      persona: monitor.judge.persona,
      personaPath: monitor.judge.personaPath,
      personaDisplayName: 'loop-judge',
      // provider_routing.personas.loop-judge を効かせるためのキー。personaDisplayName は
      // セッションキー等にも使う表示名で、ルーティング専用のキーとは役割が違うため分けている。
      providerRoutingPersonaKey: 'loop-judge',
      provider: monitor.judge.provider,
      model: monitor.judge.model,
      modelSpecified: monitor.judge.modelSpecified,
      edit: false,
      providerOptions: mergeProviderOptions(
        defaultProviderOptions,
        monitor.judge.providerOptions,
      ),
      instruction,
      rules: monitor.judge.rules,
      passPreviousResponse: true,
    };
  }

  /**
   * 判定役（judge）の provider/model を決める。
   *
   * 優先順位は (1) judge.provider / judge.model の直接指定、(2) judge ステップの通常解決で
   * 得られる provider_routing.* や persona_providers.loop-judge、(3) どちらも無い場合だけ
   * トリガー元（ループを踏んだステップ）の解決済み provider/model（rate-limit フォールバック
   * 後の値を含む）。
   *
   * (3) を既定の挙動にしてしまうと「実装した本人が自分のループの健全性を判定する」ことになり
   * 監視が機能しない（実測: coder の qwen3-coder-next が 4 回とも「健全」と判定し、56 周・
   * 9 時間走り続けた）。そのため runtime を渡さずに judge ステップ単体の通常解決を先に取り、
   * そこに明示指定が無かった場合だけトリガー元へフォールバックする。
   *
   * 通常解決の呼び出しには provider 確定後にしか作れる defaultProviderOptions を含む
   * ステップは使えない（provider を決めるための解決に、決まった後の値が要る循環になる）。
   * そのため providerInfo なしの下書きステップで解決だけ行い、確定した providerInfo で
   * createJudgeStep を呼び直して本物のステップを作る。
   */
  private resolveJudgeRuntime(
    monitor: LoopMonitorConfig,
    cycleCount: number,
    triggeringStep: WorkflowStep,
    triggeringRuntime?: RuntimeStepResolution,
  ): RuntimeStepResolution {
    const draftJudgeStep = this.createJudgeStep(monitor, cycleCount, undefined);
    const judgeProviderInfo = this.deps.optionsBuilder.resolveStepProviderModelBeforeAutoRouting(draftJudgeStep);
    const triggeringProviderInfo = isWorkflowCallStep(triggeringStep)
      ? judgeProviderInfo
      : this.deps.optionsBuilder.resolveStepProviderModel(triggeringStep, triggeringRuntime);
    const providerInfo = resolveLoopMonitorJudgeProviderModel({
      judge: monitor.judge,
      judgeProviderInfo,
      triggeringProviderInfo,
    });
    return { providerInfo };
  }

  private buildDefaultProviderOptions(provider: StepProviderInfo['provider']) {
    if (!providerSupportsClaudeAllowedTools(provider)) {
      return undefined;
    }

    return {
      claude: {
        allowedTools: ['Read', 'Glob', 'Grep'],
      },
    };
  }

  private buildDefaultInstruction(monitor: LoopMonitorConfig, cycleCount: number): string {
    const cycleNames = monitor.cycle.join(' → ');
    const rulesDesc = monitor.judge.rules
      .map((rule) => `- ${formatWorkflowRuleCondition(rule.condition)} → ${rule.next}`)
      .join('\n');

    if (this.deps.language === 'ja') {
      return [
        `ステップのサイクル [${cycleNames}] が ${cycleCount} 回繰り返されました。`,
        '',
        'このループが健全（進捗がある）か、非生産的（同じ問題を繰り返している）かを判断してください。',
        '',
        '**判断の選択肢:**',
        rulesDesc,
        '',
        '**判断基準:**',
        '- 各サイクルで新しい問題が発見・修正されているか',
        '- 同じ指摘が繰り返されていないか',
        '- 全体的な進捗があるか',
      ].join('\n');
    }

    return [
      `The step cycle [${cycleNames}] has repeated ${cycleCount} times.`,
      '',
      'Determine whether this loop is healthy (making progress) or unproductive (repeating the same issues).',
      '',
      '**Decision options:**',
      rulesDesc,
      '',
      '**Judgment criteria:**',
      '- Are new issues being found/fixed in each cycle?',
      '- Are the same findings being repeated?',
      '- Is there overall progress?',
    ].join('\n');
  }
}
