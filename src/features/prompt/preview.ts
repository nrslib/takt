/**
 * Prompt preview feature
 *
 * Loads a workflow and displays the assembled prompt for each step and phase.
 * Useful for debugging and understanding what prompts agents will receive.
 */

import {
  loadWorkflowByIdentifier,
  resolveWorkflowConfigValue,
  resolveWorkflowSelector,
  type SelectorProviderOverrides,
} from '../../infra/config/index.js';
import { validateWorkflowCallContracts } from '../../infra/config/loaders/workflowResolver.js';
import { resolveAuxiliaryRuntimeEnvironment } from '../../infra/config/runtime-provider/provider-environment.js';
import type { CompiledProviderEnvironment } from '../../infra/config/runtime-provider/environment.js';
import { resolveWorkflowCompanions } from '../../infra/config/workflowCompanionResolution.js';
import { buildCompanionInstructionContext } from '../../core/workflow/companion/instruction-context.js';
import { InstructionBuilder } from '../../core/workflow/instruction/InstructionBuilder.js';
import { ReportInstructionBuilder } from '../../core/workflow/instruction/ReportInstructionBuilder.js';
import { StatusJudgmentBuilder } from '../../core/workflow/instruction/StatusJudgmentBuilder.js';
import { needsStatusJudgmentPhase } from '../../core/workflow/index.js';
import {
  type ProviderModelResolutionContext,
} from '../../core/workflow/provider-resolution.js';
import {
  collectTaskReviewScope,
  resolveReviewScopeBaseRange,
  type TaskReviewScope,
} from '../../core/workflow/review-scope.js';
import type { InstructionContext } from '../../core/workflow/instruction/instruction-context.js';
import type { WorkflowConfig, WorkflowStep } from '../../core/models/index.js';
import type { TagRoutingConflictPolicy } from '../../core/models/config-types.js';
import {
  getAllParallelSubSteps,
  isDynamicParallelSubSteps,
} from '../../core/models/types.js';
import type { Language } from '../../core/models/types.js';
import type { ProviderResolutionSource } from '../../core/workflow/provider-options-trace.js';
import type { SelectorProviderInfo } from '../../core/workflow/types.js';
import { redactProviderOptions } from '../../core/workflow/providerOptionsRedaction.js';
import { header, info, error, blankLine } from '../../shared/ui/index.js';
import { DEFAULT_WORKFLOW_NAME } from '../../shared/constants.js';
import { sanitizeTerminalText } from '../../shared/utils/text.js';
import { getErrorMessage } from '../../shared/utils/error.js';

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
  info(`Dynamic selector permission: ${formatConfiguredValue(selector.permissionMode)}`);
}

function formatConfiguredValue(value: string | undefined): string {
  return value === undefined ? 'not configured' : sanitizeTerminalText(value);
}

function formatProviderOptions(
  providerOptions: SelectorProviderInfo['providerOptions'],
): string {
  if (providerOptions === undefined || Object.keys(providerOptions).length === 0) {
    return 'not configured';
  }
  return sanitizeTerminalText(JSON.stringify(redactProviderOptions(providerOptions)));
}

type PreviewProviderResolution = CompiledProviderEnvironment & ProviderModelResolutionContext & {
  providerSource: ProviderResolutionSource;
  modelSource: ProviderResolutionSource;
  tagConflictPolicy: TagRoutingConflictPolicy;
  companionEnabled: boolean;
  companionReviewMode: ReturnType<typeof resolveAuxiliaryRuntimeEnvironment>['companionReviewMode'];
  providerEnvironment: CompiledProviderEnvironment;
  providerConfigMode: ReturnType<typeof resolveAuxiliaryRuntimeEnvironment>['providerConfigMode'];
};

function resolvePreviewProviderResolution(
  cwd: string,
  config: WorkflowConfig,
): PreviewProviderResolution {
  const runtimeEnvironment = resolveAuxiliaryRuntimeEnvironment(cwd, config);
  return {
    ...runtimeEnvironment.providerEnvironment,
    companionEnabled: runtimeEnvironment.companionEnabled,
    companionReviewMode: runtimeEnvironment.companionReviewMode,
    providerEnvironment: runtimeEnvironment.providerEnvironment,
    providerConfigMode: runtimeEnvironment.providerConfigMode,
  };
}

/**
 * レビュー範囲はプレビュー実行ごとに1度だけ解決する。ステップ・並列サブステップごとに
 * 再解決すると、同じプレビュー出力の中で提示される範囲がずれ得る。
 *
 * `takt prompt` は診断ツールであり、レビュー範囲はプレビュー対象の一部でしかない。
 * git が使えない、リポジトリが壊れている、パスが非 UTF-8 といった理由で範囲を
 * 解決できなくても、プロンプト本体のプレビューは見せる価値がある。そのため
 * ここだけ例外を診断値へ変換する。**この変換は preview 経路限定** であり、
 * 実行時（WorkflowEngineSetup 経由）のスコープ解決は fail-fast のまま変えない。
 * 範囲が undefined のとき `{review_scope}` は「算出していません」に解決する。
 */
