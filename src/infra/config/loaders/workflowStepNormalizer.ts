import type { z } from 'zod';
import type {
  AgentWorkflowStep,
  DynamicParallelFixedSubStep,
  DynamicParallelPoolSubStep,
  NormalAgentWorkflowStep,
  SystemWorkflowStep,
  WorkflowCallStep,
  WorkflowStep,
  WorkflowStepRawSchema,
} from '../../../core/models/index.js';
import { getWorkflowStepKind } from '../../../core/models/workflow-step-kind.js';
import type { WorkflowArpeggioConfig, WorkflowMcpServersConfig, WorkflowOverrides } from '../../../core/models/config-types.js';
import type {
  StepProviderOptions,
  WorkflowCallArgValue,
  WorkflowStepKind,
  DynamicFacetsConfig,
} from '../../../core/models/workflow-types.js';
import type { CompanionSelection } from '../../../core/models/companion-types.js';
import { applyQualityGateOverrides } from './qualityGateOverrides.js';
import {
  type FacetResolutionContext,
  type WorkflowSections,
  extractPersonaDisplayName,
  isResourcePath,
  resolvePersona,
  resolveRefListWithSource,
  resolveRefToContent,
} from './resource-resolver.js';
import { mergeProviderOptions } from '../providerOptions.js';
import { normalizeProviderBlockOptions } from '../providerBlockOptions.js';
import type { ConfigProviderReference } from '../providerReference.js';
import { validateWorkflowArpeggio, validateWorkflowMcpServers } from './workflowNormalizationPolicies.js';
import { normalizeRule } from './workflowRuleNormalizer.js';
import { normalizeArpeggio, normalizeOutputContract, normalizeTeamLeader } from './workflowStepFeaturesNormalizer.js';
import { resolveStructuredOutput } from './workflowStructuredOutputResolver.js';
import { normalizeWorkflowEffects } from './workflowSystemStepNormalizer.js';
import { parseAiConditionExpression } from '../../../core/models/workflow-condition-expression.js';
import { resolveWorkflowProviderOptions } from './workflowProviderOptionsResolver.js';
import { resolveCapabilitySets } from './capabilitySetResolver.js';
import { resolveWorkflowMcpReferences } from './workflowMcpReferenceResolver.js';
import type { McpServerConfig } from '../../../core/models/index.js';
import { isWorkflowParamReference } from './workflowCallableParamRef.js';
import { normalizeQualityGates } from '../configNormalizers.js';
import { withWorkflowConfigErrorPath as withWorkflowStepErrorPath } from '../../../core/workflow/workflow-config-error.js';

type RawStep = z.output<typeof WorkflowStepRawSchema>;
type RawProviderReference = RawStep['provider'];

/** Workflow-level inputs threaded down to every step so `capabilities:` / `mcp:` references resolve. */
export interface WorkflowLevelDefinitions {
  capabilityOptions?: StepProviderOptions;
  mcpServers?: Record<string, McpServerConfig>;
}
type RawPromotionEntry = NonNullable<RawStep['promotion']>[number];
type NormalizedProviderReference = ReturnType<typeof normalizeProviderReference>;

function normalizeWorkflowCallArgs(
  stepName: string,
  args: RawStep['args'],
): Record<string, WorkflowCallArgValue> | undefined {
  if (!args) {
    return undefined;
  }

  const normalized: Record<string, WorkflowCallArgValue> = {};
  for (const [argName, value] of Object.entries(args)) {
    if (isWorkflowParamReference(value)) {
      throw new Error(`Step "${stepName}" has unresolved $param in args.${argName}`);
    }
    normalized[argName] = value;
  }
  return normalized;
}

