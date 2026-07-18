import type { InteractiveMode, WorkflowConfig, WorkflowStep } from '../../../core/models/index.js';
import type { StepProviderOptions } from '../../../core/models/workflow-types.js';
import {
  resolveStepProviderModel,
  type ProviderModelResolutionContext,
} from '../../../core/workflow/provider-resolution.js';
import type { StepProviderInfo } from '../../../core/workflow/types.js';
import type { ProviderResolutionSource } from '../../../core/workflow/provider-options-trace.js';
import { resolveRuleBasedAutoRoutingProviderInfo } from '../../../core/workflow/auto-routing/resolver.js';
import { resolveEffectiveAutoRouting } from '../../../core/workflow/auto-routing/effective-auto-routing.js';
import { buildFindingManagerStep } from '../../../core/workflow/findings/manager-step.js';
import {
  assertProviderResolvedForCapabilitySensitiveOptions,
  resolveAllowedToolsForProvider,
  resolveInspectToolsForProvider,
} from '../../../core/workflow/engine/engine-provider-options.js';
import { createTeamLeaderPlanningStep } from '../../../core/workflow/engine/team-leader-common.js';
import { createLogger, getErrorMessage } from '../../../shared/utils/index.js';
import { resolveWorkflowConfigValues } from '../resolveWorkflowConfigValue.js';
import { resolveConfigValueWithSource, resolveProviderOptionsWithTrace } from '../resolveConfigValue.js';
import {
  resolveEffectiveProviderOptions,
  resolveDirectStepProviderOptions,
  mergeProviderOptions,
  mergeStepProviderOptionsLayers,
} from '../providerOptions.js';
import { loadPersonaPromptFromPath } from './agentLoader.js';
import { loadWorkflowByIdentifier } from './workflowResolver.js';

const log = createLogger('workflow-preview');

export interface StepPreview {
  name: string;
  personaDisplayName: string;
  personaContent: string;
  instructionContent: string;
  allowedTools: string[];
  canEdit: boolean;
  provider?: StepProviderInfo['provider'];
  model?: StepProviderInfo['model'];
  sessionKey?: string;
  requiresUserInput?: boolean;
  substeps?: StepPreview[];
}

export interface FirstStepInfo {
  personaContent: string;
  personaDisplayName: string;
  allowedTools: string[];
}

interface PreviewProviderResolution extends ProviderModelResolutionContext {
  providerSource: ProviderResolutionSource;
  modelSource: ProviderResolutionSource;
  providerOptions: StepProviderOptions | undefined;
  providerOptionsSource: ReturnType<typeof resolveProviderOptionsWithTrace>['source'];
  providerOptionsOriginResolver: ReturnType<typeof resolveProviderOptionsWithTrace>['originResolver'];
}

function buildWorkflowString(steps: WorkflowStep[]): string {
  const lines: string[] = [];
  let index = 1;
  for (const step of steps) {
    lines.push(`${index}. ${step.name}${step.description ? ` (${step.description})` : ''}`);
    for (const sub of step.parallel ?? []) {
      lines.push(`   - ${sub.name}${sub.description ? ` (${sub.description})` : ''}`);
    }
    index++;
  }
  return lines.join('\n');
}

function readStepPersona(step: WorkflowStep, projectCwd: string): string {
  if (!step.personaPath) {
    return step.persona ?? '';
  }
  try {
    return loadPersonaPromptFromPath(step.personaPath, projectCwd);
  } catch (error) {
    log.debug('Failed to read persona file', { path: step.personaPath, error: getErrorMessage(error) });
    return '';
  }
}

function resolvePreviewStep(step: WorkflowStep): WorkflowStep {
  return step.teamLeader ? createTeamLeaderPlanningStep(step) : step;
}

function resolvePreviewCanEdit(step: WorkflowStep): boolean {
  return !step.teamLeader && step.edit === true;
}

