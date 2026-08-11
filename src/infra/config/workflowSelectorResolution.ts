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
import { collectWorkflowCallSteps } from './loaders/workflowParallelTraversal.js';
import {
  assertProviderSupportsSelectorExecution,
  resolveStrictInternalAgentNativeTools,
} from '../providers/provider-capabilities.js';
import {
  resolveSelectorProviderForProject,
  type ResolvedSelectorProvider,
  type SelectorProviderOverrides,
} from './selectorProviderResolution.js';

type ResolvedActiveSelectorProvider = ResolvedSelectorProvider & {
  readonly provider: ProviderType;
  readonly model: string | undefined;
  readonly providerOptions: StepProviderOptions;
  readonly nativeTools: readonly string[];
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
  if (hasDynamicFacets(workflow) || hasCompanionPool(workflow)) {
    return true;
  }

  for (const step of collectWorkflowCallSteps(workflow.steps)) {
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

  for (const step of collectWorkflowCallSteps(workflow.steps)) {
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

function resolveEffectiveSelectorProviderOptions(
  provider: ProviderType,
  providerOptions: StepProviderOptions | undefined,
): StepProviderOptions {
  const resolved = providerOptions ?? {};
  if (provider !== 'claude' && provider !== 'claude-sdk' && provider !== 'claude-terminal') {
    return resolved;
  }
  if ((resolved.claude?.allowedTools?.length ?? 0) > 0) {
    throw new Error(
      'Configuration error: takt_providers.selector.provider_options.claude.allowed_tools '
      + 'must be empty for the strict read-only selector',
    );
  }
  if (resolved.claude?.skills?.enabled === true) {
    throw new Error(
      'Configuration error: takt_providers.selector.provider_options.claude.skills.enabled '
      + 'cannot be true for the strict read-only selector',
    );
  }
  return resolved;
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

  const selectorProvider = resolveSelectorProviderForProject(
    options.projectCwd,
    options.overrides,
  );
  if (selectorProvider.provider === undefined) {
    throw new Error('Dynamic selector has no resolved provider');
  }
  assertProviderSupportsSelectorExecution(selectorProvider.provider);
  const providerOptions = resolveEffectiveSelectorProviderOptions(
    selectorProvider.provider,
    selectorProvider.providerOptions,
  );
  return {
    applies: true,
    selectorProvider: {
      ...selectorProvider,
      provider: selectorProvider.provider,
      model: selectorProvider.model,
      providerOptions,
      nativeTools: resolveStrictInternalAgentNativeTools(selectorProvider.provider),
    },
  };
}