export function normalizeProviderReference(
  provider: RawProviderReference,
  model: RawStep['model'],
  providerOptions: RawStep['provider_options'],
  workflowDir: string,
  context?: FacetResolutionContext,
): {
  provider: WorkflowStep['provider'];
  model: WorkflowStep['model'];
  providerOptions: StepProviderOptions | undefined;
  providerSpecified: boolean;
  modelSpecified: boolean;
} {
  const modelSpecified = model !== undefined;
  const normalizedModel = model ?? undefined;
  const normalizedProviderOptions = resolveWorkflowProviderOptions(
    providerOptions as (Record<string, unknown> & { extends?: string }) | undefined,
    workflowDir,
    context,
  );
  const providerReference = provider as ConfigProviderReference<NonNullable<WorkflowStep['provider']>>;
  if (typeof providerReference === 'string' || providerReference === undefined) {
    return {
      provider: providerReference,
      model: normalizedModel,
      providerOptions: normalizedProviderOptions,
      providerSpecified: providerReference !== undefined,
      modelSpecified,
    };
  }

  return {
    provider: providerReference.type,
    model: providerReference.model ?? normalizedModel,
    providerOptions: mergeProviderOptions(
      normalizeProviderBlockOptions(providerReference),
      normalizedProviderOptions,
    ),
    providerSpecified: true,
    modelSpecified: providerReference.model !== undefined || modelSpecified,
  };
}

function normalizeDynamicFacets(
  raw: RawStep['dynamic_facets'],
  stepPath: readonly PropertyKey[],
): DynamicFacetsConfig | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const pool = normalizeStepField(stepPath, ['dynamic_facets', 'pool'], () => {
    if (typeof raw.pool !== 'string') {
      throw new Error('dynamic_facets.pool has an unresolved parameter reference');
    }
    return raw.pool;
  });
  return normalizeStepField(stepPath, ['dynamic_facets'], () => ({
    pool,
    ...(raw.max_selected === undefined ? {} : { maxSelected: raw.max_selected }),
  }));
}

function normalizePromotionEntry(
  entry: RawPromotionEntry,
  normalizedProvider: NormalizedProviderReference,
): NonNullable<AgentWorkflowStep['promotion']>[number] {
  const aiExpression = entry.condition !== undefined
    ? parseAiConditionExpression(entry.condition)
    : undefined;
  // Issue #1208 Stage 1 (CT-PROMO-1): a target-less `{at:N}` promotion is valid — the ladder in
  // runtime.yaml supplies the target. Only reject when `provider_options` was explicitly written
  // but resolved (e.g. via `extends`) to nothing, and no provider/model completes the target — a
  // targeted promotion whose sole target evaporated is a configuration error, not a ladder request.
  const providerOptionsSpecifiedButEmpty = entry.provider_options !== undefined
    && normalizedProvider.providerOptions === undefined;
  if (
    entry.provider === undefined
    && entry.model === undefined
    && providerOptionsSpecifiedButEmpty
  ) {
    throw new Error('Configuration error: promotion entry requires at least one of "provider", "model", or "provider_options"');
  }
  return {
    at: entry.at,
    condition: entry.condition,
    aiConditionText: aiExpression?.text,
    provider: normalizedProvider.provider,
    providerSpecified: normalizedProvider.providerSpecified,
    model: normalizedProvider.model,
    providerOptions: normalizedProvider.providerOptions,
  };
}

function validateWorkflowCallOverrides(
  normalizedOverrides: NormalizedProviderReference,
): void {
  if (
    normalizedOverrides.provider === undefined
    && normalizedOverrides.model === undefined
    && normalizedOverrides.providerOptions === undefined
  ) {
    throw new Error("Configuration error: workflow_call overrides require at least one of 'provider', 'model', or 'provider_options'");
  }
}

function normalizeStepField<T>(
  stepPath: readonly PropertyKey[],
  fieldPath: readonly PropertyKey[],
  normalize: () => T,
): T {
  try {
    return normalize();
  } catch (error) {
    throw withWorkflowStepErrorPath(error, [...stepPath, ...fieldPath]);
  }
}

