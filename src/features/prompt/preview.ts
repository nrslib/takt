/**
 * Prompt preview feature
 *
 * Loads a workflow and displays the assembled prompt for each step and phase.
 * Useful for debugging and understanding what prompts agents will receive.
 */

import {
  loadWorkflowByIdentifier,
  resolveConfigValueWithSource,
  resolveWorkflowConfigValue,
  resolveWorkflowConfigValues,
} from '../../infra/config/index.js';
import { InstructionBuilder } from '../../core/workflow/instruction/InstructionBuilder.js';
import { ReportInstructionBuilder } from '../../core/workflow/instruction/ReportInstructionBuilder.js';
import { StatusJudgmentBuilder } from '../../core/workflow/instruction/StatusJudgmentBuilder.js';
import { needsStatusJudgmentPhase } from '../../core/workflow/index.js';
import {
  resolveStepProviderModel,
  type ProviderModelResolutionContext,
} from '../../core/workflow/provider-resolution.js';
import { resolveRuleBasedAutoRoutingProviderInfo } from '../../core/workflow/auto-routing/resolver.js';
import { resolveEffectiveAutoRouting } from '../../core/workflow/auto-routing/effective-auto-routing.js';
import { buildFindingManagerStep } from '../../core/workflow/findings/manager-step.js';
import type { InstructionContext } from '../../core/workflow/instruction/instruction-context.js';
import type { WorkflowConfig, WorkflowStep } from '../../core/models/index.js';
import type { Language } from '../../core/models/types.js';
import type { ProviderResolutionSource } from '../../core/workflow/provider-options-trace.js';
import { header, info, error, blankLine } from '../../shared/ui/index.js';
import { DEFAULT_WORKFLOW_NAME } from '../../shared/constants.js';
import { sanitizeTerminalText } from '../../shared/utils/text.js';

function printStepExecutionMetadata(step: WorkflowStep): void {
  if (step.sessionKey) {
    console.log(`Session key: ${sanitizeTerminalText(step.sessionKey)}`);
  }
  if (step.requiresUserInput === true) {
    console.log('Requires user input: yes');
  }
  if (step.parallel && step.parallel.length > 0) {
    console.log(`Parallel substeps: ${step.parallel.length}`);
  }
}

function formatConfiguredValue(value: string | undefined): string {
  return value === undefined ? 'not configured' : sanitizeTerminalText(value);
}

type PreviewProviderResolution = ProviderModelResolutionContext & {
  providerSource: ProviderResolutionSource;
  modelSource: ProviderResolutionSource;
};

function resolvePreviewProviderResolution(
  cwd: string,
  config: WorkflowConfig,
): PreviewProviderResolution {
  const resolution = resolveWorkflowConfigValues(
    cwd,
    ['autoRouting', 'personaProviders', 'providerRouting'],
  );
  const provider = resolveConfigValueWithSource(cwd, 'provider', { workflowContext: config });
  const model = resolveConfigValueWithSource(cwd, 'model', { workflowContext: config });
  return {
    ...resolution,
    provider: provider.value,
    providerSource: provider.source,
    model: model.value,
    modelSource: model.source,
    autoRouting: resolveEffectiveAutoRouting(config, resolution.autoRouting),
  };
}

function resolveFindingManagerProviderModel(
  config: WorkflowConfig,
  resolution: PreviewProviderResolution,
): ReturnType<typeof resolveStepProviderModel> | undefined {
  if (!config.findingContract) {
    return undefined;
  }
  const step = buildFindingManagerStep({
    contract: config.findingContract,
    workflowProvider: config.provider,
    workflowModel: config.model,
  });
  const currentProviderInfo = resolveStepProviderModel({
    step,
    provider: resolution.provider,
    providerSource: resolution.providerSource,
    model: resolution.model,
    modelSource: resolution.modelSource,
    autoRouting: resolution.autoRouting,
    personaProviders: resolution.personaProviders,
    providerRouting: resolution.providerRouting,
  });
  if (resolution.autoRouting === undefined) {
    return currentProviderInfo;
  }
  return resolveRuleBasedAutoRoutingProviderInfo({
    autoRouting: resolution.autoRouting,
    step: {
      name: step.name,
      tags: step.tags,
      personaKey: step.providerRoutingPersonaKey,
      instruction: step.instruction,
    },
    currentProviderInfo,
  }) ?? currentProviderInfo;
}

