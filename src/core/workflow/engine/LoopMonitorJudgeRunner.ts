import { createLogger } from '../../../shared/utils/index.js';
import type { AgentResponse, LoopMonitorConfig, WorkflowState, WorkflowStep } from '../../models/types.js';
import { mergeProviderOptions } from '../../../infra/config/providerOptions.js';
import { providerSupportsClaudeAllowedTools } from '../../../infra/providers/provider-capabilities.js';
import { resolveLoopMonitorJudgeProviderModel } from '../provider-resolution.js';
import type { RuntimeStepResolution, StepProviderInfo } from '../types.js';
import { incrementStepIteration } from './state-manager.js';
import type { OptionsBuilder } from './OptionsBuilder.js';
import type { StepExecutor } from './StepExecutor.js';

const log = createLogger('loop-monitor-judge-runner');

interface LoopMonitorJudgeRunnerDeps {
  optionsBuilder: OptionsBuilder;
  stepExecutor: StepExecutor;
  state: WorkflowState;
  task: string;
  maxSteps: number;
  language?: string;
  updatePersonaSession: (persona: string, sessionId: string | undefined) => void;
  resolveNextStepFromDone: (step: WorkflowStep, response: AgentResponse) => string;
  onStepStart: (step: WorkflowStep, iteration: number, instruction: string) => void;
  onStepComplete: (step: WorkflowStep, response: AgentResponse, instruction: string) => void;
  emitCollectedReports: () => void;
  resetCycleDetector: () => void;
}

export class LoopMonitorJudgeRunner {
  constructor(private readonly deps: LoopMonitorJudgeRunnerDeps) {}

  async run(
    monitor: LoopMonitorConfig,
    cycleCount: number,
    triggeringStep: WorkflowStep,
    triggeringRuntime?: RuntimeStepResolution,
  ): Promise<string> {
    const runtime = this.resolveJudgeRuntime(monitor, triggeringStep, triggeringRuntime);
    const judgeStep = this.createJudgeStep(monitor, cycleCount, runtime.providerInfo);
    log.info('Running loop monitor judge', {
      cycle: monitor.cycle,
      cycleCount,
      threshold: monitor.threshold,
    });

    this.deps.state.iteration++;
    const stepIteration = incrementStepIteration(this.deps.state, judgeStep.name);
    const prebuiltInstruction = this.deps.stepExecutor.buildInstruction(
      judgeStep,
      stepIteration,
      this.deps.state,
      this.deps.task,
      this.deps.maxSteps,
    );

    this.deps.onStepStart(judgeStep, this.deps.state.iteration, prebuiltInstruction);

    const { response, instruction } = await this.deps.stepExecutor.runNormalStep(
      judgeStep,
      this.deps.state,
      this.deps.task,
      this.deps.maxSteps,
      this.deps.updatePersonaSession,
      prebuiltInstruction,
      runtime,
    );

    this.deps.emitCollectedReports();
    this.deps.onStepComplete(judgeStep, response, instruction);

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
      persona: monitor.judge.persona,
      personaPath: monitor.judge.personaPath,
      personaDisplayName: 'loop-judge',
      provider: monitor.judge.provider,
      model: monitor.judge.model,
      edit: false,
      providerOptions: mergeProviderOptions(
        defaultProviderOptions,
        monitor.judge.providerOptions,
      ),
      instruction,
      rules: monitor.judge.rules.map((rule) => ({
        condition: rule.condition,
        next: rule.next,
      })),
      passPreviousResponse: true,
    };
  }

  private resolveJudgeRuntime(
    monitor: LoopMonitorConfig,
    triggeringStep: WorkflowStep,
    triggeringRuntime?: RuntimeStepResolution,
  ): RuntimeStepResolution {
    const triggeringProviderInfo = this.deps.optionsBuilder.resolveStepProviderModel(
      triggeringStep,
      triggeringRuntime,
    );
    const providerInfo = resolveLoopMonitorJudgeProviderModel({
      judge: monitor.judge,
      triggeringStep,
      provider: triggeringProviderInfo.provider,
      model: triggeringProviderInfo.model,
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
    const rulesDesc = monitor.judge.rules.map((rule) => `- ${rule.condition} → ${rule.next}`).join('\n');

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
