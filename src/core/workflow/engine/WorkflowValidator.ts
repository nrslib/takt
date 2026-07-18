import type { AutoRoutingConfig } from '../../models/config-types.js';
import type { AgentWorkflowStep, LoopMonitorRule, WorkflowConfig, WorkflowRule, WorkflowStep } from '../../models/types.js';
import {
  SESSION_AGENT_STEP_REQUIRED_MESSAGE,
  SESSION_NORMAL_AGENT_STEP_REQUIRED_MESSAGE,
} from '../../models/workflow-session-constraints.js';
import { ABORT_STEP, COMPLETE_STEP, ERROR_MESSAGES } from '../constants.js';
import type { WorkflowEngineOptions } from '../types.js';
import {
  applyProviderModelOverride,
  resolveLoopMonitorJudgeProviderModel,
  resolveStepProviderModel,
} from '../provider-resolution.js';
import { validateProviderModelRequirements } from '../provider-model-requirements.js';
import { getWorkflowStepKind, isWorkflowCallStep } from '../step-kind.js';
import { hasUnquotedFindingsReference, isFindingsCondition, isInvalidManagerOutputRule } from '../evaluation/rule-utils.js';
import { buildFindingManagerStep } from '../findings/manager-step.js';
import { resolveEffectiveAutoRouting } from '../auto-routing/effective-auto-routing.js';
import {
  matchAutoRoutingRules,
  resolveAutoRoutingCandidateProviderInfo,
  validateAutoRoutingResolvedProviderModel,
} from '../auto-routing/resolver.js';

type ResolvedProviderInfo = ReturnType<typeof resolveStepProviderModel>;

interface ValidationProviderInfo {
  providerInfo: ResolvedProviderInfo;
  autoRouted: boolean;
}

function expandAutoRoutingProviderInfos(
  step: WorkflowStep,
  currentProviderInfo: ResolvedProviderInfo,
  autoRouting: AutoRoutingConfig | undefined,
): ValidationProviderInfo[] {
  if (
    autoRouting === undefined
    || currentProviderInfo.provider !== undefined
    || getWorkflowStepKind(step) !== 'agent'
  ) {
    return [{ providerInfo: currentProviderInfo, autoRouted: false }];
  }

  const ruleCandidate = matchAutoRoutingRules(autoRouting, {
    name: step.name,
    tags: step.tags,
    personaKey: step.providerRoutingPersonaKey,
    instruction: step.instruction,
  });
  const candidates = ruleCandidate === undefined ? autoRouting.candidates : [ruleCandidate];
  const source = ruleCandidate === undefined ? 'auto.ai' : 'auto.rules';
  return candidates.map((candidate) => ({
    providerInfo: resolveAutoRoutingCandidateProviderInfo(
      candidate,
      source,
      autoRouting,
      currentProviderInfo,
    ),
    autoRouted: true,
  }));
}

function validateResolvedProviderInfo(
  providerInfo: ResolvedProviderInfo,
  modelFieldName: string,
  autoRouted: boolean,
): void {
  validateProviderModelRequirements(providerInfo.provider, providerInfo.model, { modelFieldName });
  if (autoRouted && providerInfo.provider !== undefined) {
    validateAutoRoutingResolvedProviderModel(providerInfo.provider, providerInfo.model);
  }
}

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

function validateFindingContractParallelStructuredOutput(config: WorkflowConfig): void {
  if (!config.findingContract) {
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

function validateFindingContractManagerProviderModel(config: WorkflowConfig, options: WorkflowEngineOptions): void {
  const findingContract = config.findingContract;
  if (!findingContract) {
    return;
  }
  const managerStep = buildFindingManagerStep({
    contract: findingContract,
    workflowProvider: config.provider,
    workflowModel: config.model,
  });
  const autoRouting = resolveEffectiveAutoRouting(config, options.autoRouting);
  const providerInfo = resolveStepProviderModel({
    step: managerStep,
    provider: options.provider,
    providerSource: options.providerSource,
    model: options.model,
    modelSource: options.modelSource,
    autoRouting,
    providerRouting: options.providerRouting,
    personaProviders: options.personaProviders,
  });
  for (const validationInfo of expandAutoRoutingProviderInfos(managerStep, providerInfo, autoRouting)) {
    validateResolvedProviderInfo(
      validationInfo.providerInfo,
      'Configuration error: finding_contract.manager.model',
      validationInfo.autoRouted,
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
    autoRouting: options.autoRouting,
    providerRouting: options.providerRouting,
    personaProviders: options.personaProviders,
  });
  for (const validationInfo of expandAutoRoutingProviderInfos(agentStep, providerInfo, options.autoRouting)) {
    validateResolvedProviderInfo(
      validationInfo.providerInfo,
      `${source}.model`,
      validationInfo.autoRouted,
    );
    validatePromotionProviderModels(
      agentStep,
      validationInfo.providerInfo,
      source,
      validationInfo.autoRouted,
    );
  }
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
  baseProviderInfo: ResolvedProviderInfo,
  source: string,
  autoRouted: boolean,
): void {
  for (const [index, promotion] of (step.promotion ?? []).entries()) {
    const promotedProviderInfo = applyProviderModelOverride(baseProviderInfo, {
      provider: promotion.provider,
      providerSpecified: promotion.providerSpecified === true || promotion.provider !== undefined,
      model: promotion.model,
      modelSpecified: promotion.model !== undefined,
      source: 'promotion',
    });
    validateResolvedProviderInfo(
      promotedProviderInfo,
      `${source}.promotion[${index}].model`,
      autoRouted,
    );
  }
}

function hasInvalidManagerOutputRule(rules: readonly WorkflowRule[] | undefined): boolean {
  if (!rules) {
    return false;
  }
  return rules.some(isInvalidManagerOutputRule);
}

function validateFindingContractInvalidManagerOutputRules(config: WorkflowConfig): void {
  if (!config.findingContract) {
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
  validateFindingContractParallelStructuredOutput(config);
  validateFindingContractManagerProviderModel(config, options);
  validateFindingContractInvalidManagerOutputRules(config);
  validateParallelSubStepNamesUnique(config);

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
        config.findingContract !== undefined,
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
          config.findingContract !== undefined,
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
        config.findingContract !== undefined,
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
      providerSource: options.providerSource,
      model: options.model,
      modelSource: options.modelSource,
      autoRouting: options.autoRouting,
      providerRouting: options.providerRouting,
      personaProviders: options.personaProviders,
    });
    for (const validationInfo of expandAutoRoutingProviderInfos(
      triggeringStep,
      triggeringProviderInfo,
      options.autoRouting,
    )) {
      const judgeProviderInfo = resolveLoopMonitorJudgeProviderModel({
        judge: monitor.judge,
        triggeringProviderInfo: validationInfo.providerInfo,
      });
      validateResolvedProviderInfo(
        judgeProviderInfo,
        'Configuration error: loop_monitors.judge.model',
        validationInfo.autoRouted,
      );
    }
  }
}
