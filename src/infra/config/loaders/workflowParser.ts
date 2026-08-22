/**
 * Workflow YAML parsing and normalization.
 */

import type { WorkflowArpeggioConfig, WorkflowCommandGatesConfig, WorkflowMcpServersConfig, WorkflowOverrides, WorkflowRuntimePrepareConfig } from '../../../core/models/config-types.js';
import { WorkflowConfigRawSchema } from '../../../core/models/index.js';
import type {
  WorkflowCallArgValue,
  WorkflowConfig,
  WorkflowStep,
  WorkflowSubworkflowConfig,
} from '../../../core/models/index.js';
import {
  enumerateRawParallelSubSteps,
} from './workflowParallelTraversal.js';
import { normalizeRuntime } from '../configNormalizers.js';
import type {
  FacetResolutionContext,
  WorkflowSections,
} from './resource-resolver.js';
import {
  resolveSectionMapWithSource,
  unwrapResolvedSectionMap,
} from './resource-resolver.js';
import {
  validateWorkflowRuntimePrepare,
  validateWorkflowCommandGates,
} from './workflowNormalizationPolicies.js';
import { normalizeLoopMonitors } from './workflowLoopMonitorNormalizer.js';
import { normalizeStepFromRaw, type WorkflowLevelDefinitions } from './workflowStepNormalizer.js';
import { resolveCapabilitySets } from './capabilitySetResolver.js';
import { compileFacetPool, type FacetPoolCompilationInput } from './facetPoolCompiler.js';
import { hasOwnFacetPool } from './workflowFacetPoolLookup.js';
import type { ResolvedFacetPool } from '../../../core/models/index.js';
import {
  collectSelectorInstructionRefs,
  expandCallableSubworkflowRaw,
  type WorkflowCallArgResolutionPolicy,
} from './workflowCallableArgResolver.js';
import { prepareCallableSubworkflowDiscoveryArgs } from './workflowCallableDiscoveryArgs.js';
import {
  annotateWorkflowFragmentError,
  parseWorkflowRaw,
  registerWorkflowFragmentErrorSource,
} from './workflowRawParser.js';
import type { WorkflowTrustInfo } from './workflowTrustSource.js';
import { attachWorkflowResolvedSections } from './workflowSourceMetadata.js';
import { withWorkflowConfigErrorPath as withWorkflowStepErrorPath } from '../../../core/workflow/workflow-config-error.js';
import { validateDynamicParallelContracts } from '../../../core/workflow/dynamic-parallel/validator.js';
import { resolveWorkflowWideRules } from './workflowAllStepsRuleResolver.js';

type RawSubworkflowParams = NonNullable<ReturnType<typeof WorkflowConfigRawSchema.parse>['subworkflow']>['params'];

function normalizeSubworkflowParams(
  rawParams: NonNullable<RawSubworkflowParams>,
): NonNullable<WorkflowSubworkflowConfig['params']> {
  const params: NonNullable<WorkflowSubworkflowConfig['params']> = {};
  for (const [name, param] of Object.entries(rawParams)) {
    if (param.type === 'workflow_ref') {
      params[name] = {
        type: 'workflow_ref',
        default: param.default,
      };
    } else if (param.type === 'facet_pool_ref') {
      params[name] = {
        type: 'facet_pool_ref',
        default: param.default,
      };
    } else if (param.type === 'companion_ref[]') {
      params[name] = {
        type: 'companion_ref[]',
        default: param.default,
      };
    } else {
      params[name] = {
        type: param.type,
        facetKind: param.facet_kind,
        default: param.default,
      };
    }
  }
  return params;
}

function normalizeSubworkflowConfig(
  raw: ReturnType<typeof WorkflowConfigRawSchema.parse>['subworkflow'],
): WorkflowSubworkflowConfig | undefined {
  if (!raw) {
    return undefined;
  }

  return {
    callable: raw.callable,
    visibility: raw.visibility,
    returns: raw.returns,
    params: raw.params ? normalizeSubworkflowParams(raw.params) : undefined,
  };
}

interface NormalizeWorkflowConfigOptions {
  callableArgs?: Record<string, WorkflowCallArgValue>,
  callableArgPolicy?: WorkflowCallArgResolutionPolicy,
  callableArgMode?: 'runtime' | 'discovery',
  workflowCommandGatesPolicy?: WorkflowCommandGatesConfig,
  workflowPath?: string,
  workflowTrustInfo?: WorkflowTrustInfo,
}