export function normalizeStepFromRaw(
  step: RawStep,
  workflowDir: string,
  sections: WorkflowSections,
  workflowSchemas: Record<string, string> | undefined,
  stepPath: readonly PropertyKey[],
  inheritedProvider?: WorkflowStep['provider'],
  inheritedModel?: WorkflowStep['model'],
  inheritedModelSpecified = inheritedModel !== undefined,
  inheritedDirectProviderOptions?: WorkflowStep['providerOptions'],
  inheritedWorkflowProviderOptions?: WorkflowStep['providerOptions'],
  inheritedAllowGitCommit?: boolean,
  inheritedProviderIsWorkflowFallback = false,
  inheritedModelIsWorkflowFallback = inheritedProviderIsWorkflowFallback,
  context?: FacetResolutionContext,
  projectOverrides?: WorkflowOverrides,
  globalOverrides?: WorkflowOverrides,
  workflowArpeggioPolicy?: WorkflowArpeggioConfig,
  workflowMcpServersPolicy?: WorkflowMcpServersConfig,
  workflowDefinitions?: WorkflowLevelDefinitions,
): WorkflowStep {
  try {
  const rules = step.rules?.map((rule, index) =>
    normalizeStepField(stepPath, ['rules', index], () => normalizeRule(rule))
  );
  const kind: WorkflowStepKind = getWorkflowStepKind(step);
  const isSystemStep = kind === 'system';
  const isWorkflowCallStep = kind === 'workflow_call';
  if ((isSystemStep || isWorkflowCallStep) && (step.capabilities !== undefined || step.mcp !== undefined)) {
    // `capabilities` / `mcp` are agent-only capability declarations; fail fast rather than silently
    // dropping them on a step kind that never consumes them.
    throw withWorkflowStepErrorPath(
      new Error(`Step "${step.name}" cannot use "capabilities"/"mcp" on a ${kind} step`),
      stepPath,
    );
  }
  const rawPersona = (step as Record<string, unknown>).persona as string | undefined;
  if (rawPersona !== undefined && rawPersona.trim().length === 0) {
    const error = new Error(`Step "${step.name}" has an empty persona value`);
    throw withWorkflowStepErrorPath(error, [...stepPath, 'persona']);
  }
  const { personaSpec, personaPath } = isSystemStep || isWorkflowCallStep
    ? { personaSpec: undefined, personaPath: undefined }
    : normalizeStepField(stepPath, ['persona'], () => resolvePersona(rawPersona, sections, workflowDir, context));
  const displayNameRaw = (step as Record<string, unknown>).persona_name as string | undefined;
  if (displayNameRaw !== undefined && displayNameRaw.trim().length === 0) {
    const error = new Error(`Step "${step.name}" has an empty persona_name value`);
    throw withWorkflowStepErrorPath(error, [...stepPath, 'persona_name']);
  }
  const derivedPersonaName = personaSpec ? extractPersonaDisplayName(personaSpec) : undefined;
  const resolvedPersonaDisplayName = isSystemStep || isWorkflowCallStep
    ? step.name
    : displayNameRaw || derivedPersonaName || step.name;
  const normalizedRawPersona = rawPersona?.trim();
  const personaOverrideKey = normalizedRawPersona
    ? (isResourcePath(normalizedRawPersona) ? extractPersonaDisplayName(normalizedRawPersona) : normalizedRawPersona)
    : undefined;
  const tags = step.tags?.map((tag, index) => {
    const normalizedTag = tag.trim();
    if (normalizedTag.length === 0) {
      const error = new Error(`Step "${step.name}" has an empty tags entry`);
      throw withWorkflowStepErrorPath(error, [...stepPath, 'tags', index]);
    }
    return normalizedTag;
  });

  const policyContents = isSystemStep || isWorkflowCallStep
    ? undefined
    : normalizeStepField(stepPath, ['policy'], () => resolveRefListWithSource(
      (step as Record<string, unknown>).policy as string | string[] | undefined,
      sections.resolvedPoliciesWithSource ?? sections.resolvedPolicies,
      workflowDir,
      'policies',
      context,
    ));
  const knowledgeContents = isSystemStep || isWorkflowCallStep
    ? undefined
    : normalizeStepField(stepPath, ['knowledge'], () => resolveRefListWithSource(
      (step as Record<string, unknown>).knowledge as string | string[] | undefined,
      sections.resolvedKnowledgeWithSource ?? sections.resolvedKnowledge,
      workflowDir,
      'knowledge',
      context,
  ));
  const normalizedProvider = normalizeStepField(
    stepPath,
    ['provider_options', 'extends'],
    () => normalizeProviderReference(step.provider, step.model, step.provider_options, workflowDir, context),
  );
  const promotion = step.promotion?.map((entry, index) => normalizeStepField(
    stepPath,
    ['promotion', index],
    () => normalizePromotionEntry(
      entry,
      normalizeStepField(
        stepPath,
        ['promotion', index, 'provider_options', 'extends'],
        () => normalizeProviderReference(entry.provider, entry.model, entry.provider_options, workflowDir, context),
      ),
    ),
  ));
  const normalizedOverrides = step.overrides
    ? normalizeStepField(
      stepPath,
      ['overrides', 'provider_options', 'extends'],
      () => normalizeProviderReference(step.overrides!.provider, step.overrides!.model, step.overrides!.provider_options, workflowDir, context),
    )
    : undefined;
  if (normalizedOverrides !== undefined) {
    normalizeStepField(stepPath, ['overrides'], () => validateWorkflowCallOverrides(normalizedOverrides));
  }
  const instruction = isSystemStep || isWorkflowCallStep
    ? undefined
    : step.instruction
    ? normalizeStepField(stepPath, ['instruction'], () => resolveRefToContent(
        step.instruction as string,
        sections.resolvedInstructionsWithSource ?? sections.resolvedInstructions,
        workflowDir,
        'instructions',
        context,
      ))
    : undefined;

  validateWorkflowArpeggio(step.name, step.arpeggio, stepPath, workflowArpeggioPolicy);
  // Resolve `mcp:` references against the workflow's top-level definitions, then enforce the
  // deny-by-default transport policy on the merged result (inline + resolved), so a bundled default
  // pulled in by reference is gated exactly like an inline definition (CT-MCP-5).
  const resolvedMcpServers = resolveWorkflowMcpReferences(
    step.name,
    step.mcp,
    workflowDefinitions?.mcpServers,
    step.mcp_servers,
    stepPath,
  );
  validateWorkflowMcpServers(step.name, resolvedMcpServers, stepPath, workflowMcpServersPolicy);

  if (isWorkflowCallStep) {
    if (isWorkflowParamReference(step.call)) {
      throw withWorkflowStepErrorPath(
        new Error(`Step "${step.name}" has unresolved $param in call`),
        [...stepPath, 'call'],
      );
    }
    const normalizedStep: WorkflowCallStep = {
      name: step.name,
      description: step.description,
      kind: 'workflow_call',
      call: step.call!,
      vars: step.vars,
      overrides: normalizedOverrides
        ? {
            provider: normalizedOverrides.provider,
            model: normalizedOverrides.model,
            providerOptions: normalizedOverrides.providerOptions,
          }
        : undefined,
      args: normalizeStepField(stepPath, ['args'], () => normalizeWorkflowCallArgs(step.name, step.args)),
      findingContractAuthority: step.finding_contract_authority,
      personaDisplayName: resolvedPersonaDisplayName,
      instruction: '',
      rules,
    };
    return normalizedStep;
  }

  if (isSystemStep) {
    const normalizedStep: SystemWorkflowStep = {
      name: step.name,
      description: step.description,
      kind: 'system',
      personaDisplayName: resolvedPersonaDisplayName,
      instruction: '',
      delayBeforeMs: step.delay_before_ms,
      systemInputs: step.system_inputs,
      effects: normalizeWorkflowEffects(step.effects),
      rules,
      passPreviousResponse: step.pass_previous_response ?? true,
    };
    return normalizedStep;
  }

  const qualityGates = normalizeStepField(stepPath, ['quality_gates'], () => applyQualityGateOverrides(
    step.name,
    normalizeQualityGates(step.quality_gates),
    step.edit,
    personaOverrideKey,
    projectOverrides,
    globalOverrides,
  ));

  // A step's own `capabilities:` replaces the workflow default rather than merging, and sits below
  // `provider_options` so an explicit option on the same step still wins.
  const stepCapabilityOptions = step.capabilities !== undefined
    ? normalizeStepField(stepPath, ['capabilities'], () => resolveCapabilitySets(step.capabilities!, workflowDir, context))
    : undefined;
  const effectiveCapabilityOptions = stepCapabilityOptions ?? workflowDefinitions?.capabilityOptions;
  const directProviderOptions = mergeProviderOptions(inheritedDirectProviderOptions, normalizedProvider.providerOptions);
  const providerOptions = mergeProviderOptions(
    effectiveCapabilityOptions,
    mergeProviderOptions(inheritedWorkflowProviderOptions, directProviderOptions),
  );
  const resolvedModel = normalizedProvider.modelSpecified
    ? normalizedProvider.model
    : (normalizedProvider.providerSpecified ? undefined : inheritedModel);
  const inheritsDirectModel = inheritedModelSpecified
    && !inheritedModelIsWorkflowFallback
    && !normalizedProvider.providerSpecified;

  const normalizedAgentFields: Omit<
    NormalAgentWorkflowStep,
    'session' | 'parallel' | 'concurrency' | 'arpeggio' | 'teamLeader' | 'dynamicFacets'
  > = {
    name: step.name,
    description: step.description,
    sessionKey: step.session_key,
    requiresUserInput: step.requires_user_input,
    kind: 'agent',
    persona: personaSpec,
    providerRoutingPersonaKey: normalizedRawPersona,
    tags: tags && tags.length > 0 ? tags : undefined,
    personaDisplayName: resolvedPersonaDisplayName,
    personaPath,
    mcpServers: resolvedMcpServers,
    provider: normalizedProvider.provider ?? inheritedProvider,
    providerSpecified: normalizedProvider.providerSpecified
      || (inheritedProvider !== undefined && !inheritedProviderIsWorkflowFallback),
    model: resolvedModel,
    modelSpecified: normalizedProvider.modelSpecified
      || inheritsDirectModel,
    promotion,
    requiredPermissionMode: step.required_permission_mode,
    providerOptions,
    directProviderOptions,
    workflowProviderOptions: inheritedWorkflowProviderOptions,
    capabilityProviderOptions: effectiveCapabilityOptions,
    edit: step.edit,
    allowGitCommit: step.allow_git_commit ?? inheritedAllowGitCommit ?? false,
    instruction: instruction || '{task}',
    instructionRef: step.instruction as string | undefined,
    delayBeforeMs: step.delay_before_ms,
    structuredOutput: normalizeStepField(stepPath, ['structured_output', 'schema_ref'], () => resolveStructuredOutput(step, workflowSchemas, {
      projectDir: context?.projectDir ?? workflowDir,
    })),
    rules,
    outputContracts: step.output_contracts?.report && step.output_contracts.report.length > 0
      ? step.output_contracts.report.map((entry, index) => normalizeStepField(
        stepPath,
        ['output_contracts', 'report', index],
        () => normalizeOutputContract(entry, (reference, field) => {
          const content = normalizeStepField(
            stepPath,
            ['output_contracts', 'report', index, field],
            () => resolveRefToContent(
              reference,
              sections.resolvedReportFormatsWithSource ?? sections.resolvedReportFormats,
              workflowDir,
              'output-contracts',
              context,
            ),
          );
          if (!content) {
            throw withWorkflowStepErrorPath(
              new Error(`Failed to resolve output contract ${field} "${reference}" for report "${entry.name}"`),
              [...stepPath, 'output_contracts', 'report', index, field],
            );
          }
          return content;
        }),
      ))
      : undefined,
    qualityGates,
    passPreviousResponse: step.pass_previous_response ?? true,
    policyContents,
    knowledgeContents,
    companion: step.companion as CompanionSelection | undefined,
  };

  // parallel 親の capabilities は sub-step の既定になる（sub-step 自身の宣言が置換する）。
  // 渡さないと、親が readonly を宣言していても無宣言の子が workflow 既定へ落ちて広くなる。
  const subStepWorkflowDefinitions = effectiveCapabilityOptions === undefined
    ? workflowDefinitions
    : { ...workflowDefinitions, capabilityOptions: effectiveCapabilityOptions };

  if (step.parallel && Array.isArray(step.parallel) && step.parallel.length > 0) {
    const normalizedStep: AgentWorkflowStep = {
      ...normalizedAgentFields,
      parallel: step.parallel.map((sub, index) =>
        normalizeStepFromRaw(
          sub,
          workflowDir,
          sections,
          workflowSchemas,
          [...stepPath, 'parallel', index],
          normalizedAgentFields.provider,
          normalizedAgentFields.model,
          normalizedAgentFields.modelSpecified,
          normalizedAgentFields.directProviderOptions,
          normalizedAgentFields.workflowProviderOptions,
          normalizedAgentFields.allowGitCommit,
          normalizedAgentFields.providerSpecified === false,
          normalizedAgentFields.modelSpecified === false,
          context,
          projectOverrides,
          globalOverrides,
          workflowArpeggioPolicy,
          workflowMcpServersPolicy,
          subStepWorkflowDefinitions,
        ),
      ),
      ...(step.concurrency != null ? { concurrency: step.concurrency } : {}),
    };
    return normalizedStep;
  }

  if (step.parallel && !Array.isArray(step.parallel)) {
    const normalizeDynamicSubStep = (
      sub: typeof step.parallel.fixed[number] | typeof step.parallel.pool[number],
      branch: 'fixed' | 'pool',
      index: number,
    ): DynamicParallelFixedSubStep => {
      const normalized = normalizeStepFromRaw(
      sub,
      workflowDir,
      sections,
      workflowSchemas,
      [...stepPath, 'parallel', branch, index],
      normalizedAgentFields.provider,
      normalizedAgentFields.model,
      normalizedAgentFields.modelSpecified,
      normalizedAgentFields.directProviderOptions,
      normalizedAgentFields.workflowProviderOptions,
      normalizedAgentFields.allowGitCommit,
      normalizedAgentFields.providerSpecified === false,
      normalizedAgentFields.modelSpecified === false,
      context,
      projectOverrides,
      globalOverrides,
      workflowArpeggioPolicy,
      workflowMcpServersPolicy,
      subStepWorkflowDefinitions,
      );
      return normalized as DynamicParallelFixedSubStep;
    };
    const fixed: DynamicParallelFixedSubStep[] = step.parallel.fixed.map(
      (sub, index) => normalizeDynamicSubStep(sub, 'fixed', index),
    );
    const pool: DynamicParallelPoolSubStep[] = step.parallel.pool.map((sub, index) => {
      const normalized = normalizeDynamicSubStep(sub, 'pool', index);
      return normalized as DynamicParallelPoolSubStep;
    });
    const parallel = {
      kind: 'dynamic' as const,
      fixed,
      pool,
      selection: step.parallel.selection,
    };
    return {
      ...normalizedAgentFields,
      parallel,
      ...(step.concurrency != null ? { concurrency: step.concurrency } : {}),
    };
  }

  const arpeggio = normalizeArpeggio(step.arpeggio, workflowDir);
  if (arpeggio) {
    return {
      ...normalizedAgentFields,
      arpeggio,
    };
  }

  const teamLeader = normalizeTeamLeader(step.team_leader, workflowDir, sections, stepPath, context);
  if (teamLeader) {
    return {
      ...normalizedAgentFields,
      teamLeader,
    };
  }

  return {
    ...normalizedAgentFields,
    session: step.session,
    dynamicFacets: normalizeDynamicFacets(step.dynamic_facets, stepPath),
  };
  } catch (error) {
    throw withWorkflowStepErrorPath(error, stepPath);
  }
}
