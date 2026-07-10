import type { AgentWorkflowStep, LoopMonitorRule, WorkflowConfig, WorkflowRule, WorkflowStep } from '../../models/types.js';
import {
  SESSION_AGENT_STEP_REQUIRED_MESSAGE,
  SESSION_NORMAL_AGENT_STEP_REQUIRED_MESSAGE,
} from '../../models/workflow-session-constraints.js';
import { ABORT_STEP, COMPLETE_STEP, ERROR_MESSAGES } from '../constants.js';
import type { WorkflowEngineOptions } from '../types.js';
import { resolveLoopMonitorJudgeProviderModel, resolveStepProviderModel } from '../provider-resolution.js';
import { validateProviderModelRequirements } from '../provider-model-requirements.js';
import { getWorkflowStepKind, isWorkflowCallStep } from '../step-kind.js';
import { hasUnquotedFindingsReference, isFindingsCondition, isInvalidManagerOutputRule } from '../evaluation/rule-utils.js';
import { workflowUsesAutoProvider } from '../auto-routing/workflow-auto-provider.js';

function isFindingsRule(rule: WorkflowRule | LoopMonitorRule): boolean {
  if ('isAiCondition' in rule && rule.isAiCondition === true) {
    return false;
  }
  return isFindingsCondition(rule.condition)
    || ('aggregateGuardCondition' in rule
      && rule.aggregateGuardCondition !== undefined
      && hasUnquotedFindingsReference(rule.aggregateGuardCondition))
    || ('guardCondition' in rule
      && rule.guardCondition !== undefined
      && hasUnquotedFindingsReference(rule.guardCondition));
}

function validateFindingsRuleContract(
  findingContractConfigured: boolean,
  rule: WorkflowRule | LoopMonitorRule,
  source: string,
): void {
  if (!findingContractConfigured && isFindingsRule(rule)) {
    throw new Error(`${source}: findings.* conditions require finding_contract`);
  }
}

function validateFindingContractParallelStructuredOutput(config: WorkflowConfig, findingContractEnabled: boolean): void {
  if (!findingContractEnabled) {
    return;
  }
  for (const step of config.steps) {
    for (const subStep of step.parallel ?? []) {
      if (subStep.structuredOutput) {
        throw new Error(
          `Invalid parallel sub-step "${subStep.name}" in step "${step.name}": cannot combine finding_contract raw findings with structured_output`,
        );
      }
    }
  }
}

/**
 * output_contracts.report[].format が "*-finding-contract" 命名規約の facet を
 * 参照しているのに、そのワークフローで Finding Contract が有効でない
 * （自前の finding_contract も、workflow_call 親からの継承もない）場合を
 * 実行前に落とす。この形式のレビュー指摘は raw findings として台帳に
 * 取り込まれる前提で書かれており、台帳が無いと取り込み経路自体が存在せず、
 * 指摘が黙って捨てられて fix に届かない（final-gate が単独ステップのまま
 * この形式で出力していたケースで reviewers ↔ fix が56周・9時間回った実測がある）。
 */
function collectFindingContractFormatViolations(
  config: WorkflowConfig,
): Array<{ stepName: string; format: string }> {
  const violations: Array<{ stepName: string; format: string }> = [];
  const collectFromStep = (step: WorkflowStep, label: string): void => {
    for (const contract of step.outputContracts ?? []) {
      if (contract.formatRef?.endsWith('-finding-contract') === true) {
        violations.push({ stepName: label, format: contract.formatRef });
      }
    }
    for (const subStep of step.parallel ?? []) {
      collectFromStep(subStep, `${label}.${subStep.name}`);
    }
  };
  for (const step of config.steps) {
    collectFromStep(step, step.name);
  }
  return violations;
}

function validateFindingContractOutputFormatRequiresContract(
  config: WorkflowConfig,
  findingContractEnabled: boolean,
): void {
  if (findingContractEnabled) {
    return;
  }
  const violations = collectFindingContractFormatViolations(config);
  if (violations.length === 0) {
    return;
  }
  const detail = violations.map((v) => `step "${v.stepName}" uses format "${v.format}"`).join(', ');
  throw new Error(
    `Configuration error: workflow "${config.name}" has no finding_contract (own or inherited via workflow_call), `
    + `but ${detail} which requires a Finding Contract ledger to ingest its raw findings`,
  );
}

/**
 * 子ワークフローが自前の finding_contract を持ちながら、workflow_call の親からも
 * 継承している場合を設定エラーで落とす。ledger_path / raw_findings_path は
 * ワークフロー名に紐づくため、暗黙に両方を許すと子は自分の台帳へ、親の
 * when(findings.open.count == 0) 等は親の台帳へ、と別々の台帳を見てしまう。
 */
