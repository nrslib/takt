import type { AutoRoutingConfig } from '../../models/config-types.js';
import type { AgentWorkflowStep, LoopMonitorRule, WorkflowConfig, WorkflowRule, WorkflowStep } from '../../models/types.js';
import {
  getAllParallelSubSteps,
  isDynamicParallelSubSteps,
} from '../../models/types.js';
import {
  SESSION_AGENT_STEP_REQUIRED_MESSAGE,
  SESSION_NORMAL_AGENT_STEP_REQUIRED_MESSAGE,
} from '../../models/workflow-session-constraints.js';
import { ABORT_STEP, COMPLETE_STEP, ERROR_MESSAGES } from '../constants.js';
import type { WorkflowEngineOptions } from '../types.js';
import {
  resolveLoopMonitorJudgeProviderModel,
  resolveStepProviderModel,
} from '../provider-resolution.js';
import { validateProviderModelRequirements } from '../provider-model-requirements.js';
import {
  LOOP_JUDGE_ROUTING_KEY,
  loopJudgeProviderFields,
  loopJudgeStepName,
} from '../loop-judge-step.js';
import { getWorkflowStepKind, isWorkflowCallStep } from '../step-kind.js';
import {
  findSemanticAppendixConflicts,
  hasAggregateCondition,
} from '../../models/workflow-rule-condition.js';
import {
  resolveAutoRoutingCandidateProviderInfo,
  validateAutoRoutingResolvedProviderModel,
} from '../auto-routing/resolver.js';
import { hasAutoRoutingPoolAssignment, resolveExecutableRoutingCandidates } from '../auto-routing/selector.js';
import { findDuplicateWorkflowStepName } from '../../../shared/workflowStepNameValidator.js';
import { withWorkflowConfigErrorPath } from '../workflow-config-error.js';
import { findWorkflowStepLocation } from '../workflow-step-location.js';
import { getProviderValidationErrorSource, withProviderValidationErrorSource } from '../provider-validation-error.js';
import { validateDynamicParallelContracts } from '../dynamic-parallel/validator.js';

type ResolvedProviderInfo = ReturnType<typeof resolveStepProviderModel>;
const withWorkflowStepErrorPath = withWorkflowConfigErrorPath;

function providerValidationField(error: unknown, fallback: 'provider' | 'model'): 'provider' | 'model' {
  return getProviderValidationErrorSource(error)?.field ?? fallback;
}