function printFindingContractMetadata(
  config: WorkflowConfig,
  resolution: PreviewProviderResolution,
): void {
  const manager = config.findingContract?.manager;
  if (!manager) {
    return;
  }
  const providerInfo = resolveFindingManagerProviderModel(config, resolution);

  info(`Finding manager: ${sanitizeTerminalText(manager.personaDisplayName ?? manager.persona)}`);
  info(`Finding manager provider: ${formatConfiguredValue(providerInfo?.provider)}`);
  info(`Finding manager model: ${formatConfiguredValue(providerInfo?.model)}`);
}

function buildInstructionContext(
  cwd: string,
  config: WorkflowConfig,
  stepIndex: number,
  step: WorkflowStep,
  language: Language,
): InstructionContext {
  return {
    task: '<task content>',
    iteration: 1,
    maxSteps: config.maxSteps,
    stepIteration: 1,
    cwd,
    projectCwd: cwd,
    userInputs: [],
    workflowSteps: config.steps,
    currentStepIndex: stepIndex,
    reportDir: step.outputContracts && step.outputContracts.length > 0 ? '.takt/runs/preview/reports' : undefined,
    language,
  };
}

function previewAgentStep(
  cwd: string,
  config: WorkflowConfig,
  stepIndex: number,
  step: WorkflowStep,
  language: Language,
): void {
  printStepExecutionMetadata(step);

  const context = buildInstructionContext(cwd, config, stepIndex, step, language);
  const phase1Builder = new InstructionBuilder(step, context);
  console.log('\n--- Phase 1 (Main Execution) ---\n');
  console.log(phase1Builder.build());

  if (step.outputContracts && step.outputContracts.length > 0) {
    const reportBuilder = new ReportInstructionBuilder(step, {
      cwd,
      reportDir: '.takt/runs/preview/reports',
      stepIteration: 1,
      language,
    });
    console.log('\n--- Phase 2 (Report Output) ---\n');
    console.log(reportBuilder.build());
  }

  if (needsStatusJudgmentPhase(step)) {
    const judgmentBuilder = new StatusJudgmentBuilder(step, { language });
    console.log('\n--- Phase 3 (Status Judgment) ---\n');
    console.log(judgmentBuilder.build());
  }
}

/**
 * Preview all prompts for a workflow.
 *
 * Loads the workflow definition, then for each step builds and displays
 * the Phase 1, Phase 2, and Phase 3 prompts with sample variable values.
 */
export async function previewPrompts(cwd: string, workflowIdentifier?: string): Promise<void> {
  const identifier = workflowIdentifier ?? DEFAULT_WORKFLOW_NAME;
  const config = loadWorkflowByIdentifier(identifier, cwd);
  const safeIdentifier = sanitizeTerminalText(identifier);

  if (!config) {
    error(`Workflow "${safeIdentifier}" not found.`);
    return;
  }

  const language = resolveWorkflowConfigValue(cwd, 'language') as Language;
  const providerResolution = resolvePreviewProviderResolution(cwd, config);
  const safeWorkflowName = sanitizeTerminalText(config.name);

  header(`Workflow Prompt Preview: ${safeWorkflowName}`);
  info(`Steps: ${config.steps.length}`);
  info(`Language: ${language}`);
  printFindingContractMetadata(config, providerResolution);
  blankLine();

  for (const [i, step] of config.steps.entries()) {
    const separator = '='.repeat(60);
    const safeStepName = sanitizeTerminalText(step.name);
    const safePersonaDisplayName = sanitizeTerminalText(step.personaDisplayName);

    console.log(separator);
    console.log(`Step ${i + 1}: ${safeStepName} (persona: ${safePersonaDisplayName})`);
    console.log(separator);

    if (step.parallel && step.parallel.length > 0) {
      printStepExecutionMetadata(step);
      for (const [subIndex, substep] of step.parallel.entries()) {
        const safeSubstepName = sanitizeTerminalText(substep.name);
        const safeSubstepPersonaDisplayName = sanitizeTerminalText(substep.personaDisplayName);
        console.log(`\n--- Parallel Substep ${subIndex + 1}: ${safeSubstepName} (persona: ${safeSubstepPersonaDisplayName}) ---\n`);
        previewAgentStep(cwd, config, i, substep, language);
      }
    } else {
      previewAgentStep(cwd, config, i, step, language);
    }

    blankLine();
  }
}
