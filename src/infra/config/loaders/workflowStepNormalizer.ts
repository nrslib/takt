import type { z } from 'zod';
import type {
  AgentWorkflowStep,
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
} from '../../../core/models/workflow-types.js';
import { applyQualityGateOverrides } from './qualityGateOverrides.js';
import {
  type FacetResolutionContext,
  type WorkflowSections,
  extractPersonaDisplayName,
  isResourcePath,
  resolvePersona,
  resolveRefList,
  resolveRefToContent,
} from './resource-resolver.js';
import { mergeProviderOptions } from '../providerOptions.js';
import { normalizeProviderBlockOptions } from '../providerBlockOptions.js';
import type { ConfigProviderReference } from '../providerReference.js';
import { validateWorkflowArpeggio, validateWorkflowMcpServers } from './workflowNormalizationPolicies.js';
import { normalizeRule } from './workflowRuleNormalizer.js';
import { normalizeArpeggio, normalizeOutputContracts, normalizeTeamLeader } from './workflowStepFeaturesNormalizer.js';
import { resolveStructuredOutput } from './workflowStructuredOutputResolver.js';
import { normalizeWorkflowEffects } from './workflowSystemStepNormalizer.js';
import { parseAiConditionExpression } from '../../../core/models/workflow-condition-expression.js';
import { resolveWorkflowProviderOptions } from './workflowProviderOptionsResolver.js';
import { isWorkflowParamReference } from './workflowCallableParamRef.js';
import { normalizeQualityGates } from '../configNormalizers.js';

type RawStep = z.output<typeof WorkflowStepRawSchema>;
type RawProviderReference = RawStep['provider'];
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

