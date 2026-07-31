import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { z } from 'zod/v4';
import type {
  WorkflowCallArgValue,
} from '../../../core/models/index.js';
import { WorkflowConfigRawSchema } from '../../../core/models/index.js';
import type { FacetResolutionContext, WorkflowSections } from './resource-resolver.js';
import {
  isResourcePath,
  resolveFacetPath,
  resolvePersona,
  resolveSectionMapWithSource,
  unwrapResolvedSectionMap,
} from './resource-resolver.js';
import { isWorkflowParamReference, type WorkflowParamReference } from './workflowCallableParamRef.js';
import { assertNoParamReferences, validateReturnRules } from './workflowCallableRuleValidation.js';
import { withWorkflowConfigErrorPath as withWorkflowStepErrorPath } from '../../../core/workflow/workflow-config-error.js';

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

type WorkflowFacetKind = 'knowledge' | 'policy' | 'instruction' | 'persona' | 'report_format';
export { isWorkflowParamReference } from './workflowCallableParamRef.js';

export function isMissingWorkflowCallArgError(error: unknown): boolean {
  return error instanceof Error
    && /^Step ".+" requires workflow_call arg ".+" for .+$/.test(error.message);
}

function createWorkflowSections(
  raw: RawWorkflowConfig,
  workflowDir: string,
  context: FacetResolutionContext | undefined,
): WorkflowSections {
  const resolvedPoliciesWithSource = resolveSectionMapWithSource(raw.policies, workflowDir, 'policies', context);
  const resolvedKnowledgeWithSource = resolveSectionMapWithSource(raw.knowledge, workflowDir, 'knowledge', context);
  const resolvedInstructionsWithSource = resolveSectionMapWithSource(
    raw.instructions,
    workflowDir,
    'instructions',
    context,
  );
  const resolvedReportFormatsWithSource = resolveSectionMapWithSource(
    raw.report_formats,
    workflowDir,
    'output-contracts',
    context,
  );
  return {
    personas: raw.personas,
    resolvedPolicies: unwrapResolvedSectionMap(resolvedPoliciesWithSource),
    resolvedPoliciesWithSource,
    resolvedKnowledge: unwrapResolvedSectionMap(resolvedKnowledgeWithSource),
    resolvedKnowledgeWithSource,
    resolvedInstructions: unwrapResolvedSectionMap(resolvedInstructionsWithSource),
    resolvedInstructionsWithSource,
    resolvedReportFormats: unwrapResolvedSectionMap(resolvedReportFormatsWithSource),
    resolvedReportFormatsWithSource,
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
    case 'persona':
      throw new Error('persona references use the persona resolver');
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
  if (kind === 'persona') {
    if (sections.personas?.[ref] !== undefined) {
      return;
    }
    if (argPolicy?.allowExternalFacetRefs === false) {
      throw new Error(
        `workflow_call arg "${paramName}" must reference child-local persona facet "${ref}" across trust boundary`,
      );
    }
    if (resolvePersona(ref, sections, workflowDir, context).personaPath !== undefined) {
      return;
    }
    throw new Error(`workflow_call arg "${paramName}" references unknown persona facet "${ref}"`);
  }
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
  if (definition.type === 'workflow_ref') {
    if (isArrayValue) {
      throw new Error(`workflow_call arg "${paramName}" must be a scalar workflow_ref`);
    }
    return;
  }
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
  const sections = createWorkflowSections(raw, workflowDir, context);
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
  errorPath: readonly PropertyKey[],
): WorkflowCallArgValue {
  const definition = params?.[paramRef.$param];
  if (!definition) {
    throw withWorkflowStepErrorPath(new Error(`Step "${stepName}" references undeclared param "${paramRef.$param}" in ${fieldName}`), errorPath);
  }
  if (definition.type === 'workflow_ref' || !expectedTypes.includes(definition.type)) {
    const expectedTypeLabel = expectedTypes.join(' or ');
    throw withWorkflowStepErrorPath(new Error(`Step "${stepName}" expects ${fieldName} to use ${expectedTypeLabel} param "${paramRef.$param}"`), errorPath);
  }
  if (definition.facet_kind !== expectedKind) {
    throw withWorkflowStepErrorPath(new Error(`Step "${stepName}" expects ${fieldName} to use ${expectedKind} param "${paramRef.$param}"`), errorPath);
  }
  const value = resolvedArgs[paramRef.$param];
  if (value === undefined) {
    throw withWorkflowStepErrorPath(new Error(`Step "${stepName}" requires workflow_call arg "${paramRef.$param}" for ${fieldName}`), errorPath);
  }
  return value;
}

function resolveExpandedWorkflowCallArgValue(
  stepName: string,
  argName: string,
  paramRef: WorkflowParamReference,
  params: NonNullable<RawWorkflowConfig['subworkflow']>['params'] | undefined,
  resolvedArgs: Record<string, WorkflowCallArgValue>,
  errorPath: readonly PropertyKey[],
): WorkflowCallArgValue {
  const definition = params?.[paramRef.$param];
  if (!definition) {
    throw withWorkflowStepErrorPath(new Error(`Step "${stepName}" references undeclared param "${paramRef.$param}" in args.${argName}`), errorPath);
  }
  const value = resolvedArgs[paramRef.$param];
  if (value === undefined) {
    throw withWorkflowStepErrorPath(new Error(`Step "${stepName}" requires workflow_call arg "${paramRef.$param}" for args.${argName}`), errorPath);
  }
  return value;
}

function expandFacetListField(
  stepName: string,
  fieldName: 'policy' | 'knowledge',
  value: RawWorkflowStep['policy'] | RawWorkflowStep['knowledge'],
  expectedKind: 'policy' | 'knowledge',
  params: NonNullable<RawWorkflowConfig['subworkflow']>['params'] | undefined,
  resolvedArgs: Record<string, WorkflowCallArgValue>,
  fieldPath: readonly PropertyKey[],
): RawWorkflowStep['policy'] | RawWorkflowStep['knowledge'] {
  if (isWorkflowParamReference(value)) {
    return resolveExpandedParamValue(
      stepName,
      fieldName,
      value,
      ['facet_ref', 'facet_ref[]'],
      expectedKind,
      params,
      resolvedArgs,
      fieldPath,
    ) as RawWorkflowStep['policy'];
  }
  if (!Array.isArray(value)) {
    return value;
  }

  return value.flatMap((entry, index) => {
    if (!isWorkflowParamReference(entry)) {
      return [entry];
    }
    const expanded = resolveExpandedParamValue(
      stepName,
      fieldName,
      entry,
      ['facet_ref', 'facet_ref[]'],
      expectedKind,
      params,
      resolvedArgs,
      [...fieldPath, index],
    );
    return Array.isArray(expanded) ? expanded : [expanded];
  });
}

function expandWorkflowCallReference(
  step: RawWorkflowStep,
  params: NonNullable<RawWorkflowConfig['subworkflow']>['params'] | undefined,
  resolvedArgs: Record<string, WorkflowCallArgValue>,
  stepPath: readonly PropertyKey[],
): RawWorkflowStep['call'] {
  if (!isWorkflowParamReference(step.call)) {
    return step.call;
  }
  const definition = params?.[step.call.$param];
  const errorPath = [...stepPath, 'call'];
  if (!definition) {
    throw withWorkflowStepErrorPath(new Error(`Step "${step.name}" references undeclared param "${step.call.$param}" in call`), errorPath);
  }
  if (definition.type !== 'workflow_ref') {
    throw withWorkflowStepErrorPath(new Error(`Step "${step.name}" expects call to use workflow_ref param "${step.call.$param}"`), errorPath);
  }
  const value = resolvedArgs[step.call.$param];
  if (value === undefined) {
    throw withWorkflowStepErrorPath(new Error(`Step "${step.name}" requires workflow_call arg "${step.call.$param}" for call`), errorPath);
  }
  if (Array.isArray(value)) {
    throw withWorkflowStepErrorPath(new Error(`Step "${step.name}" expects call param "${step.call.$param}" to resolve to a scalar workflow_ref`), errorPath);
  }
  return value;
}

function expandWorkflowCallArgs(
  step: RawWorkflowStep,
  params: NonNullable<RawWorkflowConfig['subworkflow']>['params'] | undefined,
  resolvedArgs: Record<string, WorkflowCallArgValue>,
  stepPath: readonly PropertyKey[],
): RawWorkflowStep['args'] {
  if (!step.args) {
    return undefined;
  }

  const expandedArgs: Record<string, WorkflowCallArgValue> = {};
  for (const [argName, value] of Object.entries(step.args)) {
    expandedArgs[argName] = isWorkflowParamReference(value)
      ? resolveExpandedWorkflowCallArgValue(step.name, argName, value, params, resolvedArgs, [...stepPath, 'args', argName])
      : value;
  }
  return expandedArgs;
}

function expandStepFields(
  step: RawWorkflowStep,
  params: NonNullable<RawWorkflowConfig['subworkflow']>['params'] | undefined,
  resolvedArgs: Record<string, WorkflowCallArgValue>,
  stepPath: readonly PropertyKey[],
): RawWorkflowStep {
  const expandedStep: RawWorkflowStep = structuredClone(step);

  expandedStep.call = expandWorkflowCallReference(step, params, resolvedArgs, stepPath);

  if (isWorkflowParamReference(step.persona)) {
    expandedStep.persona = resolveExpandedParamValue(
      step.name,
      'persona',
      step.persona,
      ['facet_ref'],
      'persona',
      params,
      resolvedArgs,
      [...stepPath, 'persona'],
    ) as RawWorkflowStep['persona'];
  }

  expandedStep.policy = expandFacetListField(
    step.name,
    'policy',
    step.policy,
    'policy',
    params,
    resolvedArgs,
    [...stepPath, 'policy'],
  );

  expandedStep.knowledge = expandFacetListField(
    step.name,
    'knowledge',
    step.knowledge,
    'knowledge',
    params,
    resolvedArgs,
    [...stepPath, 'knowledge'],
  );

  if (isWorkflowParamReference(step.instruction)) {
    expandedStep.instruction = resolveExpandedParamValue(
      step.name,
      'instruction',
      step.instruction,
      ['facet_ref'],
      'instruction',
      params,
      resolvedArgs,
      [...stepPath, 'instruction'],
    ) as RawWorkflowStep['instruction'];
  }

  if (expandedStep.output_contracts?.report) {
    expandedStep.output_contracts.report = expandedStep.output_contracts.report.map((report, index) => {
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
          [...stepPath, 'output_contracts', 'report', index, 'format'],
        ) as string,
      };
    });
  }

  expandedStep.args = expandWorkflowCallArgs(step, params, resolvedArgs, stepPath);

  if (Array.isArray(expandedStep.parallel)) {
    expandedStep.parallel = expandedStep.parallel.map((substep, index) =>
      expandStepFields(substep as RawWorkflowStep, params, resolvedArgs, [...stepPath, 'parallel', index]),
    ) as RawWorkflowStep['parallel'];
  } else if (expandedStep.parallel) {
    expandedStep.parallel = {
      ...expandedStep.parallel,
      fixed: expandedStep.parallel.fixed.map((substep, index) =>
        expandStepFields(substep as RawWorkflowStep, params, resolvedArgs, [...stepPath, 'parallel', 'fixed', index]),
      ),
      pool: expandedStep.parallel.pool.map((substep, index) =>
        expandStepFields(substep as RawWorkflowStep, params, resolvedArgs, [...stepPath, 'parallel', 'pool', index]),
      ),
    } as RawWorkflowStep['parallel'];
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
  expanded.steps = expanded.steps.map((step, index) => expandStepFields(step, params, resolvedArgs, ['steps', index]));
  return WorkflowConfigRawSchema.parse(expanded);
}
