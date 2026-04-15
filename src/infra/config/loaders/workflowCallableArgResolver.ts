import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { z } from 'zod/v4';
import type {
  WorkflowCallArgValue,
} from '../../../core/models/index.js';
import { WorkflowConfigRawSchema } from '../../../core/models/index.js';
import type { FacetResolutionContext, WorkflowSections } from './resource-resolver.js';
import { isResourcePath, resolveFacetPath, resolveSectionMap } from './resource-resolver.js';
import { isWorkflowParamReference, type WorkflowParamReference } from './workflowCallableParamRef.js';
import { assertNoParamReferences, validateReturnRules } from './workflowCallableRuleValidation.js';

type RawWorkflowConfig = z.output<typeof WorkflowConfigRawSchema>;
type RawWorkflowStep = RawWorkflowConfig['steps'][number];
type WorkflowParamType = NonNullable<NonNullable<RawWorkflowConfig['subworkflow']>['params']>[string]['type'];

export interface WorkflowCallArgResolutionPolicy {
  allowExternalFacetRefs: boolean;
}

interface ExpandCallableWorkflowOptions {
  args?: Record<string, WorkflowCallArgValue>;
  workflowDir: string;
  context?: FacetResolutionContext;
  argPolicy?: WorkflowCallArgResolutionPolicy;
}

type WorkflowFacetKind = 'knowledge' | 'policy' | 'instruction' | 'report_format';
export { isWorkflowParamReference } from './workflowCallableParamRef.js';

export function isMissingWorkflowCallArgError(error: unknown): boolean {
  return error instanceof Error
    && /^Step ".+" requires workflow_call arg ".+" for .+$/.test(error.message);
}

function createWorkflowSections(raw: RawWorkflowConfig, workflowDir: string): WorkflowSections {
  return {
    resolvedPolicies: resolveSectionMap(raw.policies, workflowDir),
    resolvedKnowledge: resolveSectionMap(raw.knowledge, workflowDir),
    resolvedInstructions: resolveSectionMap(raw.instructions, workflowDir),
    resolvedReportFormats: resolveSectionMap(raw.report_formats, workflowDir),
  };
}

function getFacetResolver(kind: WorkflowFacetKind): {
  resolvedMapKey: keyof WorkflowSections;
  facetType: 'policies' | 'knowledge' | 'instructions' | 'output-contracts';
} {
  switch (kind) {
    case 'policy':
      return { resolvedMapKey: 'resolvedPolicies', facetType: 'policies' };
    case 'knowledge':
      return { resolvedMapKey: 'resolvedKnowledge', facetType: 'knowledge' };
    case 'instruction':
      return { resolvedMapKey: 'resolvedInstructions', facetType: 'instructions' };
    case 'report_format':
      return { resolvedMapKey: 'resolvedReportFormats', facetType: 'output-contracts' };
  }
}

function validateFacetReferenceExists(
  paramName: string,
  ref: string,
  kind: WorkflowFacetKind,
  workflowDir: string,
  sections: WorkflowSections,
  context?: FacetResolutionContext,
  argPolicy?: WorkflowCallArgResolutionPolicy,
): void {
  const resolver = getFacetResolver(kind);
  const resolvedMap = sections[resolver.resolvedMapKey] as Record<string, string> | undefined;
  if (resolvedMap?.[ref]) {
    return;
  }

  if (argPolicy?.allowExternalFacetRefs === false) {
    throw new Error(
      `workflow_call arg "${paramName}" must reference child-local ${kind} facet "${ref}" across trust boundary`,
    );
  }

  if (isResourcePath(ref)) {
    const resolvedPath = resolve(workflowDir, ref);
    if (existsSync(resolvedPath)) {
      return;
    }
  } else if (context && resolveFacetPath(ref, resolver.facetType, context)) {
    return;
  }

  throw new Error(`workflow_call arg "${paramName}" references unknown ${kind} facet "${ref}"`);
}

function validateWorkflowCallArgValue(
  paramName: string,
  definition: NonNullable<NonNullable<RawWorkflowConfig['subworkflow']>['params']>[string],
  value: WorkflowCallArgValue,
  workflowDir: string,
  sections: WorkflowSections,
  context?: FacetResolutionContext,
  argPolicy?: WorkflowCallArgResolutionPolicy,
): void {
  const isArrayValue = Array.isArray(value);
  if (definition.type === 'facet_ref' && isArrayValue) {
    throw new Error(`workflow_call arg "${paramName}" must be a scalar facet_ref`);
  }
  if (definition.type === 'facet_ref[]' && !isArrayValue) {
    throw new Error(`workflow_call arg "${paramName}" must be a facet_ref[] array`);
  }

  const refs = isArrayValue ? value : [value];
  for (const ref of refs) {
    validateFacetReferenceExists(paramName, ref, definition.facet_kind, workflowDir, sections, context, argPolicy);
  }
}

