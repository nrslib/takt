import { getWorkflowConfigErrorPath } from '../../../core/workflow/workflow-config-error.js';
import { getProviderValidationErrorSource } from '../../../core/workflow/provider-validation-error.js';
import type { WorkflowConfig } from '../../../core/models/types.js';
import {
  findFragmentProvenanceAtExactPath,
  findFragmentProvenanceForStep,
  type WorkflowStepFragmentProvenance,
} from './workflowStepFragmentProvenance.js';
import type { WorkflowStepFragmentRulePathMapping } from './workflowStepFragmentResolver.js';
import {
  hasVisitedWorkflowErrorContext,
  markVisitedWorkflowErrorContext,
} from './workflowFragmentErrorVisitTracker.js';

interface FragmentErrorContext {
  readonly provenance: readonly WorkflowStepFragmentProvenance[];
  readonly rulePathMappings: readonly WorkflowStepFragmentRulePathMapping[];
  readonly raw: object;
  readonly workflowPath: string;
}

const contexts = new WeakMap<object, FragmentErrorContext>();

export function registerWorkflowStepFragmentErrorContext(
  workflow: object,
  provenance: readonly WorkflowStepFragmentProvenance[],
  raw: object,
  workflowPath: string,
  rulePathMappings: readonly WorkflowStepFragmentRulePathMapping[] = [],
): void {
  contexts.set(workflow, { provenance, rulePathMappings, raw, workflowPath });
}

export function formatWorkflowStepFragmentErrorContext(
  workflowPath: string,
  source: WorkflowStepFragmentProvenance,
  workflowDefined: boolean,
): string {
  if (workflowDefined) {
    return `in workflow ${workflowPath}; step uses fragment "${source.ref}" resolved at ${source.sourcePath}; invalid field is defined by the workflow`;
  }
  return `in workflow ${workflowPath}; from step fragment "${source.ref}" at ${source.sourcePath}`;
}

export function translateWorkflowStepFragmentError(workflow: WorkflowConfig, error: unknown): Error {
  const context = contexts.get(workflow);
  const normalized = error instanceof Error ? error : new Error(String(error));
  if (!context) {
    return normalized;
  }
  if (hasVisitedWorkflowErrorContext(normalized, 'normalized', context.workflowPath)) {
    return normalized;
  }
  const path = getWorkflowConfigErrorPath(error);
  if (!path) {
    return normalized;
  }
  if (!shouldTranslateWorkflowStepFragmentError(error, path)) {
    return normalized;
  }
  if (context.rulePathMappings.some((mapping) => pathStartsWith(path, mapping.normalizedPath))) {
    return normalized;
  }
  const rawPath = toRawStepFieldPath(path, context.raw);
  const exact = findFragmentProvenanceAtExactPath(context.provenance, rawPath);
  const source = exact ?? findFragmentProvenanceForStep(context.provenance, rawPath);
  if (!source) {
    return normalized;
  }
  const details = formatWorkflowStepFragmentErrorContext(context.workflowPath, source, exact === undefined);
  const translated = new Error(`${normalized.message} (${details})`, { cause: normalized });
  markVisitedWorkflowErrorContext(normalized, translated, 'normalized', context.workflowPath);
  return translated;
}

function pathStartsWith(path: readonly PropertyKey[], prefix: readonly PropertyKey[]): boolean {
  return prefix.length <= path.length
    && prefix.every((entry, index) => entry === path[index]);
}

function shouldTranslateWorkflowStepFragmentError(
  error: unknown,
  path: readonly PropertyKey[],
): boolean {
  const providerValidationSource = getProviderValidationErrorSource(error);
  if (!providerValidationSource) {
    return true;
  }
  const { source } = providerValidationSource;
  if (source === 'step' || source === 'promotion') {
    return true;
  }
  return source === 'workflow_call' && path[workflowStepFieldStart(path)] === 'overrides';
}

function toRawStepFieldPath(path: readonly PropertyKey[], raw: object): readonly PropertyKey[] {
  const step = getRawStepAtPath(raw, path);
  if (!step) {
    return path;
  }
  const stepPathLength = workflowStepFieldStart(path);
  const fieldPath = path.slice(stepPathLength);
  if (fieldPath[0] === 'model' && hasProviderModel(step.provider)) {
    return [...path.slice(0, stepPathLength), 'provider', 'model'];
  }
  if (
    fieldPath[0] === 'overrides'
    && fieldPath[1] === 'model'
    && isRecord(step.overrides)
    && hasProviderModel(step.overrides.provider)
  ) {
    return [...path.slice(0, stepPathLength), 'overrides', 'provider', 'model'];
  }
  if (fieldPath[0] === 'promotion' && typeof fieldPath[1] === 'number' && fieldPath[2] === 'model') {
    const promotion = Array.isArray(step.promotion) ? step.promotion[fieldPath[1]] : undefined;
    if (isRecord(promotion) && hasProviderModel(promotion.provider)) {
      return [...path.slice(0, stepPathLength), 'promotion', fieldPath[1], 'provider', 'model'];
    }
  }
  return path;
}

function workflowStepFieldStart(path: readonly PropertyKey[]): number {
  return path[2] === 'parallel' && (path[3] === 'fixed' || path[3] === 'pool') ? 5
    : path[2] === 'parallel' ? 4 : 2;
}

function getRawStepAtPath(raw: object, path: readonly PropertyKey[]): Record<string, unknown> | undefined {
  if (path[0] !== 'steps' || typeof path[1] !== 'number' || !isRecord(raw) || !Array.isArray(raw.steps)) {
    return undefined;
  }
  const parent = raw.steps[path[1]];
  if (!isRecord(parent)) {
    return undefined;
  }
  if (path[2] !== 'parallel') {
    return parent;
  }
  if (typeof path[3] === 'number' && Array.isArray(parent.parallel) && isRecord(parent.parallel[path[3]])) {
    return parent.parallel[path[3]];
  }
  if ((path[3] === 'fixed' || path[3] === 'pool') && isRecord(parent.parallel)) {
    const branch = parent.parallel[path[3]];
    if (Array.isArray(branch) && typeof path[4] === 'number' && isRecord(branch[path[4]])) {
      return branch[path[4]];
    }
  }
  return undefined;
}

function hasProviderModel(value: unknown): boolean {
  return isRecord(value) && value.model !== undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
