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
  const rawPath = toRawStepFieldPath(path);
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
  _path: readonly PropertyKey[],
): boolean {
  const providerValidationSource = getProviderValidationErrorSource(error);
  if (!providerValidationSource) {
    return true;
  }
  const { source } = providerValidationSource;
  if (source === 'step' || source === 'promotion') {
    return true;
  }
  return false;
}

function toRawStepFieldPath(path: readonly PropertyKey[]): readonly PropertyKey[] {
  return path;
}
