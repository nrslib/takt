import { createLogger } from '../../../shared/utils/index.js';
import type { AgentResponse, LoopMonitorConfig, WorkflowMaxSteps, WorkflowState, WorkflowStep } from '../../models/types.js';
import { mergeProviderOptions } from '../../../infra/config/providerOptions.js';
import { providerSupportsClaudeAllowedTools } from '../../../infra/providers/provider-capabilities.js';
import { resolveLoopMonitorJudgeProviderModel } from '../provider-resolution.js';
import type { RuntimeStepResolution, StepProviderInfo } from '../types.js';
import { incrementStepIteration } from './state-manager.js';
import type { OptionsBuilder } from './OptionsBuilder.js';
import type { StepExecutor } from './StepExecutor.js';
import { formatWorkflowRuleCondition } from '../../models/workflow-rule-condition.js';

const log = createLogger('loop-monitor-judge-runner');

interface LoopMonitorJudgeRunnerDeps {
  optionsBuilder: OptionsBuilder;
  stepExecutor: StepExecutor;
  state: WorkflowState;
  task: string;
  getMaxSteps: () => WorkflowMaxSteps;
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
  ) => void;
  onStepComplete: (step: WorkflowStep, response: AgentResponse, instruction: string, resumeStepName: string) => void;
  emitCollectedReports: () => void;
  resetCycleDetector: () => void;
  /**
   * finding contract 有効時のみ。エンジン計算済みの findings 状態
   * （完了ゲートの充足状況・暫定の滞留ラウンド数・解消経路）を judge の
   * instruction 末尾へ注入する（loop-monitor-summary.ts 参照）。store を
   * runner に直接読ませず、Setup が構築した読み取り依存だけを渡す。
   */
  getFindingsSummaryForJudge?: () => string | undefined;
}

export class LoopMonitorJudgeRunner {
  constructor(private readonly deps: LoopMonitorJudgeRunnerDeps) {}

  async run(
    monitor: LoopMonitorConfig,
    cycleCount: number,
    triggeringStep: WorkflowStep,
    triggeringRuntime: RuntimeStepResolution | undefined,
    fallbackNextStep: string,
  ): Promise<string> {
    const resolvedRuntime = this.resolveJudgeRuntime(monitor, cycleCount, triggeringStep, triggeringRuntime);
    const judgeStep = this.createJudgeStep(monitor, cycleCount, resolvedRuntime.providerInfo);
    log.info('Running loop monitor judge', {
      cycle: monitor.cycle,
      cycleCount,
      threshold: monitor.threshold,
    });

    const maxSteps = this.deps.getMaxSteps();
    this.deps.state.iteration++;
    const stepIteration = incrementStepIteration(this.deps.state, judgeStep.name);
    const baseInstruction = this.deps.stepExecutor.buildInstruction(
      judgeStep,
      stepIteration,
      this.deps.state,
      this.deps.task,
      maxSteps,
    );
    const findingsSummary = this.deps.getFindingsSummaryForJudge?.();
    const prebuiltInstruction = findingsSummary !== undefined
      ? `${baseInstruction}\n\n## Findings state (engine-computed)\n${findingsSummary}`
      : baseInstruction;

    const providerInfo = this.deps.optionsBuilder.resolveStepProviderModel(judgeStep, resolvedRuntime);
    this.deps.onStepStart(
      judgeStep,
      this.deps.state.iteration,
      prebuiltInstruction,
      providerInfo,
      triggeringStep.name,
      stepIteration,
    );

    const { response, instruction } = await this.deps.stepExecutor.runNormalStep(
      judgeStep,
      this.deps.state,
      this.deps.task,
      maxSteps,
      this.deps.updatePersonaSession,
      prebuiltInstruction,
      resolvedRuntime,
    );

    this.deps.emitCollectedReports();
    this.deps.onStepComplete(judgeStep, response, instruction, triggeringStep.name);

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
      return fallbackNextStep;
    }
    const nextStep = this.deps.resolveNextStepFromDone(judgeStep, response);
    log.info('Loop monitor judge decision', {
      cycle: monitor.cycle,
      nextStep,
      matchedRuleIndex: response.matchedRuleIndex,
    });
    this.deps.resetCycleDetector();
    return nextStep;
  }

  private createJudgeStep(
    monitor: LoopMonitorConfig,
    cycleCount: number,
    providerInfo: StepProviderInfo | undefined,
  ): WorkflowStep {
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
    const triggeringProviderInfo = this.deps.optionsBuilder.resolveStepProviderModel(
      triggeringStep,
      triggeringRuntime,
    );
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
