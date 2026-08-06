/**
 * Workflow YAML parsing and normalization.
 */

import type { WorkflowArpeggioConfig, WorkflowCommandGatesConfig, WorkflowMcpServersConfig, WorkflowOverrides, WorkflowRuntimePrepareConfig } from '../../../core/models/config-types.js';
import { WorkflowConfigRawSchema } from '../../../core/models/index.js';
import type {
  FindingContractConfig,
  LoopMonitorConfig,
  WorkflowConfig,
  WorkflowStep,
  WorkflowSubworkflowConfig,
} from '../../../core/models/index.js';
import { enumerateParallelSubSteps } from './workflowParallelTraversal.js';
import {
  hasFindingsReference,
  parseWorkflowRuleCondition,
} from '../../../core/models/workflow-rule-condition.js';
import {
  FINDING_ADJUDICATION_PERSONA,
  workflowWiresFindingConflictAdjudication,
} from '../../../core/workflow/findings/adjudication-step.js';
import { FINDING_CONFLICT_ADJUDICATION_STEP } from '../../../core/workflow/constants.js';
import { FINDING_ESCALATION_REVIEWER_ROUTING_KEY } from '../../../core/models/finding-types.js';
import { normalizeAutoRoutingConfig, normalizeRateLimitFallback, normalizeRuntime } from '../configNormalizers.js';
import type {
  FacetResolutionContext,
  ResolvedSectionMap,
  ResolvedFacetContent,
  WorkflowSections,
} from './resource-resolver.js';
import {
  extractPersonaDisplayName,
  resolvePersona,
  resolveRefToContent,
  resolveRefToContentWithSource,
  resolveSectionMapWithSource,
  unwrapResolvedSectionMap,
} from './resource-resolver.js';
import {
  validateWorkflowRuntimePrepare,
  validateWorkflowCommandGates,
} from './workflowNormalizationPolicies.js';
import { normalizeLoopMonitors } from './workflowLoopMonitorNormalizer.js';
import { normalizeProviderReference, normalizeStepFromRaw } from './workflowStepNormalizer.js';
import { compileFacetPool, type FacetPoolCompilationInput } from './facetPoolCompiler.js';
import type { ResolvedFacetPool } from '../../../core/models/index.js';
import {
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
import { withWorkflowConfigErrorPath as withWorkflowStepErrorPath } from '../../../core/workflow/workflow-config-error.js';
import { validateDynamicParallelContracts } from '../../../core/workflow/dynamic-parallel/validator.js';
import { isScopeRef } from 'faceted-prompting';

function normalizeSubworkflowConfig(
  raw: ReturnType<typeof WorkflowConfigRawSchema.parse>['subworkflow'],
): WorkflowSubworkflowConfig | undefined {
  if (!raw) {
    return undefined;
  }

  return {
    callable: raw.callable,
    visibility: raw.visibility,
    requiresFindingContract: raw.requires_finding_contract,
    returns: raw.returns,
    params: raw.params
      ? Object.fromEntries(
        Object.entries(raw.params).map(([name, param]) => [
          name,
          param.type === 'workflow_ref'
            ? {
                type: param.type,
                default: param.default,
              }
            : {
                type: param.type,
                facetKind: param.facet_kind,
                default: param.default,
              },
        ]),
      )
      : undefined,
  };
}

function resolveFindingManagerAdditions(input: {
  refs: readonly string[] | undefined;
  resolved: Record<string, string> | ResolvedSectionMap | undefined;
  workflowDir: string;
  kind: 'policies' | 'knowledge';
  field: 'policy' | 'knowledge';
  context?: FacetResolutionContext;
}): readonly ResolvedFacetContent[] | undefined {
  if (input.refs === undefined) return undefined;
  const contents: ResolvedFacetContent[] = [];
  input.refs.forEach((ref, index) => {
    const fieldPath = `finding_contract.manager.${input.field}[${index}]`;
    let resolved: ResolvedFacetContent | undefined;
    try {
      resolved = resolveRefToContentWithSource(
        ref,
        input.resolved,
        input.workflowDir,
        input.kind,
        input.context,
      );
    } catch (error) {
      throw new Error(
        `Configuration error: failed to resolve ${fieldPath} "${ref}"`,
        { cause: error },
      );
    }
    if (resolved === undefined) {
      throw new Error(
        `Configuration error: failed to resolve ${fieldPath} "${ref}"`,
      );
    }
    contents.push(resolved);
  });
  return contents.length > 0 ? contents : undefined;
}

type RawFindingContractAdjudicator = NonNullable<
  NonNullable<ReturnType<typeof WorkflowConfigRawSchema.parse>['finding_contract']>['adjudicator']
>;

function findingContractAdjudicatorResolutionError(
  field: 'persona' | 'instruction',
  ref: string,
  options?: ErrorOptions,
): Error {
  return new Error(
    `Configuration error: failed to resolve finding_contract.adjudicator.${field} "${ref}"`,
    options,
  );
}

function resolveFindingContractAdjudicator(
  raw: RawFindingContractAdjudicator,
  sections: WorkflowSections,
  workflowDir: string,
  context?: FacetResolutionContext,
): NonNullable<FindingContractConfig['adjudicator']> {
  let resolvedPersona: ReturnType<typeof resolvePersona>;
  try {
    resolvedPersona = resolvePersona(raw.persona, sections, workflowDir, context);
  } catch (error) {
    throw findingContractAdjudicatorResolutionError('persona', raw.persona, { cause: error });
  }

  let resolvedInstruction: string | undefined;
  try {
    resolvedInstruction = resolveRefToContent(
      raw.instruction,
      sections.resolvedInstructionsWithSource ?? sections.resolvedInstructions,
      workflowDir,
      'instructions',
      context,
    );
  } catch (error) {
    throw findingContractAdjudicatorResolutionError('instruction', raw.instruction, { cause: error });
  }

  if (
    resolvedPersona.personaSpec === undefined
    || (isScopeRef(raw.persona) && resolvedPersona.personaPath === undefined)
  ) {
    throw findingContractAdjudicatorResolutionError('persona', raw.persona);
  }
  if (resolvedInstruction === undefined) {
    throw findingContractAdjudicatorResolutionError('instruction', raw.instruction);
  }

  const routingKey = raw.persona.trim();
  return {
    persona: resolvedPersona.personaSpec,
    personaDisplayName: resolvedPersona.personaPath
      ? extractPersonaDisplayName(resolvedPersona.personaPath)
      : resolvedPersona.personaSpec,
    ...(routingKey ? { providerRoutingPersonaKey: routingKey } : {}),
    ...(resolvedPersona.personaPath ? { personaPath: resolvedPersona.personaPath } : {}),
    instruction: resolvedInstruction,
    ...(raw.provider ? { provider: raw.provider } : {}),
    ...(raw.model ? { model: raw.model } : {}),
  };
}

type RawFindingContractEscalationReviewer = NonNullable<
  NonNullable<ReturnType<typeof WorkflowConfigRawSchema.parse>['finding_contract']>['escalation_reviewer']
>;

function findingContractEscalationReviewerResolutionError(
  field: 'persona' | 'instruction' | 'output_contract',
  ref: string,
  options?: ErrorOptions,
): Error {
  return new Error(
    `Configuration error: failed to resolve finding_contract.escalation_reviewer.${field} "${ref}"`,
    options,
  );
}

function resolveFindingContractEscalationReviewer(
  raw: RawFindingContractEscalationReviewer,
  sections: WorkflowSections,
  workflowDir: string,
  context?: FacetResolutionContext,
): NonNullable<FindingContractConfig['escalationReviewer']> {
  let resolvedPersona: ReturnType<typeof resolvePersona>;
  try {
    resolvedPersona = resolvePersona(raw.persona, sections, workflowDir, context);
  } catch (error) {
    throw findingContractEscalationReviewerResolutionError('persona', raw.persona, { cause: error });
  }
  if (
    resolvedPersona.personaSpec === undefined
    || (isScopeRef(raw.persona) && resolvedPersona.personaPath === undefined)
  ) {
    throw findingContractEscalationReviewerResolutionError('persona', raw.persona);
  }

  const resolveOptionalRef = (
    field: 'instruction' | 'output_contract',
    ref: string | undefined,
    resolved: Record<string, string> | ResolvedSectionMap | undefined,
    kind: 'instructions' | 'output-contracts',
  ): string | undefined => {
    if (ref === undefined) {
      return undefined;
    }
    let content: string | undefined;
    try {
      content = resolveRefToContent(ref, resolved, workflowDir, kind, context);
    } catch (error) {
      throw findingContractEscalationReviewerResolutionError(field, ref, { cause: error });
    }
    if (content === undefined) {
      throw findingContractEscalationReviewerResolutionError(field, ref);
    }
    return content;
  };

  const instruction = resolveOptionalRef(
    'instruction',
    raw.instruction,
    sections.resolvedInstructionsWithSource ?? sections.resolvedInstructions,
    'instructions',
  );
  const outputContract = resolveOptionalRef(
    'output_contract',
    raw.output_contract,
    sections.resolvedReportFormatsWithSource ?? sections.resolvedReportFormats,
    'output-contracts',
  );

  return {
    persona: resolvedPersona.personaSpec,
    personaDisplayName: resolvedPersona.personaPath
      ? extractPersonaDisplayName(resolvedPersona.personaPath)
      : resolvedPersona.personaSpec,
    // persona 名ではなく固定キー。escalation_reviewer を書いた時点で
    // provider_routing.personas['escalation-reviewer'] が唯一の routing 入口になる。
    providerRoutingPersonaKey: FINDING_ESCALATION_REVIEWER_ROUTING_KEY,
    ...(resolvedPersona.personaPath ? { personaPath: resolvedPersona.personaPath } : {}),
    ...(instruction === undefined ? {} : { instruction }),
    ...(outputContract === undefined ? {} : { outputContract }),
    ...(raw.provider ? { provider: raw.provider } : {}),
    ...(raw.model ? { model: raw.model } : {}),
  };
}

/**
 * escalation reviewer の publication identity は reviewerStepName
 * 'escalation-reviewer' で owner publication と分かれる。同名の実 step が
 * 存在すると publication identity が衝突し、提示計上が混線する。
 * escalation_reviewer を設定したワークフローに限り予約語として拒否する。
 */
function validateFindingContractEscalationReviewerReservedStepName(
  findingContract: FindingContractConfig | undefined,
  steps: readonly WorkflowStep[],
): void {
  if (findingContract?.escalationReviewer === undefined) {
    return;
  }
  const collectNames = (candidates: readonly WorkflowStep[]): string[] => (
    candidates.flatMap((step) => [
      step.name,
      ...(step.parallel === undefined
        ? []
        : collectNames(enumerateParallelSubSteps(step.parallel, []).map(({ subStep }) => subStep))),
    ])
  );
  if (collectNames(steps).includes(FINDING_ESCALATION_REVIEWER_ROUTING_KEY)) {
    throw new Error(
      `Configuration error: step name "${FINDING_ESCALATION_REVIEWER_ROUTING_KEY}" is reserved for finding_contract.escalation_reviewer`,
    );
  }
}

function normalizeFindingContractConfig(
  raw: ReturnType<typeof WorkflowConfigRawSchema.parse>['finding_contract'],
  workflowDir: string,
  sections: WorkflowSections,
  context?: FacetResolutionContext,
): FindingContractConfig | undefined {
  if (!raw) {
    return undefined;
  }

  const { personaSpec, personaPath } = resolvePersona(raw.manager.persona, sections, workflowDir, context);
  const instruction = resolveRefToContent(
    raw.manager.instruction,
    sections.resolvedInstructionsWithSource ?? sections.resolvedInstructions,
    workflowDir,
    'instructions',
    context,
  );
  const outputContract = resolveRefToContent(
    raw.manager.output_contract,
    sections.resolvedReportFormatsWithSource ?? sections.resolvedReportFormats,
    workflowDir,
    'output-contracts',
    context,
  );
  if (!personaSpec) {
    throw new Error('Configuration error: finding_contract.manager.persona is required');
  }
  if (!instruction) {
    throw new Error(`Configuration error: failed to resolve finding_contract.manager.instruction "${raw.manager.instruction}"`);
  }
  if (!outputContract) {
    throw new Error(`Configuration error: failed to resolve finding_contract.manager.output_contract "${raw.manager.output_contract}"`);
  }
  const providerRoutingPersonaKey = raw.manager.persona.trim();
  const policyContents = resolveFindingManagerAdditions({
    refs: raw.manager.policy,
    resolved: sections.resolvedPoliciesWithSource ?? sections.resolvedPolicies,
    workflowDir,
    kind: 'policies',
    field: 'policy',
    context,
  });
  const knowledgeContents = resolveFindingManagerAdditions({
    refs: raw.manager.knowledge,
    resolved: sections.resolvedKnowledgeWithSource ?? sections.resolvedKnowledge,
    workflowDir,
    kind: 'knowledge',
    field: 'knowledge',
    context,
  });
  const adjudicator = raw.adjudicator === undefined
    ? undefined
    : resolveFindingContractAdjudicator(raw.adjudicator, sections, workflowDir, context);
  const escalationReviewer = raw.escalation_reviewer === undefined
    ? undefined
    : resolveFindingContractEscalationReviewer(raw.escalation_reviewer, sections, workflowDir, context);

  return {
    manager: {
      persona: personaSpec,
      personaDisplayName: personaPath ? extractPersonaDisplayName(personaPath) : personaSpec,
      ...(providerRoutingPersonaKey ? { providerRoutingPersonaKey } : {}),
      ...(personaPath ? { personaPath } : {}),
      instruction,
      outputContract,
      ...(policyContents === undefined ? {} : { policyContents }),
      ...(knowledgeContents === undefined ? {} : { knowledgeContents }),
      ...(raw.manager.provider ? { provider: raw.manager.provider } : {}),
      ...(raw.manager.model ? { model: raw.manager.model } : {}),
    },
    ...(adjudicator === undefined ? {} : { adjudicator }),
    ...(escalationReviewer === undefined ? {} : { escalationReviewer }),
    // 有限停止予算（Finding Contract・対策バッチ B1 の拡張）: ここでは YAML に
    // 書かれた値だけをそのまま写す（未指定フィールドの穴埋めはしない）。
    // max_rounds の既定値適用は stop-budget.ts の resolveStopBudgetLimits が唯一の
    // 場所。max_minutes に既定値は無く、未設定なら時間上限なし。
    ...(raw.stop_budget
      ? {
        stopBudget: {
          ...(raw.stop_budget.max_rounds !== undefined ? { maxRounds: raw.stop_budget.max_rounds } : {}),
          ...(raw.stop_budget.max_minutes !== undefined ? { maxMinutes: raw.stop_budget.max_minutes } : {}),
        },
      }
      : {}),
    // review-integrity 予算（review-integrity requirement）: 未指定分は
    // review-integrity.ts の DEFAULT_REVIEW_INTEGRITY_BUDGET が補う。
    ...(raw.review_budget
      ? {
        reviewBudget: {
          ...(raw.review_budget.max_review_rounds !== undefined ? { maxReviewRounds: raw.review_budget.max_review_rounds } : {}),
        },
      }
      : {}),
  };
}

/**
 * Resolves the fixed "supervisor" persona for the engine-synthesized
 * finding-conflict-adjudication step (contract invariant). Without personaPath the
 * runner would use the bare persona NAME as the system prompt and the facet
 * body would never reach the model. Resolution is attempted whenever a
 * finding contract exists (so workflow_call children that wire the step can
 * inherit an adjudicator from the parent contract); it is a configuration
 * error only when this workflow actually wires the step and the persona
 * cannot be found.
 */
function resolveFindingConflictAdjudicator(
  findingContract: FindingContractConfig | undefined,
  steps: readonly WorkflowStep[],
  loopMonitors: readonly LoopMonitorConfig[] | undefined,
  workflowDir: string,
  sections: WorkflowSections,
  context?: FacetResolutionContext,
): void {
  if (!findingContract) {
    return;
  }
  if (findingContract.adjudicator !== undefined) {
    return;
  }
  const wires = workflowWiresFindingConflictAdjudication(steps, loopMonitors);
  const { personaSpec, personaPath } = resolvePersona(
    FINDING_ADJUDICATION_PERSONA,
    sections,
    workflowDir,
    context,
  );
  if (personaSpec && personaPath) {
    findingContract.adjudicator = {
      persona: personaSpec,
      personaPath,
      personaDisplayName: extractPersonaDisplayName(personaPath),
      providerRoutingPersonaKey: FINDING_ADJUDICATION_PERSONA,
    };
    return;
  }
  if (wires) {
    throw new Error(
      `Configuration error: persona "${FINDING_ADJUDICATION_PERSONA}" is required for `
      + `next: ${FINDING_CONFLICT_ADJUDICATION_STEP} but could not be resolved`,
    );
  }
}

function validateFindingsRulesRequireContract(
  steps: ReturnType<typeof WorkflowConfigRawSchema.parse>['steps'],
  loopMonitors: readonly LoopMonitorConfig[] | undefined,
  findingContract: FindingContractConfig | undefined,
  requiresInheritedFindingContract: boolean,
): void {
  if (findingContract || requiresInheritedFindingContract) {
    return;
  }

  for (const [stepIndex, step] of steps.entries()) {
    for (const [ruleIndex, rule] of (step.rules ?? []).entries()) {
      if (!hasFindingsReference(parseWorkflowRuleCondition(rule.condition))) {
        continue;
      }
      throw withWorkflowStepErrorPath(
        new Error(`Configuration error: step "${step.name}" uses findings.* rule but finding_contract is not configured`),
        ['steps', stepIndex, 'rules', ruleIndex],
      );
    }
    const parallelSubSteps = step.parallel === undefined
      ? []
      : enumerateParallelSubSteps(step.parallel, ['steps', stepIndex, 'parallel']);
    for (const { subStep: subStep, path } of parallelSubSteps) {
      for (const [ruleIndex, rule] of (subStep.rules ?? []).entries()) {
        if (!hasFindingsReference(parseWorkflowRuleCondition(rule.condition))) {
          continue;
        }
        throw withWorkflowStepErrorPath(
          new Error(
            `Configuration error: parallel sub-step "${subStep.name}" in step "${step.name}" uses findings.* rule but finding_contract is not configured`,
          ),
          [...path, 'rules', ruleIndex],
        );
      }
    }
  }

  for (const monitor of loopMonitors ?? []) {
    for (const rule of monitor.judge.rules) {
      if (!hasFindingsReference(rule.condition)) {
        continue;
      }
      throw new Error('Configuration error: loop_monitor judge uses findings.* rule but finding_contract is not configured');
    }
  }
}

interface NormalizeWorkflowConfigOptions {
  callableArgs?: Record<string, string | string[]>,
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
  const resolvedPoliciesWithSource = resolveSectionMapWithSource(parsed.policies, workflowDir, 'policies', context);
  const resolvedKnowledgeWithSource = resolveSectionMapWithSource(parsed.knowledge, workflowDir, 'knowledge', context);
  const resolvedInstructionsWithSource = resolveSectionMapWithSource(parsed.instructions, workflowDir, 'instructions', context);
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
  const normalizedWorkflowProvider = normalizeProviderReference(
    parsed.workflow_config?.provider,
    parsed.workflow_config?.model,
    parsed.workflow_config?.provider_options,
    workflowDir,
    context,
  );
  const steps: WorkflowStep[] = parsed.steps.map((step, index) =>
    normalizeStepFromRaw(
      step,
      workflowDir,
      sections,
      parsed.schemas,
      ['steps', index],
      normalizedWorkflowProvider.provider,
      normalizedWorkflowProvider.model,
      normalizedWorkflowProvider.modelSpecified,
      undefined,
      normalizedWorkflowProvider.providerOptions,
      undefined,
      true,
      true,
      context,
      projectOverrides,
      globalOverrides,
      workflowArpeggioPolicy,
      workflowMcpServersPolicy,
    ),
  );

  const loopMonitors = normalizeLoopMonitors(parsed.loop_monitors, workflowDir, sections, context);
  validateDynamicParallelContracts(steps, ['steps']);
  const facetPools = compileWorkflowFacetPools(parsed.facet_pools, workflowDir, context, sections);
  validateDynamicFacetsReferences(parsed.steps, facetPools);
  const findingContract = normalizeFindingContractConfig(parsed.finding_contract, workflowDir, sections, context);
  validateFindingsRulesRequireContract(
    parsed.steps,
    loopMonitors,
    findingContract,
    parsed.subworkflow?.requires_finding_contract === true,
  );
  resolveFindingConflictAdjudicator(findingContract, steps, loopMonitors, workflowDir, sections, context);
  validateFindingContractEscalationReviewerReservedStepName(findingContract, steps);

  const config: WorkflowConfig = {
    name: parsed.name,
    description: parsed.description,
    subworkflow: normalizeSubworkflowConfig(parsed.subworkflow),
    findingContract,
    schemas: parsed.schemas,
    provider: normalizedWorkflowProvider.provider,
    model: normalizedWorkflowProvider.model,
    providerOptions: normalizedWorkflowProvider.providerOptions,
    autoRouting: normalizeAutoRoutingConfig(parsed.auto_routing, { baseUrlTrust: 'loopback-only' }),
    rateLimitFallback: normalizeRateLimitFallback(parsed.rate_limit_fallback),
    runtime: workflowRuntime,
    personas: parsed.personas,
    policies: sections.resolvedPolicies,
    knowledge: sections.resolvedKnowledge,
    instructions: sections.resolvedInstructions,
    reportFormats: sections.resolvedReportFormats,
    steps,
    initialStep: parsed.initial_step ?? steps[0]!.name,
    maxSteps: parsed.max_steps,
    loopMonitors,
    interactiveMode: parsed.interactive_mode,
    ...(facetPools === undefined ? {} : { facetPools }),
  };
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
  for (const [index, step] of steps.entries()) {
    if (step.dynamic_facets === undefined) continue;
    const poolName = step.dynamic_facets.pool;
    const pool = facetPools?.[poolName];
    if (pool === undefined) {
      throw withWorkflowStepErrorPath(
        new Error(`Configuration error: step "${step.name}" references unknown facet pool "${poolName}"`),
        ['steps', index, 'dynamic_facets', 'pool'],
      );
    }
    const candidateCount = pool.candidates.length;
    if (step.dynamic_facets.max_selected > candidateCount) {
      throw withWorkflowStepErrorPath(
        new Error(
          `Configuration error: step "${step.name}" dynamic_facets.max_selected (${step.dynamic_facets.max_selected}) exceeds candidate count (${candidateCount}) of pool "${poolName}"`,
        ),
        ['steps', index, 'dynamic_facets', 'max_selected'],
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
