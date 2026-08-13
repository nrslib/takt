import {
  getAllParallelSubSteps,
  isNormalAgentWorkflowStep,
  isDynamicParallelSubSteps,
  type WorkflowConfig,
  type WorkflowStep,
} from '../../core/models/types.js';
import { MAX_WORKFLOW_CALL_DEPTH } from '../../core/workflow/workflow-call-depth.js';
import { getWorkflowReference } from '../../core/workflow/workflow-reference.js';
import type { ProviderType } from '../../shared/types/provider.js';
import type { StepProviderOptions } from '../../core/models/workflow-types.js';
import type { WorkflowCallResolver } from '../../core/workflow/types.js';
import { resolveWorkflowCallTarget } from './loaders/workflowCallResolver.js';
import { collectReachableWorkflowCallSteps } from './loaders/workflowParallelTraversal.js';
import {
  resolveSelectorProviderFromLegacyProject,
  resolveSelectorProviderFromRuntimeEnvironment,
  type ResolvedSelectorProvider,
  type SelectorProviderOverrides,
} from './selectorProviderResolution.js';
import type { CompiledProviderEnvironment } from './runtime-provider/environment.js';
import type { ProviderConfigMode } from './runtime-provider/mode.js';

type ResolvedActiveSelectorProvider = ResolvedSelectorProvider & {
  readonly provider: ProviderType;
  readonly model: string | undefined;
  readonly providerOptions?: StepProviderOptions;
};

export type WorkflowSelectorResolution =
  | { readonly applies: false }
  | {
    readonly applies: true;
    readonly selectorProvider: ResolvedActiveSelectorProvider;
  };

export interface WorkflowSelectorResolutionOptions {
  readonly projectCwd: string;
  readonly lookupCwd: string;
  readonly overrides?: SelectorProviderOverrides;
  readonly workflowCallResolver?: WorkflowCallResolver;
  readonly companionEnabled?: boolean;
  readonly providerEnvironment: CompiledProviderEnvironment;
  readonly providerConfigMode: ProviderConfigMode;
}

function hasDynamicParallel(workflow: WorkflowConfig): boolean {
  return workflow.steps.some((step) =>
    step.parallel !== undefined
    && isDynamicParallelSubSteps(step.parallel)
    && getAllParallelSubSteps(step.parallel).length > 0);
}

function hasDynamicFacets(workflow: WorkflowConfig): boolean {
  return workflow.steps.some(hasDynamicFacetsInStep);
}

function hasDynamicFacetsInStep(step: WorkflowStep): boolean {
  if (isNormalAgentWorkflowStep(step) && step.dynamicFacets !== undefined) {
    return true;
  }
  return step.parallel !== undefined
    && getAllParallelSubSteps(step.parallel).some(hasDynamicFacetsInStep);
}

function hasCompanionPool(workflow: WorkflowConfig): boolean {
  return workflow.steps.some((step) => (
    isNormalAgentWorkflowStep(step) && (step.companion?.pool.length ?? 0) > 0
  ));
}

function workflowGraphHasDynamicFacets(
  workflow: WorkflowConfig,
  options: WorkflowSelectorResolutionOptions,
  activeReferences: ReadonlySet<string>,
  depth: number,
): boolean {
  if (hasDynamicFacets(workflow) || (options.companionEnabled !== false && hasCompanionPool(workflow))) {
    return true;
  }

  for (const step of collectReachableWorkflowCallSteps(workflow)) {
    const childDepth = depth + 1;
    if (childDepth > MAX_WORKFLOW_CALL_DEPTH) {
      throw new Error(
        `Workflow selector resolution exceeded workflow-call depth ${MAX_WORKFLOW_CALL_DEPTH}`,
      );
    }
    const child = options.workflowCallResolver === undefined
      ? resolveWorkflowCallTarget(
          workflow,
          step,
          options.projectCwd,
          options.lookupCwd,
        )
      : options.workflowCallResolver({
          parentWorkflow: workflow,
          step,
          projectCwd: options.projectCwd,
          lookupCwd: options.lookupCwd,
        });
    if (child === null) {
      continue;
    }
    const childReference = getWorkflowReference(child);
    if (activeReferences.has(childReference)) {
      continue;
    }
    if (workflowGraphHasDynamicFacets(
      child,
      options,
      new Set([...activeReferences, childReference]),
      childDepth,
    )) {
      return true;
    }
  }

  return false;
}

function workflowGraphHasDynamicParallel(
  workflow: WorkflowConfig,
  options: WorkflowSelectorResolutionOptions,
  activeReferences: ReadonlySet<string>,
  depth: number,
): boolean {
  if (hasDynamicParallel(workflow)) {
    return true;
  }

  for (const step of collectReachableWorkflowCallSteps(workflow)) {
    const childDepth = depth + 1;
    if (childDepth > MAX_WORKFLOW_CALL_DEPTH) {
      throw new Error(
        `Workflow selector resolution exceeded workflow-call depth ${MAX_WORKFLOW_CALL_DEPTH}`,
      );
    }
    const child = options.workflowCallResolver === undefined
      ? resolveWorkflowCallTarget(
          workflow,
          step,
          options.projectCwd,
          options.lookupCwd,
        )
      : options.workflowCallResolver({
          parentWorkflow: workflow,
          step,
          projectCwd: options.projectCwd,
          lookupCwd: options.lookupCwd,
        });
    if (child === null) {
      // Workflow validation and execution own unresolved call diagnostics. Selector
      // discovery must not prevent ordinary workflows from reaching those boundaries.
      continue;
    }
    const childReference = getWorkflowReference(child);
    if (activeReferences.has(childReference)) {
      continue;
    }
    if (workflowGraphHasDynamicParallel(
      child,
      options,
      new Set([...activeReferences, childReference]),
      childDepth,
    )) {
      return true;
    }
  }

  return false;
}

export function resolveWorkflowSelector(
  workflow: WorkflowConfig,
  options: WorkflowSelectorResolutionOptions,
): WorkflowSelectorResolution {
  const workflowReference = getWorkflowReference(workflow);
  const applies = workflowGraphHasDynamicParallel(
    workflow,
    options,
    new Set([workflowReference]),
    0,
  ) || workflowGraphHasDynamicFacets(
    workflow,
    options,
    new Set([workflowReference]),
    0,
  );
  if (!applies) {
    return { applies: false };
  }

  const selectorProvider = options.providerConfigMode === 'runtime-v1'
    ? resolveSelectorProviderFromRuntimeEnvironment(options.providerEnvironment, options.overrides)
    : resolveSelectorProviderFromLegacyProject(options.projectCwd, options.overrides);
  if (selectorProvider.provider === undefined) {
    throw new Error('Dynamic selector has no resolved provider');
  }
  return {
    applies: true,
    selectorProvider: {
      ...selectorProvider,
      provider: selectorProvider.provider,
      model: selectorProvider.model,
      providerOptions: selectorProvider.providerOptions,
    },
  };
}