function withConfigStepErrorPath(
  config: WorkflowConfig,
  step: WorkflowStep,
  fallbackPath: readonly PropertyKey[],
  fieldPath: readonly PropertyKey[],
  error: unknown,
): Error {
  return withWorkflowConfigErrorPath(error, [...(findWorkflowStepLocation(config, step) ?? fallbackPath), ...fieldPath]);
}

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
    || !hasAutoRoutingPoolAssignment(autoRouting, {
      name: step.name,
      tags: step.tags,
      personaKey: step.providerRoutingPersonaKey,
    })
  ) {
    return [{ providerInfo: currentProviderInfo, autoRouted: false }];
  }

  const resolvedCandidates = resolveExecutableRoutingCandidates(autoRouting, {
    name: step.name,
    tags: step.tags,
    personaKey: step.providerRoutingPersonaKey,
  });
  return resolvedCandidates.candidates.map((candidate) => ({
    providerInfo: resolveAutoRoutingCandidateProviderInfo(
      candidate,
      resolvedCandidates.resolutionSource,
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
  try {
    validateProviderModelRequirements(providerInfo.provider, providerInfo.model, { modelFieldName });
    if (autoRouted && providerInfo.provider !== undefined) {
      validateAutoRoutingResolvedProviderModel(providerInfo.provider, providerInfo.model);
    }
  } catch (error) {
    throw withProviderValidationErrorSource(error, providerInfo);
  }
}

function validateAggregateRulePlacement(
  rules: readonly (WorkflowRule | LoopMonitorRule)[],
  aggregateAllowed: boolean,
  source: string,
  rulesPath: readonly PropertyKey[],
): void {
  if (aggregateAllowed) {
    return;
  }
  const ruleIndex = rules.findIndex((rule) => hasAggregateCondition(rule.condition));
  if (ruleIndex >= 0) {
    throw withWorkflowConfigErrorPath(
      new Error(`${source}: aggregate conditions are only allowed on parallel parent steps with sub-steps`),
      [...rulesPath, ruleIndex],
    );
  }
}

function validateSemanticAppendices(
  rules: readonly WorkflowRule[],
  source: string,
  rulesPath: readonly PropertyKey[],
): void {
  const conflicts = findSemanticAppendixConflicts(rules.map((rule, ruleIndex) => ({
    ruleIndex,
    condition: rule.condition,
    appendix: rule.appendix,
  })));
  const conflict = conflicts[0];
  if (conflict !== undefined) {
    throw withWorkflowConfigErrorPath(
      new Error(`${source}: Rules sharing semantic label "${conflict.label}" must use the same appendix`),
      [...rulesPath, conflict.ruleIndex],
    );
  }
}

function validateAgentStepProviderModel(
  step: WorkflowConfig['steps'][number],
  options: WorkflowEngineOptions,
  source: string,
  stepPath: readonly PropertyKey[],
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
    tagConflictPolicy: options.providerRoutingTagConflictPolicy,
    personaProviders: options.personaProviders,
  });
  let validationInfos: ValidationProviderInfo[];
  try {
    validationInfos = expandAutoRoutingProviderInfos(agentStep, providerInfo, options.autoRouting);
  } catch (error) {
    const field = providerValidationField(error, agentStep.model !== undefined ? 'model' : 'provider');
    throw withWorkflowConfigErrorPath(error, [
      ...stepPath,
      field,
    ]);
  }
  for (const validationInfo of validationInfos) {
    try {
      validateResolvedProviderInfo(
        validationInfo.providerInfo,
        `${source}.model`,
        validationInfo.autoRouted,
      );
    } catch (error) {
      const field = providerValidationField(error, agentStep.model !== undefined ? 'model' : 'provider');
      throw withWorkflowConfigErrorPath(error, [
        ...stepPath,
        field,
      ]);
    }
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

function validateWorkflowStepNamesUnique(config: WorkflowConfig): void {
  const duplicate = findDuplicateWorkflowStepName(config.steps);
  if (!duplicate) {
    return;
  }
  if (duplicate.parentName) {
    throw withWorkflowConfigErrorPath(
      new Error(`Configuration error: parallel step "${duplicate.parentName}" contains duplicate sub-step name "${duplicate.name}"`),
      duplicate.path,
    );
  }
  throw withWorkflowConfigErrorPath(
    new Error(`Configuration error: workflow contains duplicate step name "${duplicate.name}"`),
    duplicate.path,
  );
}

function findWorkflowCallStep(
  steps: readonly WorkflowStep[],
  parentPath: readonly PropertyKey[] = ['steps'],
): { step: WorkflowStep; path: readonly PropertyKey[] } | undefined {
  for (const [index, step] of steps.entries()) {
    const path = [...parentPath, index];
    if (isWorkflowCallStep(step)) {
      return { step, path };
    }
    const nested = findWorkflowCallStep(
      step.parallel === undefined ? [] : getAllParallelSubSteps(step.parallel),
      [...path, 'parallel'],
    );
    if (nested !== undefined) {
      return nested;
    }
  }
  return undefined;
}

export function validateWorkflowConfig(config: WorkflowConfig, options: WorkflowEngineOptions): void {
  const initialStep = config.steps.find((step) => step.name === config.initialStep);
  if (!initialStep) {
    throw new Error(ERROR_MESSAGES.UNKNOWN_STEP(config.initialStep));
  }
  validateDynamicParallelContracts(config.steps, ['steps']);
  validateWorkflowStepNamesUnique(config);

  if (options.startStep) {
    const startStep = config.steps.find((step) => step.name === options.startStep);
    if (!startStep) {
      throw new Error(ERROR_MESSAGES.UNKNOWN_STEP(options.startStep));
    }
  }

  const workflowCallStep = findWorkflowCallStep(config.steps);
  if (workflowCallStep !== undefined && !options.workflowCallResolver) {
    throw withConfigStepErrorPath(
      config,
      workflowCallStep.step,
      workflowCallStep.path,
      ['call'],
      new Error('Configuration error: workflowCallResolver is required when workflow contains workflow_call steps'),
    );
  }

  const stepNames = new Set(config.steps.map((step) => step.name));
  stepNames.add(COMPLETE_STEP);
  stepNames.add(ABORT_STEP);

  for (const [stepIndex, step] of config.steps.entries()) {
    try {
      const stepPath = findWorkflowStepLocation(config, step) ?? ['steps', stepIndex];
      try {
        validateSessionEntrypoint(step, `Configuration error: step "${step.name}"`);
      } catch (error) {
        throw withWorkflowStepErrorPath(error, [...stepPath, 'session']);
      }
      try {
        validateAgentStepProviderModel(step, options, `Configuration error: step "${step.name}"`, stepPath);
      } catch (error) {
        throw withWorkflowStepErrorPath(error, stepPath);
      }
      validateAggregateRulePlacement(
        step.rules ?? [],
        step.parallel !== undefined && getAllParallelSubSteps(step.parallel).length > 0,
        `Invalid rule in step "${step.name}"`,
        [...stepPath, 'rules'],
      );
      validateSemanticAppendices(step.rules ?? [], `Invalid rule in step "${step.name}"`, [...stepPath, 'rules']);
      for (const [ruleIndex, rule] of (step.rules ?? []).entries()) {
        if (rule.next && !stepNames.has(rule.next)) {
          throw withWorkflowStepErrorPath(
            new Error(`Invalid rule in step "${step.name}": target step "${rule.next}" does not exist`),
            [...stepPath, 'rules', ruleIndex],
          );
        }
      }
      const subSteps = step.parallel === undefined ? [] : getAllParallelSubSteps(step.parallel);
      for (const [subStepIndex, subStep] of subSteps.entries()) {
        const subStepPath = findWorkflowStepLocation(config, subStep)
          ?? ['steps', stepIndex, 'parallel', subStepIndex];
          validateAggregateRulePlacement(
            subStep.rules ?? [],
            false,
            `Invalid rule in parallel sub-step "${subStep.name}" of step "${step.name}"`,
            [...subStepPath, 'rules'],
          );
          validateSemanticAppendices(
            subStep.rules ?? [],
            `Invalid rule in parallel sub-step "${subStep.name}" of step "${step.name}"`,
            [...subStepPath, 'rules'],
          );
          try {
            validateSessionEntrypoint(
              subStep,
              `Configuration error: parallel sub-step "${subStep.name}" of step "${step.name}"`,
            );
          } catch (error) {
            throw withWorkflowStepErrorPath(error, [...subStepPath, 'session']);
          }
          if (!isDynamicParallelSubSteps(step.parallel!)) {
            try {
              validateAgentStepProviderModel(
                subStep,
                options,
                `Configuration error: parallel sub-step "${subStep.name}" of step "${step.name}"`,
                subStepPath,
              );
            } catch (error) {
              throw withWorkflowStepErrorPath(error, subStepPath);
            }
          }
      }
    } catch (error) {
      throw withWorkflowStepErrorPath(error, ['steps', stepIndex]);
    }
  }

  for (const [monitorIndex, monitor] of (config.loopMonitors ?? []).entries()) {
    validateAggregateRulePlacement(
      monitor.judge.rules,
      false,
      'Invalid loop_monitor judge rule',
      ['loop_monitors', monitorIndex, 'judge', 'rules'],
    );
    for (const cycleName of monitor.cycle) {
      if (!stepNames.has(cycleName)) {
        throw new Error(`Invalid loop_monitor: cycle references unknown step "${cycleName}"`);
      }
    }
    for (const ignoredName of monitor.ignoreSteps ?? []) {
      if (!stepNames.has(ignoredName)) {
        throw new Error(`Invalid loop_monitor: ignore_steps references unknown step "${ignoredName}"`);
      }
      if (monitor.cycle.includes(ignoredName)) {
        throw new Error(`Invalid loop_monitor: step "${ignoredName}" cannot appear in both cycle and ignore_steps`);
      }
    }
    for (const rule of monitor.judge.rules) {
      if (!stepNames.has(rule.next)) {
        throw new Error(`Invalid loop_monitor judge rule: target step "${rule.next}" does not exist`);
      }
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
      tagConflictPolicy: options.providerRoutingTagConflictPolicy,
      personaProviders: options.personaProviders,
    });
    // 実行時（LoopMonitorJudgeRunner）と同じ優先順位で検証するため、judge ステップ自身の
    // 通常解決（provider_routing.* / persona_providers.loop-judge を含む）も同じ
    // resolveStepProviderModel で取ってから合成する。routing キーは実行時に生成される
    // judge ステップ（_loop_judge_<cycle> / providerRoutingPersonaKey: 'loop-judge'）と揃える。
    const judgeStepProviderInfo = resolveStepProviderModel({
      step: {
        name: loopJudgeStepName(monitor.cycle),
        engineSynthesized: true,
        ...loopJudgeProviderFields(options.internalAgentSeats),
        personaDisplayName: LOOP_JUDGE_ROUTING_KEY,
        providerRoutingPersonaKey: LOOP_JUDGE_ROUTING_KEY,
      },
      provider: options.provider,
      providerSource: options.providerSource,
      model: options.model,
      modelSource: options.modelSource,
      providerRouting: options.providerRouting,
      tagConflictPolicy: options.providerRoutingTagConflictPolicy,
      personaProviders: options.personaProviders,
    });
    for (const validationInfo of expandAutoRoutingProviderInfos(
      triggeringStep,
      triggeringProviderInfo,
      options.autoRouting,
    )) {
      const judgeProviderInfo = resolveLoopMonitorJudgeProviderModel({
        judgeProviderInfo: judgeStepProviderInfo,
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
