import type {
  ProviderRoutingEntry,
  WorkflowConfig,
  WorkflowStep,
} from '../../core/models/index.js';
import { isNormalAgentWorkflowStep } from '../../core/models/types.js';
import type { CompiledProviderEnvironment } from './runtime-provider/environment.js';
import { collectWorkflowCallSteps } from './loaders/workflowParallelTraversal.js';
import { resolveWorkflowCallTarget } from './loaders/workflowCallResolver.js';
import { getWorkflowReference } from '../../core/workflow/workflow-reference.js';
import { MAX_WORKFLOW_CALL_DEPTH } from '../../core/workflow/workflow-call-depth.js';
import type { WorkflowCallResolver } from '../../core/workflow/types.js';
import {
  providerSupportsStrictInternalAgentIsolation,
  providerSupportsStructuredOutput,
} from '../providers/provider-capabilities.js';

function collectLocalCompanionNames(workflow: WorkflowConfig): string[] {
  const names = new Set<string>();
  for (const step of collectReachableSteps(workflow)) {
    if (!isNormalAgentWorkflowStep(step) || step.companion === undefined) continue;
    for (const name of step.companion.fixed) names.add(name);
    for (const name of step.companion.pool) names.add(name);
    if (step.companion.moderator !== undefined) names.add(step.companion.moderator);
  }
  return [...names];
}

function collectReachableSteps(workflow: WorkflowConfig): WorkflowStep[] {
  const stepsByName = new Map(workflow.steps.map((step) => [step.name, step]));
  const visited = new Set<string>();
  const pending = [workflow.initialStep];
  const reachable: WorkflowStep[] = [];
  while (pending.length > 0) {
    const name = pending.shift();
    if (name === undefined || visited.has(name)) continue;
    visited.add(name);
    const step = stepsByName.get(name);
    if (step === undefined) continue;
    reachable.push(step);
    for (const next of step.rules?.map((rule) => rule.next) ?? []) {
      if (next !== undefined && stepsByName.has(next) && !visited.has(next)) pending.push(next);
    }
    for (const monitor of workflow.loopMonitors ?? []) {
      if (!monitor.cycle.includes(name)) continue;
      for (const rule of monitor.judge.rules) {
        if (stepsByName.has(rule.next) && !visited.has(rule.next)) pending.push(rule.next);
      }
    }
  }
  return reachable;
}

function collectReachableWorkflowCallSteps(workflow: WorkflowConfig) {
  return collectWorkflowCallSteps(collectReachableSteps(workflow));
}

function collectCompanionNames(
  workflow: WorkflowConfig,
  options: {
    projectCwd: string;
    lookupCwd: string;
    workflowCallResolver?: WorkflowCallResolver;
  } | undefined,
  activeReferences: ReadonlySet<string>,
  depth: number,
): string[] {
  const names = new Set(collectLocalCompanionNames(workflow));
  if (options === undefined) return [...names];
  for (const step of collectReachableWorkflowCallSteps(workflow)) {
    if (depth + 1 > MAX_WORKFLOW_CALL_DEPTH) {
      throw new Error(`Companion resolution exceeded workflow-call depth ${MAX_WORKFLOW_CALL_DEPTH}`);
    }
    const child = options.workflowCallResolver === undefined
      ? resolveWorkflowCallTarget(workflow, step, options.projectCwd, options.lookupCwd)
      : options.workflowCallResolver({
          parentWorkflow: workflow,
          step,
          projectCwd: options.projectCwd,
          lookupCwd: options.lookupCwd,
        });
    if (child === null) continue;
    const reference = getWorkflowReference(child);
    if (activeReferences.has(reference)) continue;
    for (const name of collectCompanionNames(
      child,
      options,
      new Set([...activeReferences, reference]),
      depth + 1,
    )) names.add(name);
  }
  return [...names];
}

function defaultResolution(environment: CompiledProviderEnvironment): ProviderRoutingEntry | undefined {
  if (environment.provider === undefined && environment.model === undefined) return undefined;
  return {
    ...(environment.provider === undefined ? {} : { provider: environment.provider }),
    ...(environment.model === undefined ? {} : { model: environment.model }),
    ...(environment.providerOptions === undefined ? {} : { providerOptions: environment.providerOptions }),
    ...(environment.escalation === undefined ? {} : { escalation: environment.escalation }),
  };
}

export function resolveWorkflowCompanions(
  workflow: WorkflowConfig,
  environment: CompiledProviderEnvironment,
  options?: {
    projectCwd: string;
    lookupCwd: string;
    workflowCallResolver?: WorkflowCallResolver;
  },
): Map<string, ProviderRoutingEntry> {
  const names = collectCompanionNames(
    workflow,
    options,
    new Set([getWorkflowReference(workflow)]),
    0,
  );
  if (names.length === 0) return new Map();
  if (environment.providerSource !== 'runtime-v1') {
    throw new Error('Companion reviewers require runtime.yaml; migrate provider configuration from config.yaml');
  }
  const defaults = defaultResolution(environment);
  const resolved = new Map<string, ProviderRoutingEntry>();
  for (const name of names) {
    const entry = environment.companions?.[name] ?? defaults;
    if (!entry?.provider) {
      throw new Error(`Companion "${name}" has no runtime.yaml provider target or defaults assignment`);
    }
    if (providerSupportsStrictInternalAgentIsolation(entry.provider) !== true) {
      throw new Error(`Provider "${entry.provider}" does not support companion strict isolated execution`);
    }
    if (providerSupportsStructuredOutput(entry.provider) !== true) {
      throw new Error(`Provider "${entry.provider}" does not support companion structured output`);
    }
    resolved.set(name, { ...entry });
  }
  return resolved;
}
