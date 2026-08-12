import type { InteractiveMode, PermissionMode, WorkflowConfig, WorkflowStep } from '../../../core/models/index.js';
import { getAllParallelSubSteps, isDynamicParallelSubSteps } from '../../../core/models/types.js';
import type { StepProviderOptions } from '../../../core/models/workflow-types.js';
import type { InternalAgentSeats, TagRoutingConflictPolicy } from '../../../core/models/config-types.js';
import {
  resolveStepProviderModel,
  type ProviderModelResolutionContext,
} from '../../../core/workflow/provider-resolution.js';
import type { SelectorProviderInfo, StepProviderInfo, WorkflowCallResolver } from '../../../core/workflow/types.js';
import type { ProviderResolutionSource } from '../../../core/workflow/provider-options-trace.js';
import {
  resolveRuleBasedAutoRoutingProviderInfo,
} from '../../../core/workflow/auto-routing/resolver.js';
import {
  assertProviderResolvedForCapabilitySensitiveOptions,
  resolveAllowedToolsForProvider,
  resolveInspectToolsForProvider,
} from '../../../core/workflow/engine/engine-provider-options.js';
import { createTeamLeaderPlanningStep } from '../../../core/workflow/engine/team-leader-common.js';
import { createLogger, getErrorMessage } from '../../../shared/utils/index.js';
import { resolveProviderOptionsWithTrace } from '../resolveConfigValue.js';
import { resolveAuxiliaryRuntimeEnvironment } from '../runtime-provider/provider-environment.js';
import {
  resolveEffectiveProviderOptions,
  resolveDirectStepProviderOptions,
  mergeProviderOptions,
  mergeStepProviderOptionsLayers,
} from '../providerOptions.js';
import { loadPersonaPromptFromPath } from './agentLoader.js';
import { loadWorkflowByIdentifier } from './workflowResolver.js';
import {
  type SelectorProviderOverrides,
} from '../selectorProviderResolution.js';
import { resolveWorkflowSelector } from '../workflowSelectorResolution.js';

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
  providerSource?: ProviderResolutionSource;
  modelSource?: ProviderResolutionSource;
  permissionMode?: PermissionMode;
  internalAgent?: boolean;
  sessionKey?: string;
  requiresUserInput?: boolean;
  substeps?: StepPreview[];
  parallelRole?: 'fixed' | 'pool';
  dynamicSelectionMode?: 'replace' | 'cumulative';
  dynamicFacets?: {
    readonly pool: string;
    readonly maxSelected?: number;
    readonly candidates: readonly {
      readonly id: string;
      readonly description: string;
      readonly policyRefs: readonly string[];
      readonly knowledgeRefs: readonly string[];
    }[];
    readonly source: 'inline' | 'external';
  };
}

export interface FirstStepInfo {
  personaContent: string;
  personaDisplayName: string;
  allowedTools: string[];
}

interface PreviewProviderResolution extends ProviderModelResolutionContext {
  providerSource: ProviderResolutionSource;
  modelSource: ProviderResolutionSource;
  tagConflictPolicy: TagRoutingConflictPolicy;
  providerOptions: StepProviderOptions | undefined;
  providerOptionsSource: ReturnType<typeof resolveProviderOptionsWithTrace>['source'];
  providerOptionsOriginResolver: ReturnType<typeof resolveProviderOptionsWithTrace>['originResolver'];
  /** runtime.yaml internal_agents の解決済み seat。合成ロールの表示を実行時と一致させる。 */
  internalAgentSeats: InternalAgentSeats | undefined;
  companionEnabled: boolean;
  selectorProvider?: SelectorProviderInfo;
}

function buildWorkflowString(steps: WorkflowStep[]): string {
  const lines: string[] = [];
  let index = 1;
  for (const step of steps) {
    lines.push(`${index}. ${step.name}${step.description ? ` (${step.description})` : ''}`);
    if (step.parallel !== undefined && isDynamicParallelSubSteps(step.parallel)) {
      lines.push(`   selector mode: ${step.parallel.selection.mode}`);
      for (const sub of step.parallel.fixed) {
        lines.push(`   - fixed: ${sub.name}${sub.description ? ` (${sub.description})` : ''}`);
      }
      for (const sub of step.parallel.pool) {
        lines.push(`   - pool candidate: ${sub.name}${sub.description ? ` (${sub.description})` : ''}`);
      }
    } else {
      for (const sub of step.parallel ?? []) {
        lines.push(`   - ${sub.name}${sub.description ? ` (${sub.description})` : ''}`);
      }
    }
    index++;
  }
  return lines.join('\n');
}