function resolvePreviewProviderInfo(
  step: WorkflowStep,
  resolution: PreviewProviderResolution,
): StepProviderInfo {
  const currentProviderInfo = resolveStepProviderModel({
    step,
    provider: resolution.provider,
    providerSource: resolution.providerSource,
    model: resolution.model,
    modelSource: resolution.modelSource,
    autoRouting: resolution.autoRouting,
    providerRouting: resolution.providerRouting,
    personaProviders: resolution.personaProviders,
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

function buildFindingManagerPreview(
  workflow: WorkflowConfig,
  projectCwd: string,
  resolution: PreviewProviderResolution,
): StepPreview | undefined {
  if (!workflow.findingContract) {
    return undefined;
  }
  const managerStep = buildFindingManagerStep({
    contract: workflow.findingContract,
    workflowProvider: workflow.provider,
    workflowModel: workflow.model,
  });
  const providerInfo = resolvePreviewProviderInfo(managerStep, resolution);

  return {
    name: managerStep.name,
    personaDisplayName: managerStep.personaDisplayName,
    personaContent: readStepPersona(managerStep, projectCwd),
    instructionContent: managerStep.instruction,
    allowedTools: [],
    canEdit: false,
    provider: providerInfo.provider,
    model: providerInfo.model,
  };
}

function buildStepPreview(
  workflow: WorkflowConfig,
  step: WorkflowStep,
  projectCwd: string,
  resolution: PreviewProviderResolution,
): StepPreview {
  const previewStep = resolvePreviewStep(step);
  const parallelSubsteps = previewStep.parallel?.map((substep) =>
    buildStepPreview(workflow, substep, projectCwd, resolution),
  );
  const isParallelParent = parallelSubsteps !== undefined && parallelSubsteps.length > 0;
  const managerPreview = isParallelParent
    ? buildFindingManagerPreview(workflow, projectCwd, resolution)
    : undefined;
  const substeps = managerPreview ? [...(parallelSubsteps ?? []), managerPreview] : parallelSubsteps;
  const providerInfo = isParallelParent ? undefined : resolvePreviewProviderInfo(previewStep, resolution);

  return {
    name: step.name,
    personaDisplayName: previewStep.personaDisplayName,
    personaContent: isParallelParent ? '' : readStepPersona(previewStep, projectCwd),
    instructionContent: isParallelParent ? '' : previewStep.instruction,
    allowedTools: isParallelParent ? [] : resolvePreviewAllowedTools(previewStep, resolution),
    canEdit: isParallelParent ? false : resolvePreviewCanEdit(previewStep),
    ...(providerInfo?.provider !== undefined ? { provider: providerInfo.provider } : {}),
    ...(providerInfo?.model !== undefined ? { model: providerInfo.model } : {}),
    sessionKey: previewStep.sessionKey,
    requiresUserInput: previewStep.requiresUserInput,
    ...(isParallelParent ? { substeps } : {}),
  };
}

function resolvePreviewProviderResolution(
  projectCwd: string,
  workflow: WorkflowConfig,
): PreviewProviderResolution {
  const {
    autoRouting,
    personaProviders,
    providerRouting,
  } = resolveWorkflowConfigValues(
    projectCwd,
    ['autoRouting', 'personaProviders', 'providerRouting'],
  );
  const provider = resolveConfigValueWithSource(projectCwd, 'provider', {
    workflowContext: workflow,
  });
  const model = resolveConfigValueWithSource(projectCwd, 'model', {
    workflowContext: workflow,
  });
  const {
    value: providerOptions,
    source: providerOptionsSource,
    originResolver: providerOptionsOriginResolver,
  } = resolveProviderOptionsWithTrace(projectCwd);

  return {
    provider: provider.value,
    providerSource: provider.source,
    model: model.value,
    modelSource: model.source,
    autoRouting: resolveEffectiveAutoRouting(workflow, autoRouting),
    personaProviders,
    providerRouting,
    providerOptions,
    providerOptionsSource,
    providerOptionsOriginResolver,
  };
}

function resolvePreviewAllowedTools(
  step: WorkflowStep,
  resolution: PreviewProviderResolution,
): string[] {
  const providerInfo = resolvePreviewProviderInfo(step, resolution);
  const stepProviderOptions = mergeProviderOptions(
    providerInfo.providerOptions,
    resolveDirectStepProviderOptions(step),
  );
  const mergedProviderOptions = resolveEffectiveProviderOptions(
    resolution.providerOptionsSource,
    resolution.providerOptionsOriginResolver,
    resolution.providerOptions,
    stepProviderOptions,
    mergeStepProviderOptionsLayers(step, {
      providerRouting: resolution.providerRouting,
      personaProviders: resolution.personaProviders,
    }),
  );
  const resolvedProvider = providerInfo.provider;

  if (resolvedProvider === undefined) {
    return [];
  }

  assertProviderResolvedForCapabilitySensitiveOptions(resolvedProvider, {
    stepName: step.name,
    usesStructuredOutput: false,
  });

  if (step.teamLeader) {
    return resolveInspectToolsForProvider(step.teamLeader.inspectTools, resolvedProvider) ?? [];
  }

  return resolveAllowedToolsForProvider(
    mergedProviderOptions,
    step.outputContracts !== undefined && step.outputContracts.length > 0,
    step.edit,
    resolvedProvider,
  ) ?? [];
}

function buildStepPreviews(
  workflow: WorkflowConfig,
  maxCount: number,
  projectCwd: string,
  resolution: PreviewProviderResolution,
): StepPreview[] {
  if (maxCount <= 0 || workflow.steps.length === 0) return [];
  const stepMap = new Map(workflow.steps.map((step) => [step.name, step]));
  const previews: StepPreview[] = [];
  const visited = new Set<string>();
  let currentName: string | undefined = workflow.initialStep;

  while (currentName && previews.length < maxCount) {
    if (currentName === 'COMPLETE' || currentName === 'ABORT' || visited.has(currentName)) break;
    visited.add(currentName);
    const step = stepMap.get(currentName);
    if (!step) break;
    previews.push(buildStepPreview(workflow, step, projectCwd, resolution));
    currentName = step.rules?.[0]?.next;
  }

  return previews;
}

function buildFirstStepInfo(
  workflow: WorkflowConfig,
  projectCwd: string,
  resolution: PreviewProviderResolution,
): FirstStepInfo | undefined {
  const step = workflow.steps.find((candidate) => candidate.name === workflow.initialStep);
  if (!step) return undefined;
  const previewStep = resolvePreviewStep(step);
  return {
    personaContent: readStepPersona(previewStep, projectCwd),
    personaDisplayName: previewStep.personaDisplayName,
    allowedTools: resolvePreviewAllowedTools(previewStep, resolution),
  };
}

export function getWorkflowDescription(
  identifier: string,
  projectCwd: string,
  previewCount?: number,
  lookupCwd = projectCwd,
): {
  name: string;
  description: string;
  workflowStructure: string;
  stepPreviews: StepPreview[];
  interactiveMode?: InteractiveMode;
  firstStep?: FirstStepInfo;
} {
  const workflow = loadWorkflowByIdentifier(identifier, projectCwd, { lookupCwd });
  if (!workflow) {
    return { name: identifier, description: '', workflowStructure: '', stepPreviews: [] };
  }
  const resolution = resolvePreviewProviderResolution(projectCwd, workflow);
  return {
    name: workflow.name,
    description: workflow.description ?? '',
    workflowStructure: buildWorkflowString(workflow.steps),
    stepPreviews: previewCount && previewCount > 0
      ? buildStepPreviews(workflow, previewCount, projectCwd, resolution)
      : [],
    interactiveMode: workflow.interactiveMode,
    firstStep: buildFirstStepInfo(workflow, projectCwd, resolution),
  };
}