export function normalizeWorkflowConfig(
  raw: unknown,
  workflowDir: string,
  context?: FacetResolutionContext,
  projectOverrides?: WorkflowOverrides,
  globalOverrides?: WorkflowOverrides,
  workflowRuntimePreparePolicy?: WorkflowRuntimePrepareConfig,
  workflowArpeggioPolicy?: WorkflowArpeggioConfig,
  workflowMcpServersPolicy?: WorkflowMcpServersConfig,
  options: NormalizeWorkflowConfigOptions = {},
): WorkflowConfig {
  const {
    callableArgs,
    callableArgPolicy,
    callableArgMode = 'runtime',
    workflowCommandGatesPolicy,
    workflowPath,
    workflowTrustInfo,
  } = options;
  const parsedRaw = parseWorkflowRaw(raw, {
    context,
    workflowPath: workflowPath ?? workflowDir,
    trustInfo: workflowTrustInfo,
  });
  try {
  const callableDiscovery = callableArgMode === 'discovery'
    ? prepareCallableSubworkflowDiscoveryArgs(parsedRaw)
    : { raw: parsedRaw, callableArgs };
  const parsed = expandCallableSubworkflowRaw(
    callableDiscovery.raw,
    {
      args: callableDiscovery.callableArgs ?? callableArgs,
      argPolicy: callableArgPolicy,
      workflowDir,
      context,
    },
  );
  const workflowWideRules = resolveWorkflowWideRules(
    parsed.all_steps?.rules,
    context?.projectDir ?? workflowDir,
    context?.lang ?? 'en',
  );
  const selectorInstructionRefs = collectSelectorInstructionRefs(parsed.steps);
  const resolvedPoliciesWithSource = resolveSectionMapWithSource(parsed.policies, workflowDir, 'policies', context);
  const resolvedKnowledgeWithSource = resolveSectionMapWithSource(parsed.knowledge, workflowDir, 'knowledge', context);
  const resolvedInstructionsWithSource = resolveSectionMapWithSource(
    parsed.instructions,
    workflowDir,
    'instructions',
    context,
    undefined,
    selectorInstructionRefs,
  );
  const resolvedReportFormatsWithSource = resolveSectionMapWithSource(parsed.report_formats, workflowDir, 'output-contracts', context);
  const sections: WorkflowSections = {
    personas: parsed.personas,
    resolvedPolicies: unwrapResolvedSectionMap(resolvedPoliciesWithSource),
    resolvedPoliciesWithSource,
    resolvedKnowledge: unwrapResolvedSectionMap(resolvedKnowledgeWithSource),
    resolvedKnowledgeWithSource,
    resolvedInstructions: unwrapResolvedSectionMap(resolvedInstructionsWithSource),
    resolvedInstructionsWithSource,
    resolvedReportFormats: unwrapResolvedSectionMap(resolvedReportFormatsWithSource),
    resolvedReportFormatsWithSource,
  };

  const workflowRuntime = normalizeRuntime(parsed.workflow_config?.runtime);
  validateWorkflowRuntimePrepare(workflowRuntime, workflowRuntimePreparePolicy);
  validateWorkflowCommandGates(parsed.steps, workflowCommandGatesPolicy);
  const workflowDefinitions: WorkflowLevelDefinitions = {
    ...(parsed.capabilities !== undefined
      ? { capabilityOptions: resolveCapabilitySets(parsed.capabilities, workflowDir, context) }
      : {}),
    ...(parsed.mcp_servers !== undefined ? { mcpServers: parsed.mcp_servers } : {}),
  };
  const steps: WorkflowStep[] = parsed.steps.map((step, index) =>
    normalizeStepFromRaw(
      step,
      workflowDir,
      sections,
      parsed.schemas,
      ['steps', index],
      undefined,
      context,
      projectOverrides,
      globalOverrides,
      workflowArpeggioPolicy,
      workflowMcpServersPolicy,
      workflowDefinitions,
    ),
  );

  const loopMonitors = normalizeLoopMonitors(parsed.loop_monitors, workflowDir, sections, context);
  validateDynamicParallelContracts(steps, ['steps']);
  const facetPools = compileWorkflowFacetPools(parsed.facet_pools, workflowDir, context, sections);
  validateDynamicFacetsReferences(parsed.steps, facetPools);
  const config: WorkflowConfig = {
    name: parsed.name,
    description: parsed.description,
    subworkflow: normalizeSubworkflowConfig(parsed.subworkflow),
    schemas: parsed.schemas,
    runtime: workflowRuntime,
    personas: parsed.personas,
    policies: sections.resolvedPolicies,
    knowledge: sections.resolvedKnowledge,
    instructions: sections.resolvedInstructions,
    reportFormats: sections.resolvedReportFormats,
    ...(workflowWideRules === undefined ? {} : { allStepsRules: workflowWideRules }),
    steps,
    initialStep: parsed.initial_step ?? steps[0]!.name,
    maxSteps: parsed.max_steps,
    loopMonitors,
    interactiveMode: parsed.interactive_mode,
    ...(facetPools === undefined ? {} : { facetPools }),
  };
  attachWorkflowResolvedSections(config, {
    policies: resolvedPoliciesWithSource,
    knowledge: resolvedKnowledgeWithSource,
    instructions: resolvedInstructionsWithSource,
    'output-contracts': resolvedReportFormatsWithSource,
  });
  registerWorkflowFragmentErrorSource(config, parsedRaw, workflowPath ?? workflowDir);
  return config;
  } catch (error) {
    throw annotateWorkflowFragmentError(
      error,
      parsedRaw,
      workflowPath ?? workflowDir,
    );
  }
}