function validateFindingContractInheritanceConflict(
  config: WorkflowConfig,
  options: WorkflowEngineOptions,
): void {
  if (config.findingContract !== undefined && options.inheritedFindingContract !== undefined) {
    throw new Error(
      `Configuration error: workflow "${config.name}" declares its own finding_contract while also being called `
      + 'as a workflow_call subworkflow that inherits a finding_contract from its parent; a workflow cannot combine '
      + 'both because ledger_path/raw_findings_path are keyed by workflow name and the parent\'s when(findings.*) '
      + 'rules would end up observing a different ledger than the child writes to',
    );
  }
}

function validateAgentStepProviderModel(
  step: WorkflowConfig['steps'][number],
  options: WorkflowEngineOptions,
  source: string,
): void {
  if (getWorkflowStepKind(step) !== 'agent') {
    return;
  }
  const agentStep = step as AgentWorkflowStep;
  const providerInfo = resolveStepProviderModel({
    step: agentStep,
    provider: options.provider,
    providerSource: options.providerSource,
    model: options.model,
    modelSource: options.modelSource,
    providerRouting: options.providerRouting,
    personaProviders: options.personaProviders,
  });
  validateProviderModelRequirements(
    providerInfo.provider,
    providerInfo.model,
    {
      modelFieldName: `${source}.model`,
    },
  );
  validatePromotionProviderModels(agentStep, providerInfo, source);
}

function validateSessionEntrypoint(step: WorkflowStep, source: string): void {
  const candidate = step as {
    session?: unknown;
    parallel?: unknown[];
    arpeggio?: unknown;
    teamLeader?: unknown;
  };

  if (candidate.session === undefined) {
    return;
  }

  if (getWorkflowStepKind(step) !== 'agent') {
    throw new Error(`${source}: ${SESSION_AGENT_STEP_REQUIRED_MESSAGE}`);
  }

  if (candidate.parallel !== undefined || candidate.arpeggio !== undefined || candidate.teamLeader !== undefined) {
    throw new Error(`${source}: ${SESSION_NORMAL_AGENT_STEP_REQUIRED_MESSAGE}`);
  }
}

function validatePromotionProviderModels(
  step: AgentWorkflowStep,
  baseProviderInfo: ReturnType<typeof resolveStepProviderModel>,
  source: string,
): void {
  for (const [index, promotion] of (step.promotion ?? []).entries()) {
    const provider = promotion.provider ?? baseProviderInfo.provider;
    const model = promotion.model !== undefined
      ? promotion.model
      : promotion.providerSpecified
        ? undefined
        : baseProviderInfo.model;
    validateProviderModelRequirements(
      provider,
      model,
      {
        modelFieldName: `${source}.promotion[${index}].model`,
      },
    );
  }
}

function hasInvalidManagerOutputRule(rules: readonly WorkflowRule[] | undefined): boolean {
  if (!rules) {
    return false;
  }
  return rules.some(isInvalidManagerOutputRule);
}

function validateFindingContractInvalidManagerOutputRules(config: WorkflowConfig, findingContractEnabled: boolean): void {
  if (!findingContractEnabled) {
    return;
  }
  for (const step of config.steps) {
    if ((step.parallel?.length ?? 0) === 0) {
      continue;
    }
    if (!hasInvalidManagerOutputRule(step.rules)) {
      throw new Error(
        `Invalid finding_contract step "${step.name}": parallel parent must declare an invalid manager output rule via non-AI return need_replan, non-AI return needs_fix, or non-AI next fix`,
      );
    }
  }
}

function validateParallelSubStepNamesUnique(config: WorkflowConfig): void {
  for (const step of config.steps) {
    const names = new Set<string>();
    for (const subStep of step.parallel ?? []) {
      if (names.has(subStep.name)) {
        throw new Error(`Configuration error: parallel step "${step.name}" contains duplicate sub-step name "${subStep.name}"`);
      }
      names.add(subStep.name);
    }
  }
}

function workflowContainsWorkflowCall(config: WorkflowConfig): boolean {
  const stepContainsWorkflowCall = (step: WorkflowConfig['steps'][number]): boolean =>
    isWorkflowCallStep(step) || (step.parallel ?? []).some(stepContainsWorkflowCall);

  return config.steps.some(stepContainsWorkflowCall);
}