function resolveCallableArgs(
  raw: RawWorkflowConfig,
  workflowDir: string,
  context: FacetResolutionContext | undefined,
  args: Record<string, WorkflowCallArgValue> | undefined,
  argPolicy: WorkflowCallArgResolutionPolicy | undefined,
): Record<string, WorkflowCallArgValue> {
  const params = raw.subworkflow?.params ?? {};
  const sections = createWorkflowSections(raw, workflowDir);
  const resolvedArgs = new Map<string, WorkflowCallArgValue>();

  for (const [name, value] of Object.entries(args ?? {})) {
    const definition = params[name];
    if (!definition) {
      throw new Error(`workflow_call arg "${name}" is not declared by child workflow "${raw.name}"`);
    }
    validateWorkflowCallArgValue(name, definition, value, workflowDir, sections, context, argPolicy);
    resolvedArgs.set(name, value);
  }

  for (const [name, definition] of Object.entries(params)) {
    if (resolvedArgs.has(name) || definition.default === undefined) {
      continue;
    }
    validateWorkflowCallArgValue(name, definition, definition.default, workflowDir, sections, context);
    resolvedArgs.set(name, definition.default);
  }

  return Object.fromEntries(resolvedArgs);
}

function resolveExpandedParamValue(
  stepName: string,
  fieldName: string,
  paramRef: WorkflowParamReference,
  expectedTypes: readonly WorkflowParamType[],
  expectedKind: WorkflowFacetKind,
  params: NonNullable<RawWorkflowConfig['subworkflow']>['params'] | undefined,
  resolvedArgs: Record<string, WorkflowCallArgValue>,
): WorkflowCallArgValue {
  const definition = params?.[paramRef.$param];
  if (!definition) {
    throw new Error(`Step "${stepName}" references undeclared param "${paramRef.$param}" in ${fieldName}`);
  }
  if (!expectedTypes.includes(definition.type)) {
    const expectedTypeLabel = expectedTypes.join(' or ');
    throw new Error(`Step "${stepName}" expects ${fieldName} to use ${expectedTypeLabel} param "${paramRef.$param}"`);
  }
  if (definition.facet_kind !== expectedKind) {
    throw new Error(`Step "${stepName}" expects ${fieldName} to use ${expectedKind} param "${paramRef.$param}"`);
  }
  const value = resolvedArgs[paramRef.$param];
  if (value === undefined) {
    throw new Error(`Step "${stepName}" requires workflow_call arg "${paramRef.$param}" for ${fieldName}`);
  }
  return value;
}

function expandStepFields(
  step: RawWorkflowStep,
  params: NonNullable<RawWorkflowConfig['subworkflow']>['params'] | undefined,
  resolvedArgs: Record<string, WorkflowCallArgValue>,
): RawWorkflowStep {
  const expandedStep: RawWorkflowStep = structuredClone(step);

  if (isWorkflowParamReference(step.policy)) {
    expandedStep.policy = resolveExpandedParamValue(
      step.name,
      'policy',
      step.policy,
      ['facet_ref', 'facet_ref[]'],
      'policy',
      params,
      resolvedArgs,
    ) as RawWorkflowStep['policy'];
  }

  if (isWorkflowParamReference(step.knowledge)) {
    expandedStep.knowledge = resolveExpandedParamValue(
      step.name,
      'knowledge',
      step.knowledge,
      ['facet_ref', 'facet_ref[]'],
      'knowledge',
      params,
      resolvedArgs,
    ) as RawWorkflowStep['knowledge'];
  }

  if (isWorkflowParamReference(step.instruction)) {
    expandedStep.instruction = resolveExpandedParamValue(
      step.name,
      'instruction',
      step.instruction,
      ['facet_ref'],
      'instruction',
      params,
      resolvedArgs,
    ) as RawWorkflowStep['instruction'];
  }

  if (expandedStep.output_contracts?.report) {
    expandedStep.output_contracts.report = expandedStep.output_contracts.report.map((report) => {
      if (!isWorkflowParamReference(report.format)) {
        return report;
      }
      return {
        ...report,
        format: resolveExpandedParamValue(
          step.name,
          `output_contracts.report.${report.name}.format`,
          report.format,
          ['facet_ref'],
          'report_format',
          params,
          resolvedArgs,
        ) as string,
      };
    });
  }

  if (expandedStep.parallel) {
    expandedStep.parallel = expandedStep.parallel.map((substep) =>
      expandStepFields(substep as RawWorkflowStep, params, resolvedArgs),
    ) as RawWorkflowStep['parallel'];
  }

  return expandedStep;
}

export function expandCallableSubworkflowRaw(
  raw: RawWorkflowConfig,
  options: ExpandCallableWorkflowOptions,
): RawWorkflowConfig {
  const isCallable = raw.subworkflow?.callable === true;
  const declaredReturns = new Set(raw.subworkflow?.returns ?? []);
  validateReturnRules(raw.steps, isCallable, declaredReturns);

  if (!isCallable) {
    assertNoParamReferences(raw.steps);
    return raw;
  }

  const params = raw.subworkflow?.params;
  const resolvedArgs = resolveCallableArgs(
    raw,
    options.workflowDir,
    options.context,
    options.args,
    options.argPolicy,
  );
  const expanded: RawWorkflowConfig = structuredClone(raw);
  expanded.steps = expanded.steps.map((step) => expandStepFields(step, params, resolvedArgs));
  return WorkflowConfigRawSchema.parse(expanded);
}