type RawFacetPools = NonNullable<ReturnType<typeof WorkflowConfigRawSchema.parse>['facet_pools']>;
type RawWorkflowSteps = ReturnType<typeof WorkflowConfigRawSchema.parse>['steps'];

function validateDynamicFacetsReferences(
  steps: RawWorkflowSteps,
  facetPools: Record<string, ResolvedFacetPool> | undefined,
): void {
  const candidates = steps.flatMap((step, index) => [
    { step, path: ['steps', index] as readonly PropertyKey[] },
    ...(step.parallel === undefined
      ? []
      : enumerateRawParallelSubSteps(step.parallel, ['steps', index, 'parallel']).map((entry) => ({
          step: entry.subStep as RawWorkflowSteps[number],
          path: entry.path,
        }))),
  ]);
  for (const { step, path } of candidates) {
    if (step.dynamic_facets === undefined) continue;
    const poolName = step.dynamic_facets.pool;
    const dynamicFacetsPath = [...path, 'dynamic_facets'] as readonly PropertyKey[];
    const stepLabel = path.includes('parallel')
      ? `parallel sub-step "${step.name}"`
      : `step "${step.name}"`;
    if (typeof poolName !== 'string') {
      throw withWorkflowStepErrorPath(
        new Error(`Configuration error: ${stepLabel} has an unresolved facet pool parameter`),
        [...dynamicFacetsPath, 'pool'],
      );
    }
    if (!hasOwnFacetPool(facetPools, poolName)) {
      throw withWorkflowStepErrorPath(
        new Error(`Configuration error: ${stepLabel} references unknown facet pool "${poolName}"`),
        [...dynamicFacetsPath, 'pool'],
      );
    }
    const pool = facetPools![poolName]!;
    const candidateCount = pool.candidates.length;
    if (
      step.dynamic_facets.max_selected !== undefined
      && step.dynamic_facets.max_selected > candidateCount
    ) {
      throw withWorkflowStepErrorPath(
        new Error(
          `Configuration error: ${stepLabel} dynamic_facets.max_selected (${step.dynamic_facets.max_selected}) exceeds candidate count (${candidateCount}) of pool "${poolName}"`,
        ),
        [...dynamicFacetsPath, 'max_selected'],
      );
    }
  }
}

function compileWorkflowFacetPools(
  raw: RawFacetPools | undefined,
  workflowDir: string,
  context: FacetResolutionContext | undefined,
  sections: WorkflowSections,
): Record<string, ResolvedFacetPool> | undefined {
  if (!raw) return undefined;
  const result: Record<string, ResolvedFacetPool> = {};
  for (const [name, pool] of Object.entries(raw)) {
    const input: FacetPoolCompilationInput = 'uses' in pool
      ? { kind: 'external', name, ref: pool.uses }
      : {
        kind: 'inline',
        name,
        policies: pool.policies,
        knowledge: pool.knowledge,
        candidates: pool.candidates.map((c) => ({
          id: c.id,
          description: c.description,
          ...(c.policy === undefined ? {} : { policy: c.policy }),
          ...(c.knowledge === undefined ? {} : { knowledge: c.knowledge }),
        })),
      };
    result[name] = compileFacetPool(input, workflowDir, context, { workflowSections: sections });
  }
  return result;
}