export function validateWorkflowConfig(config: WorkflowConfig, options: WorkflowEngineOptions): void {
  const initialStep = config.steps.find((step) => step.name === config.initialStep);
  if (!initialStep) {
    throw new Error(ERROR_MESSAGES.UNKNOWN_STEP(config.initialStep));
  }
  const workflowProvider = options.provider ?? config.provider;
  if (
    workflowUsesAutoProvider({
      workflowConfig: config,
      effectiveProvider: workflowProvider,
      cliProvider: options.provider,
      projectCwd: options.projectCwd,
      lookupCwd: options.projectCwd,
      workflowCallResolver: options.workflowCallResolver,
    })
    && options.autoRouting === undefined
  ) {
    throw new Error('Configuration error: provider: auto requires auto_routing configuration');
  }
  // 子ワークフローが自前の finding_contract を持たず、workflow_call の親から
  // 継承しているだけのケースも「Finding Contract 有効」として扱う。継承した
  // 契約は ParallelRunner の raw findings 自動付与・manager 起動をそのまま
  // 動かすため（WorkflowEngineSetup 経由で effective contract を渡す）、
  // ここでの検証もランタイムと同じ判定基準を使わないと validate 時は素通り
  // したのに実行時に落ちる、という食い違いが生まれる。
  const findingContractEnabled = config.findingContract !== undefined || options.inheritedFindingContract !== undefined;
  validateFindingContractParallelStructuredOutput(config, findingContractEnabled);
  validateFindingContractInvalidManagerOutputRules(config, findingContractEnabled);
  validateParallelSubStepNamesUnique(config);
  validateFindingContractInheritanceConflict(config, options);
  validateFindingContractOutputFormatRequiresContract(config, findingContractEnabled);

  if (options.startStep) {
    const startStep = config.steps.find((step) => step.name === options.startStep);
    if (!startStep) {
      throw new Error(ERROR_MESSAGES.UNKNOWN_STEP(options.startStep));
    }
  }

  if (workflowContainsWorkflowCall(config) && !options.workflowCallResolver) {
    throw new Error('Configuration error: workflowCallResolver is required when workflow contains workflow_call steps');
  }

  const stepNames = new Set(config.steps.map((step) => step.name));
  stepNames.add(COMPLETE_STEP);
  stepNames.add(ABORT_STEP);

  for (const step of config.steps) {
    validateSessionEntrypoint(step, `Configuration error: step "${step.name}"`);
    validateAgentStepProviderModel(step, options, `Configuration error: step "${step.name}"`);
    for (const rule of step.rules ?? []) {
      if (rule.next && !stepNames.has(rule.next)) {
        throw new Error(`Invalid rule in step "${step.name}": target step "${rule.next}" does not exist`);
      }
      validateFindingsRuleContract(
        findingContractEnabled,
        rule,
        `Invalid rule in step "${step.name}"`,
      );
    }
    for (const subStep of step.parallel ?? []) {
      validateSessionEntrypoint(
        subStep,
        `Configuration error: parallel sub-step "${subStep.name}" of step "${step.name}"`,
      );
      validateAgentStepProviderModel(
        subStep,
        options,
        `Configuration error: parallel sub-step "${subStep.name}" of step "${step.name}"`,
      );
      for (const rule of subStep.rules ?? []) {
        validateFindingsRuleContract(
          findingContractEnabled,
          rule,
          `Invalid rule in parallel sub-step "${subStep.name}" of step "${step.name}"`,
        );
      }
    }
  }

  for (const monitor of config.loopMonitors ?? []) {
    for (const cycleName of monitor.cycle) {
      if (!stepNames.has(cycleName)) {
        throw new Error(`Invalid loop_monitor: cycle references unknown step "${cycleName}"`);
      }
    }
    for (const rule of monitor.judge.rules) {
      if (!stepNames.has(rule.next)) {
        throw new Error(`Invalid loop_monitor judge rule: target step "${rule.next}" does not exist`);
      }
      validateFindingsRuleContract(
        findingContractEnabled,
        rule,
        'Invalid loop_monitor judge rule',
      );
    }

    const triggeringStep = config.steps.find((step) => step.name === monitor.cycle[monitor.cycle.length - 1]);
    if (!triggeringStep) {
      continue;
    }
    const triggeringProviderInfo = resolveStepProviderModel({
      step: triggeringStep,
      provider: options.provider,
      model: options.model,
      providerRouting: options.providerRouting,
      personaProviders: options.personaProviders,
    });
    // 実行時（LoopMonitorJudgeRunner）と同じ優先順位で検証するため、judge ステップ自身の
    // 通常解決（provider_routing.* / persona_providers.loop-judge を含む）も同じ
    // resolveStepProviderModel で取ってから合成する。routing キーは実行時に生成される
    // judge ステップ（_loop_judge_<cycle> / providerRoutingPersonaKey: 'loop-judge'）と揃える。
    const judgeStepProviderInfo = resolveStepProviderModel({
      step: {
        name: `_loop_judge_${monitor.cycle.join('_')}`,
        provider: monitor.judge.provider,
        model: monitor.judge.model,
        modelSpecified: monitor.judge.modelSpecified,
        personaDisplayName: 'loop-judge',
        providerRoutingPersonaKey: 'loop-judge',
      },
      provider: options.provider,
      model: options.model,
      providerRouting: options.providerRouting,
      personaProviders: options.personaProviders,
    });
    const judgeProviderInfo = resolveLoopMonitorJudgeProviderModel({
      judge: monitor.judge,
      judgeProviderInfo: judgeStepProviderInfo,
      triggeringProviderInfo,
    });
    validateProviderModelRequirements(
      judgeProviderInfo.provider,
      judgeProviderInfo.model,
      {
        modelFieldName: 'Configuration error: loop_monitors.judge.model',
      },
    );
  }
}