function normalizePromotionEntry(
  entry: RawPromotionEntry,
  workflowDir: string,
  context?: FacetResolutionContext,
): NonNullable<AgentWorkflowStep['promotion']>[number] {
  const normalizedProvider = normalizeProviderReference(
    entry.provider,
    entry.model,
    entry.provider_options,
    workflowDir,
    context,
  );
  const aiExpression = entry.condition !== undefined
    ? parseAiConditionExpression(entry.condition)
    : undefined;
  if (
    entry.provider === undefined
    && entry.model === undefined
    && normalizedProvider.providerOptions === undefined
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

function normalizePromotionEntries(
  entries: RawStep['promotion'],
  workflowDir: string,
  context?: FacetResolutionContext,
): AgentWorkflowStep['promotion'] {
  return entries?.map((entry) => normalizePromotionEntry(entry, workflowDir, context));
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

export function normalizeStepFromRaw(
  step: RawStep,
  workflowDir: string,
  sections: WorkflowSections,
  workflowSchemas: Record<string, string> | undefined,
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
): WorkflowStep {
  const rules = step.rules?.map(normalizeRule);
  const kind: WorkflowStepKind = getWorkflowStepKind(step);
  const isSystemStep = kind === 'system';
  const isWorkflowCallStep = kind === 'workflow_call';
  const rawPersona = (step as Record<string, unknown>).persona as string | undefined;
  if (rawPersona !== undefined && rawPersona.trim().length === 0) {
    throw new Error(`Step "${step.name}" has an empty persona value`);
  }
  const { personaSpec, personaPath } = isSystemStep || isWorkflowCallStep
    ? { personaSpec: undefined, personaPath: undefined }
    : resolvePersona(rawPersona, sections, workflowDir, context);
  const displayNameRaw = (step as Record<string, unknown>).persona_name as string | undefined;
  if (displayNameRaw !== undefined && displayNameRaw.trim().length === 0) {
    throw new Error(`Step "${step.name}" has an empty persona_name value`);
  }
  const derivedPersonaName = personaSpec ? extractPersonaDisplayName(personaSpec) : undefined;
  const resolvedPersonaDisplayName = isSystemStep || isWorkflowCallStep
    ? step.name
    : displayNameRaw || derivedPersonaName || step.name;
  const normalizedRawPersona = rawPersona?.trim();
  const personaOverrideKey = normalizedRawPersona
    ? (isResourcePath(normalizedRawPersona) ? extractPersonaDisplayName(normalizedRawPersona) : normalizedRawPersona)
    : undefined;
  const tags = step.tags?.map((tag) => {
    const normalizedTag = tag.trim();
    if (normalizedTag.length === 0) {
      throw new Error(`Step "${step.name}" has an empty tags entry`);
    }
    return normalizedTag;
  });

  const policyContents = isSystemStep || isWorkflowCallStep
    ? undefined
    : resolveRefList(
      (step as Record<string, unknown>).policy as string | string[] | undefined,
      sections.resolvedPoliciesWithSource ?? sections.resolvedPolicies,
      workflowDir,
      'policies',
      context,
    );
  const knowledgeContents = isSystemStep || isWorkflowCallStep
    ? undefined
    : resolveRefList(
      (step as Record<string, unknown>).knowledge as string | string[] | undefined,
      sections.resolvedKnowledgeWithSource ?? sections.resolvedKnowledge,
      workflowDir,
      'knowledge',
      context,
  );
  const normalizedProvider = normalizeProviderReference(step.provider, step.model, step.provider_options, workflowDir, context);
  const promotion = normalizePromotionEntries(step.promotion, workflowDir, context);
  const normalizedOverrides = step.overrides
    ? normalizeProviderReference(step.overrides.provider, step.overrides.model, step.overrides.provider_options, workflowDir, context)
    : undefined;
  if (normalizedOverrides !== undefined) {
    validateWorkflowCallOverrides(normalizedOverrides);
  }
  const instruction = isSystemStep || isWorkflowCallStep
    ? undefined
    : step.instruction
    ? resolveRefToContent(
        step.instruction as string,
        sections.resolvedInstructionsWithSource ?? sections.resolvedInstructions,
        workflowDir,
        'instructions',
        context,
      )
    : undefined;

  validateWorkflowArpeggio(step.name, step.arpeggio, workflowArpeggioPolicy);
  validateWorkflowMcpServers(step.name, step.mcp_servers, workflowMcpServersPolicy);

  if (isWorkflowCallStep) {
    const normalizedStep: WorkflowCallStep = {
      name: step.name,
      description: step.description,
      kind: 'workflow_call',
      call: step.call!,
      overrides: normalizedOverrides
        ? {
            provider: normalizedOverrides.provider,
            model: normalizedOverrides.model,
            providerOptions: normalizedOverrides.providerOptions,
          }
        : undefined,
      args: normalizeWorkflowCallArgs(step.name, step.args),
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

  const qualityGates = applyQualityGateOverrides(
    step.name,
    normalizeQualityGates(step.quality_gates),
    step.edit,
    personaOverrideKey,
    projectOverrides,
    globalOverrides,
  );

  const directProviderOptions = mergeProviderOptions(inheritedDirectProviderOptions, normalizedProvider.providerOptions);
  const providerOptions = mergeProviderOptions(inheritedWorkflowProviderOptions, directProviderOptions);
  const resolvedModel = normalizedProvider.modelSpecified
    ? normalizedProvider.model
    : (normalizedProvider.providerSpecified ? undefined : inheritedModel);
  const inheritsDirectModel = inheritedModelSpecified
    && !inheritedModelIsWorkflowFallback
    && !normalizedProvider.providerSpecified;

  const normalizedAgentFields: Omit<
    NormalAgentWorkflowStep,
    'session' | 'parallel' | 'concurrency' | 'arpeggio' | 'teamLeader'
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
    mcpServers: step.mcp_servers,
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
    edit: step.edit,
    allowGitCommit: step.allow_git_commit ?? inheritedAllowGitCommit ?? false,
    instruction: instruction || '{task}',
    delayBeforeMs: step.delay_before_ms,
    structuredOutput: resolveStructuredOutput(step, workflowSchemas, {
      projectDir: context?.projectDir ?? workflowDir,
    }),
    rules,
    outputContracts: normalizeOutputContracts(
      step.output_contracts,
      workflowDir,
      sections.resolvedReportFormatsWithSource ?? sections.resolvedReportFormats,
      context,
    ),
    qualityGates,
    passPreviousResponse: step.pass_previous_response ?? true,
    policyContents,
    knowledgeContents,
  };

  if (step.parallel && step.parallel.length > 0) {
    const normalizedStep: AgentWorkflowStep = {
      ...normalizedAgentFields,
      parallel: step.parallel.map((sub) =>
        normalizeStepFromRaw(
          sub,
          workflowDir,
          sections,
          workflowSchemas,
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
        ),
      ),
      ...(step.concurrency != null ? { concurrency: step.concurrency } : {}),
    };
    return normalizedStep;
  }

  const arpeggio = normalizeArpeggio(step.arpeggio, workflowDir);
  if (arpeggio) {
    return {
      ...normalizedAgentFields,
      arpeggio,
    };
  }

  const teamLeader = normalizeTeamLeader(step.team_leader, workflowDir, sections, context);
  if (teamLeader) {
    return {
      ...normalizedAgentFields,
      teamLeader,
    };
  }

  return {
    ...normalizedAgentFields,
    session: step.session,
  };
}