function resolvePreviewReviewScope(cwd: string): TaskReviewScope | undefined {
  try {
    return collectTaskReviewScope({ cwd, baseRange: resolveReviewScopeBaseRange(cwd) });
  } catch (err) {
    info(`Review scope unavailable: ${sanitizeTerminalText(getErrorMessage(err))}`);
    return undefined;
  }
}

function buildInstructionContext(
  cwd: string,
  config: WorkflowConfig,
  stepIndex: number,
  step: WorkflowStep,
  language: Language,
  reviewScope: TaskReviewScope | undefined,
  providerResolution: PreviewProviderResolution,
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
    // プレビューは実 run を持たないため {report:X} の存在検証を無効化する
    // （containment 検証は維持される）。
    validateReportReferences: false,
    language,
    reviewScope,
    workflowRules: step.engineSynthesized === true ? undefined : config.allStepsRules,
    companion: buildCompanionInstructionContext({
      companionEnabled: providerResolution.companionEnabled,
      companionReviewMode: providerResolution.companionReviewMode,
      cwd,
      step,
      getRunSlug: () => 'preview',
      getRunPathNamespace: () => [],
    }),
  };
}

function previewAgentStep(
  cwd: string,
  config: WorkflowConfig,
  stepIndex: number,
  step: WorkflowStep,
  language: Language,
  reviewScope: TaskReviewScope | undefined,
  providerResolution: PreviewProviderResolution,
): void {
  printStepExecutionMetadata(step);

  const context = buildInstructionContext(
    cwd,
    config,
    stepIndex,
    step,
    language,
    reviewScope,
    providerResolution,
  );
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
      reviewScope: context.reviewScope,
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

  const language = resolveWorkflowConfigValue(cwd, 'language') as Language;
  const providerResolution = resolvePreviewProviderResolution(cwd, config);
  validateWorkflowCallContracts(config, cwd, cwd);
  const selectorResolution = resolveWorkflowSelector(config, {
    projectCwd: cwd,
    lookupCwd: cwd,
    overrides: selectorOverrides,
    companionEnabled: providerResolution.companionEnabled,
    providerEnvironment: providerResolution.providerEnvironment,
    providerConfigMode: providerResolution.providerConfigMode,
  });
  if (providerResolution.companionEnabled) {
    resolveWorkflowCompanions(config, providerResolution, {
      projectCwd: cwd,
      lookupCwd: cwd,
    });
  }
  const selectorProvider = selectorResolution.applies
    ? selectorResolution.selectorProvider
    : undefined;
  const safeWorkflowName = sanitizeTerminalText(config.name);

  header(`Workflow Prompt Preview: ${safeWorkflowName}`);
  info(`Steps: ${config.steps.length}`);
  info(`Language: ${language}`);
  info(`Companion review mode: ${providerResolution.companionReviewMode}`);
  if (config.allStepsRules && config.allStepsRules.length > 0) {
    info('Workflow-wide rules:');
    for (const rule of config.allStepsRules) {
      info(`- ref: ${sanitizeTerminalText(rule.ref)}`);
      info(`  position: ${sanitizeTerminalText(rule.position)}`);
      info(`  content: ${sanitizeTerminalText(rule.content)}`);
    }
  }
  blankLine();

  const reviewScope = resolvePreviewReviewScope(cwd);

  for (const [i, step] of config.steps.entries()) {
    const separator = '='.repeat(60);
    const safeStepName = sanitizeTerminalText(step.name);
    const safePersonaDisplayName = sanitizeTerminalText(step.personaDisplayName);

    console.log(separator);
    console.log(`Step ${i + 1}: ${safeStepName} (persona: ${safePersonaDisplayName})`);
    console.log(separator);

    if (step.parallel && getAllParallelSubSteps(step.parallel).length > 0) {
      printStepExecutionMetadata(step);
      printDynamicSelectorMetadata(step, selectorProvider);
      for (const [subIndex, substep] of getAllParallelSubSteps(step.parallel).entries()) {
        const safeSubstepName = sanitizeTerminalText(substep.name);
        const safeSubstepPersonaDisplayName = sanitizeTerminalText(substep.personaDisplayName);
        const role = isDynamicParallelSubSteps(step.parallel)
          ? step.parallel.fixed.some((fixed) => fixed === substep) ? 'fixed' : 'pool candidate'
          : 'parallel';
        console.log(`\n--- ${role} substep ${subIndex + 1}: ${safeSubstepName} (persona: ${safeSubstepPersonaDisplayName}) ---\n`);
        previewAgentStep(cwd, config, i, substep, language, reviewScope, providerResolution);
      }
    } else {
      previewAgentStep(cwd, config, i, step, language, reviewScope, providerResolution);
    }

    blankLine();
  }
}