function readStepPersona(
  step: WorkflowStep,
  projectCwd: string,
  workflowBundleResourceRoot?: string,
): string {
  if (!step.personaPath) {
    return step.persona ?? '';
  }
  try {
    return loadPersonaPromptFromPath(step.personaPath, projectCwd, workflowBundleResourceRoot);
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
    tagConflictPolicy: resolution.tagConflictPolicy,
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

function buildDynamicSelectorPreview(
  selectorProvider: SelectorProviderInfo,
): StepPreview {
  return {
    name: 'dynamic-selector',
    personaDisplayName: 'TAKT internal selector',
    personaContent: '',
    instructionContent: '',
    allowedTools: resolveAllowedToolsForProvider(
      selectorProvider.providerOptions,
      false,
      undefined,
      selectorProvider.provider,
    ) ?? [],
    canEdit: false,
    internalAgent: true,
    ...(selectorProvider.permissionMode === undefined
      ? {}
      : { permissionMode: selectorProvider.permissionMode }),
    provider: selectorProvider.provider,
    model: selectorProvider.model,
    providerSource: selectorProvider.providerSource,
    modelSource: selectorProvider.modelSource,
  };
}

function getDynamicSelectorProvider(
  resolution: PreviewProviderResolution,
): SelectorProviderInfo {
  if (resolution.selectorProvider === undefined) {
    throw new Error('Dynamic parallel selector has no resolved provider');
  }
  return resolution.selectorProvider;
}

function buildStepPreview(
  workflow: WorkflowConfig,
  step: WorkflowStep,
  projectCwd: string,
  resolution: PreviewProviderResolution,
  workflowBundleResourceRoot?: string,
  context: { parallelRole?: 'fixed' | 'pool' } = {},
): StepPreview {
  const previewStep = resolvePreviewStep(step);
  const parallelSubsteps = previewStep.parallel === undefined
    ? undefined
    : isDynamicParallelSubSteps(previewStep.parallel)
      ? [
          buildDynamicSelectorPreview(getDynamicSelectorProvider(resolution)),
          ...previewStep.parallel.fixed.map((substep) =>
            buildStepPreview(workflow, substep, projectCwd, resolution, workflowBundleResourceRoot, {
              parallelRole: 'fixed',
            })),
          ...previewStep.parallel.pool.map((substep) =>
            buildStepPreview(workflow, substep, projectCwd, resolution, workflowBundleResourceRoot, {
              parallelRole: 'pool',
            })),
        ]
      : getAllParallelSubSteps(previewStep.parallel).map((substep) =>
          buildStepPreview(workflow, substep, projectCwd, resolution, workflowBundleResourceRoot, {
          }),
        );
  const isParallelParent = parallelSubsteps !== undefined && parallelSubsteps.length > 0;
  const providerInfo = isParallelParent ? undefined : resolvePreviewProviderInfo(previewStep, resolution);

  return {
    name: step.name,
    personaDisplayName: previewStep.personaDisplayName,
    personaContent: isParallelParent ? '' : readStepPersona(previewStep, projectCwd, workflowBundleResourceRoot),
    instructionContent: isParallelParent ? '' : previewStep.instruction,
    allowedTools: isParallelParent ? [] : resolvePreviewAllowedTools(previewStep, resolution),
    canEdit: isParallelParent ? false : resolvePreviewCanEdit(previewStep),
    ...(providerInfo?.provider !== undefined ? { provider: providerInfo.provider } : {}),
    ...(providerInfo?.model !== undefined ? { model: providerInfo.model } : {}),
    sessionKey: previewStep.sessionKey,
    requiresUserInput: previewStep.requiresUserInput,
    ...(context.parallelRole === undefined ? {} : { parallelRole: context.parallelRole }),
    ...(previewStep.parallel !== undefined && isDynamicParallelSubSteps(previewStep.parallel)
      ? { dynamicSelectionMode: previewStep.parallel.selection.mode }
      : {}),
    ...(resolveDynamicFacetsPreview(workflow, previewStep)),
    ...(parallelSubsteps ? { substeps: parallelSubsteps } : {}),
  };
}

function resolveDynamicFacetsPreview(
  workflow: WorkflowConfig,
  step: WorkflowStep,
): { dynamicFacets: NonNullable<StepPreview['dynamicFacets']> } | Record<string, never> {
  const dynamicFacets = (step as { dynamicFacets?: { readonly pool: string; readonly maxSelected?: number } }).dynamicFacets;
  if (dynamicFacets === undefined) return {};
  const pool = workflow.facetPools?.[dynamicFacets.pool];
  if (pool === undefined) return {};
  return {
    dynamicFacets: {
      pool: dynamicFacets.pool,
      maxSelected: dynamicFacets.maxSelected,
      candidates: pool.candidates.map((candidate) => ({
        id: candidate.id,
        description: candidate.description,
        policyRefs: [...candidate.policyRefs],
        knowledgeRefs: [...candidate.knowledgeRefs],
      })),
      source: pool.source,
    },
  };
}

function resolvePreviewProviderResolution(
  projectCwd: string,
  lookupCwd: string,
  workflow: WorkflowConfig,
  selectorOverrides?: SelectorProviderOverrides,
  workflowCallResolver?: WorkflowCallResolver,
): PreviewProviderResolution {
  // Resolve provider/model/personaProviders/providerRouting/autoRouting/providerOptions through the
  // same compiled bundle as execution, so a runtime-v1 environment previews the runtime.yaml
  // `profiles.default` resolution (and a mixed configuration fails fast here too). providerOptions
  // source/originResolver stay on the trace resolver, matching how the executor traces them.
  const runtimeEnvironment = resolveAuxiliaryRuntimeEnvironment(projectCwd, workflow);
  const env = runtimeEnvironment.providerEnvironment;
  const {
    source: providerOptionsSource,
    originResolver: providerOptionsOriginResolver,
  } = resolveProviderOptionsWithTrace(projectCwd);
  const selectorResolution = resolveWorkflowSelector(workflow, {
    projectCwd,
    lookupCwd,
    overrides: selectorOverrides,
    companionEnabled: runtimeEnvironment.companionEnabled,
    providerEnvironment: env,
    providerConfigMode: runtimeEnvironment.providerConfigMode,
    workflowCallResolver,
  });

  return {
    provider: env.provider,
    providerSource: env.providerSource,
    model: env.model,
    modelSource: env.modelSource,
    autoRouting: env.autoRouting,
    personaProviders: env.personaProviders,
    providerRouting: env.providerRouting,
    tagConflictPolicy: env.tagConflictPolicy,
    providerOptions: env.providerOptions,
    providerOptionsSource,
    providerOptionsOriginResolver,
    internalAgentSeats: env.internalAgents,
    companionEnabled: runtimeEnvironment.companionEnabled,
    ...(selectorResolution.applies
      ? { selectorProvider: selectorResolution.selectorProvider }
      : {}),
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
  workflowBundleResourceRoot?: string,
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
    previews.push(buildStepPreview(workflow, step, projectCwd, resolution, workflowBundleResourceRoot));
    currentName = step.rules?.[0]?.next;
  }

  return previews;
}

function buildFirstStepInfo(
  workflow: WorkflowConfig,
  projectCwd: string,
  resolution: PreviewProviderResolution,
  workflowBundleResourceRoot?: string,
): FirstStepInfo | undefined {
  const step = workflow.steps.find((candidate) => candidate.name === workflow.initialStep);
  if (!step) return undefined;
  const previewStep = resolvePreviewStep(step);
  return {
    personaContent: readStepPersona(previewStep, projectCwd, workflowBundleResourceRoot),
    personaDisplayName: previewStep.personaDisplayName,
    allowedTools: resolvePreviewAllowedTools(previewStep, resolution),
  };
}

export function getWorkflowDescription(
  identifier: string,
  projectCwd: string,
  previewCount?: number,
  lookupCwd = projectCwd,
  selectorOverrides?: SelectorProviderOverrides,
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
  return getWorkflowDescriptionFromConfig(
    workflow,
    projectCwd,
    previewCount,
    lookupCwd,
    selectorOverrides,
  );
}

export function getWorkflowDescriptionFromConfig(
  workflow: WorkflowConfig,
  projectCwd: string,
  previewCount?: number,
  lookupCwd = projectCwd,
  selectorOverrides?: SelectorProviderOverrides,
  workflowCallResolver?: WorkflowCallResolver,
  workflowBundleResourceRoot?: string,
): {
  name: string;
  description: string;
  workflowStructure: string;
  stepPreviews: StepPreview[];
  interactiveMode?: InteractiveMode;
  firstStep?: FirstStepInfo;
} {
  const resolution = resolvePreviewProviderResolution(
    projectCwd,
    lookupCwd,
    workflow,
    selectorOverrides,
    workflowCallResolver,
  );
  return {
    name: workflow.name,
    description: workflow.description ?? '',
    workflowStructure: buildWorkflowString(workflow.steps),
    stepPreviews: previewCount && previewCount > 0
      ? buildStepPreviews(workflow, previewCount, projectCwd, resolution, workflowBundleResourceRoot)
      : [],
    interactiveMode: workflow.interactiveMode,
    firstStep: buildFirstStepInfo(workflow, projectCwd, resolution, workflowBundleResourceRoot),
  };
}
