import type { AgentWorkflowStep, LoopMonitorRule, WorkflowConfig, WorkflowRule } from '../../models/types.js';
import { ABORT_STEP, COMPLETE_STEP, ERROR_MESSAGES } from '../constants.js';
import type { WorkflowEngineOptions } from '../types.js';
import { resolveLoopMonitorJudgeProviderModel, resolveStepProviderModel } from '../provider-resolution.js';
import { validateProviderModelCompatibility } from '../provider-model-compatibility.js';
import { getWorkflowStepKind, isWorkflowCallStep } from '../step-kind.js';
import { hasUnquotedFindingsReference, isFindingsCondition, isInvalidManagerOutputRule } from '../evaluation/rule-utils.js';

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
  validateProviderModelCompatibility(
    providerInfo.provider,
    providerInfo.model,
    {
      modelFieldName: `${source}.model`,
    },
  );
  validatePromotionProviderModels(agentStep, providerInfo, source);
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
    validateProviderModelCompatibility(
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

export function validateWorkflowConfig(config: WorkflowConfig, options: WorkflowEngineOptions): void {
  const initialStep = config.steps.find((step) => step.name === config.initialStep);
  if (!initialStep) {
    throw new Error(ERROR_MESSAGES.UNKNOWN_STEP(config.initialStep));
  }
  validateFindingContractParallelStructuredOutput(config);
  validateFindingContractInvalidManagerOutputRules(config);

  if (options.startStep) {
    const startStep = config.steps.find((step) => step.name === options.startStep);
    if (!startStep) {
      throw new Error(ERROR_MESSAGES.UNKNOWN_STEP(options.startStep));
    }
  }

  if (config.steps.some((step) => isWorkflowCallStep(step)) && !options.workflowCallResolver) {
    throw new Error('Configuration error: workflowCallResolver is required when workflow contains workflow_call steps');
  }

  const stepNames = new Set(config.steps.map((step) => step.name));
  stepNames.add(COMPLETE_STEP);
  stepNames.add(ABORT_STEP);

  for (const step of config.steps) {
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
      model: options.model,
      providerRouting: options.providerRouting,
      personaProviders: options.personaProviders,
    });
    const judgeProviderInfo = resolveLoopMonitorJudgeProviderModel({
      judge: monitor.judge,
      triggeringProviderInfo,
    });
    validateProviderModelCompatibility(
      judgeProviderInfo.provider,
      judgeProviderInfo.model,
      {
        modelFieldName: 'Configuration error: loop_monitors.judge.model',
      },
    );
  }
}
