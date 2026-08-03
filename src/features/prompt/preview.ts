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
  resolveWorkflowSelector,
  type SelectorProviderOverrides,
} from '../../infra/config/index.js';
import { InstructionBuilder } from '../../core/workflow/instruction/InstructionBuilder.js';
import { ReportInstructionBuilder } from '../../core/workflow/instruction/ReportInstructionBuilder.js';
import { StatusJudgmentBuilder } from '../../core/workflow/instruction/StatusJudgmentBuilder.js';
import { needsStatusJudgmentPhase } from '../../core/workflow/index.js';
import {
  resolveStepProviderModel,
  type ProviderModelResolutionContext,
} from '../../core/workflow/provider-resolution.js';
import { resolveDeterministicAutoRoutingProviderInfo, toAutoRoutingStepMetadata } from '../../core/workflow/auto-routing/resolver.js';
import { resolveEffectiveAutoRouting } from '../../core/workflow/auto-routing/effective-auto-routing.js';
import { buildFindingManagerStep } from '../../core/workflow/findings/manager-step.js';
import type { InstructionContext } from '../../core/workflow/instruction/instruction-context.js';
import type { WorkflowConfig, WorkflowStep } from '../../core/models/index.js';
import { getAllParallelSubSteps, isDynamicParallelSubSteps } from '../../core/models/types.js';
import type { Language } from '../../core/models/types.js';
import type { ProviderResolutionSource } from '../../core/workflow/provider-options-trace.js';
import type { SelectorProviderInfo } from '../../core/workflow/types.js';
import { redactProviderOptions } from '../../core/workflow/providerOptionsRedaction.js';
import { header, info, error, blankLine } from '../../shared/ui/index.js';
import { DEFAULT_WORKFLOW_NAME } from '../../shared/constants.js';
import { sanitizeTerminalText } from '../../shared/utils/text.js';
import { isWorkflowCallStep } from '../../core/workflow/step-kind.js';

function printStepExecutionMetadata(step: WorkflowStep): void {
  if (step.sessionKey) {
    console.log(`Session key: ${sanitizeTerminalText(step.sessionKey)}`);
  }
  if (step.requiresUserInput === true) {
    console.log('Requires user input: yes');
  }
  if (step.parallel && getAllParallelSubSteps(step.parallel).length > 0) {
    console.log(`Parallel substeps: ${getAllParallelSubSteps(step.parallel).length}`);
    if (isDynamicParallelSubSteps(step.parallel)) {
      console.log(`Dynamic selector mode: ${step.parallel.selection.mode}`);
    }
  }
}

function printDynamicSelectorMetadata(
  step: WorkflowStep,
  selector: SelectorProviderInfo | undefined,
): void {
  if (step.parallel === undefined || !isDynamicParallelSubSteps(step.parallel)) {
    return;
  }
  if (selector === undefined) {
    throw new Error('Dynamic parallel selector has no resolved provider');
  }
  info('Dynamic selector: TAKT internal agent');
  info(`Dynamic selector provider: ${formatConfiguredValue(selector.provider)}`);
  info(`Dynamic selector model: ${formatConfiguredValue(selector.model)}`);
  info(`Dynamic selector provider source: ${formatConfiguredValue(selector.providerSource)}`);
  info(`Dynamic selector model source: ${formatConfiguredValue(selector.modelSource)}`);
  info(`Dynamic selector provider options: ${formatProviderOptions(selector.providerOptions)}`);
  info('Dynamic selector permission: readonly');
  info(`Dynamic selector native tools: ${
    selector.nativeTools.length === 0
      ? 'none'
      : selector.nativeTools.map(sanitizeTerminalText).join(', ')
  }`);
}

function formatConfiguredValue(value: string | undefined): string {
  return value === undefined ? 'not configured' : sanitizeTerminalText(value);
}

