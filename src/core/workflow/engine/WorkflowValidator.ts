import type { WorkflowConfig } from '../../models/types.js';
import { ABORT_STEP, COMPLETE_STEP, ERROR_MESSAGES } from '../constants.js';
import type { WorkflowEngineOptions } from '../types.js';
import { resolveLoopMonitorJudgeProviderModel, resolveStepProviderModel } from '../provider-resolution.js';
import { validateProviderModelCompatibility } from '../provider-model-compatibility.js';

export function validateWorkflowConfig(config: WorkflowConfig, options: WorkflowEngineOptions): void {
  const initialStep = config.steps.find((step) => step.name === config.initialStep);
  if (!initialStep) {
    throw new Error(ERROR_MESSAGES.UNKNOWN_STEP(config.initialStep));
  }

  if (options.startStep) {
    const startStep = config.steps.find((step) => step.name === options.startStep);
    if (!startStep) {
      throw new Error(ERROR_MESSAGES.UNKNOWN_STEP(options.startStep));
    }
  }

  const stepNames = new Set(config.steps.map((step) => step.name));
  stepNames.add(COMPLETE_STEP);
  stepNames.add(ABORT_STEP);

  for (const step of config.steps) {
    for (const rule of step.rules ?? []) {
      if (rule.next && !stepNames.has(rule.next)) {
        throw new Error(`Invalid rule in step "${step.name}": target step "${rule.next}" does not exist`);
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
    }

    const triggeringStep = config.steps.find((step) => step.name === monitor.cycle[monitor.cycle.length - 1]);
    if (!triggeringStep) {
      continue;
    }
    const triggeringProviderInfo = resolveStepProviderModel({
      step: triggeringStep,
      provider: options.provider,
      model: options.model,
      personaProviders: options.personaProviders,
    });
    const judgeProviderInfo = resolveLoopMonitorJudgeProviderModel({
      judge: monitor.judge,
      triggeringStep,
      provider: triggeringProviderInfo.provider,
      model: triggeringProviderInfo.model,
      personaProviders: options.personaProviders,
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