function formatProviderOptions(
  providerOptions: SelectorProviderInfo['providerOptions'],
): string {
  if (Object.keys(providerOptions).length === 0) {
    return 'not configured';
  }
  return sanitizeTerminalText(JSON.stringify(redactProviderOptions(providerOptions)));
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
  // findings-manager は AI ルーターを通らないため、実行時（OptionsBuilder）と
  // 同じ rules → strategy デフォルトの決定的解決で表示する。
  return resolveDeterministicAutoRoutingProviderInfo({
    autoRouting: resolution.autoRouting,
    step: toAutoRoutingStepMetadata(step),
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
  if (config.maxSteps === undefined) {
    throw new Error(`Cannot preview callable workflow "${config.name}" without a root max_steps budget`);
  }
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
    // プレビューは実 run を持たないため {report:X} の存在検証を無効化する
    // （containment 検証は維持される）。
    validateReportReferences: false,
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
      task: context.task,
      reportDir: '.takt/runs/preview/reports',
      stepIteration: 1,
      language,
    });
    console.log('\n--- Phase 2 (Report Output) ---\n');
    console.log(reportBuilder.build());
  }

  if (needsStatusJudgmentPhase(step, false)) {
    const judgmentBuilder = new StatusJudgmentBuilder(step, { language });
    console.log('\n--- Phase 3 (Status Judgment) ---\n');
    console.log(judgmentBuilder.build());
  }
}

function previewControlStep(step: WorkflowStep): void {
  if (!isWorkflowCallStep(step)) {
    throw new Error(`Unsupported control step in prompt preview: ${step.name}`);
  }
  console.log('Control node: workflow_call');
  console.log(`Child workflow: ${sanitizeTerminalText(step.call)}`);
}

function formatStepHeading(label: string, step: WorkflowStep): string {
  const safeStepName = sanitizeTerminalText(step.name);
  if (isWorkflowCallStep(step)) {
    return `${label}: ${safeStepName}`;
  }
  return `${label}: ${safeStepName} (persona: ${sanitizeTerminalText(step.personaDisplayName)})`;
}

/**
 * Preview all prompts for a workflow.
 *
 * Loads the workflow definition, then for each step builds and displays
 * the Phase 1, Phase 2, and Phase 3 prompts with sample variable values.
 */
export async function previewPrompts(
  cwd: string,
  workflowIdentifier?: string,
  selectorOverrides?: SelectorProviderOverrides,
): Promise<void> {
  const identifier = workflowIdentifier ?? DEFAULT_WORKFLOW_NAME;
  const config = loadWorkflowByIdentifier(identifier, cwd);
  const safeIdentifier = sanitizeTerminalText(identifier);

  if (!config) {
    error(`Workflow "${safeIdentifier}" not found.`);
    return;
  }
  if (config.subworkflow?.callable === true) {
    throw new Error(`Cannot preview callable workflow "${config.name}" without a workflow_call context`);
  }

  const language = resolveWorkflowConfigValue(cwd, 'language') as Language;
  const providerResolution = resolvePreviewProviderResolution(cwd, config);
  const selectorResolution = resolveWorkflowSelector(config, {
    projectCwd: cwd,
    lookupCwd: cwd,
    overrides: selectorOverrides,
  });
  const selectorProvider = selectorResolution.applies
    ? selectorResolution.selectorProvider
    : undefined;
  const safeWorkflowName = sanitizeTerminalText(config.name);

  header(`Workflow Prompt Preview: ${safeWorkflowName}`);
  info(`Steps: ${config.steps.length}`);
  info(`Language: ${language}`);
  printFindingContractMetadata(config, providerResolution);
  blankLine();

  for (const [i, step] of config.steps.entries()) {
    const separator = '='.repeat(60);

    console.log(separator);
    console.log(formatStepHeading(`Step ${i + 1}`, step));
    console.log(separator);

    if (step.parallel && getAllParallelSubSteps(step.parallel).length > 0) {
      printStepExecutionMetadata(step);
      printDynamicSelectorMetadata(step, selectorProvider);
      for (const [subIndex, substep] of getAllParallelSubSteps(step.parallel).entries()) {
        const role = isDynamicParallelSubSteps(step.parallel)
          ? step.parallel.fixed.some((fixed) => fixed === substep) ? 'fixed' : 'pool candidate'
          : 'parallel';
        console.log(`\n--- ${formatStepHeading(`${role} substep ${subIndex + 1}`, substep)} ---\n`);
        if (isWorkflowCallStep(substep)) {
          previewControlStep(substep);
        } else {
          previewAgentStep(cwd, config, i, substep, language);
        }
      }
    } else if (isWorkflowCallStep(step)) {
      previewControlStep(step);
    } else {
      previewAgentStep(cwd, config, i, step, language);
    }

    blankLine();
  }
}
