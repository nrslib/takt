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
import {
  MAX_COMPLETION_RETRY,
  type DynamicFacetsConfig,
  type CompletionRetryConfig,
  type SelectorGuidance,
  type StepProviderOptions,
  type WorkflowCallArgValue,
  type WorkflowStepKind,
} from '../../../core/models/workflow-types.js';
import type { CompanionSelection } from '../../../core/models/companion-types.js';
import { applyQualityGateOverrides } from './qualityGateOverrides.js';
import {
  type FacetResolutionContext,
  type WorkflowSections,
  extractPersonaDisplayName,
  isResourcePath,
  isScopeRef,
  resolvePersona,
  resolveRefListWithSource,
  resolveRefToContent,
  resolveSelectorInstruction,
} from './resource-resolver.js';
import { validateWorkflowArpeggio, validateWorkflowMcpServers } from './workflowNormalizationPolicies.js';
import { normalizeRule } from './workflowRuleNormalizer.js';
import { normalizeArpeggio, normalizeOutputContract, normalizeTeamLeader } from './workflowStepFeaturesNormalizer.js';
import { resolveStructuredOutput } from './workflowStructuredOutputResolver.js';
import { normalizeWorkflowEffects } from './workflowSystemStepNormalizer.js';
import { resolveCapabilitySets } from './capabilitySetResolver.js';
import { resolveWorkflowMcpReferences } from './workflowMcpReferenceResolver.js';
import type { McpServerConfig } from '../../../core/models/index.js';
import { isWorkflowParamReference } from './workflowCallableParamRef.js';
import { normalizeQualityGates } from '../configNormalizers.js';
import { withWorkflowConfigErrorPath as withWorkflowStepErrorPath } from '../../../core/workflow/workflow-config-error.js';

function normalizeCompletionRetry(
  step: z.input<typeof WorkflowStepRawSchema>,
  stepPath: readonly PropertyKey[],
  workflowDir: string,
  sections: WorkflowSections,
  context: FacetResolutionContext | undefined,
): CompletionRetryConfig | undefined {
  const raw = step.completion_retry;
  if (raw === undefined) {
    return undefined;
  }
  const retryInstructionRef = raw.retry_instruction;
  if (isWorkflowParamReference(retryInstructionRef)) {
    throw withWorkflowStepErrorPath(
      new Error(`Step "${step.name}" has unresolved $param in completion_retry.retry_instruction`),
      [...stepPath, 'completion_retry', 'retry_instruction'],
    );
  }
  const retryInstruction = normalizeStepField(
    stepPath,
    ['completion_retry', 'retry_instruction'],
    () => resolveRefToContent(
      retryInstructionRef,
      sections.resolvedInstructionsWithSource ?? sections.resolvedInstructions,
      workflowDir,
      'instructions',
      context,
    ),
  );
  if (retryInstruction === undefined) {
    throw withWorkflowStepErrorPath(
      new Error(`Failed to resolve completion retry instruction "${retryInstructionRef}"`),
      [...stepPath, 'completion_retry', 'retry_instruction'],
    );
  }
  return {
    minRetry: raw.min_retry ?? 0,
    maxRetry: raw.max_retry ?? MAX_COMPLETION_RETRY,
    retryInstruction,
  };
}

type RawStep = z.output<typeof WorkflowStepRawSchema>;
type RawSelectorGuidance = NonNullable<NonNullable<RawStep['dynamic_facets']>['selector']>;

/** Workflow-level inputs threaded down to every step so `capabilities:` / `mcp:` references resolve. */
export interface WorkflowLevelDefinitions {
  capabilityOptions?: StepProviderOptions;
  mcpServers?: Record<string, McpServerConfig>;
}

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

function normalizeDynamicFacets(
  raw: RawStep['dynamic_facets'],
  stepPath: readonly PropertyKey[],
  workflowDir: string,
  sections: WorkflowSections,
  context?: FacetResolutionContext,
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
    ...(raw.selector === undefined ? {} : {
      selector: normalizeSelectorGuidance(
        raw.selector,
        stepPath,
        ['dynamic_facets', 'selector'],
        workflowDir,
        sections,
        context,
      ),
    }),
  }));
}

function normalizeSelectorGuidance(
  raw: RawSelectorGuidance,
  stepPath: readonly PropertyKey[],
  selectorPath: readonly PropertyKey[],
  workflowDir: string,
  sections: WorkflowSections,
  context?: FacetResolutionContext,
): SelectorGuidance {
  const normalizedPersona = raw.persona === undefined
    ? undefined
    : normalizeStepField(stepPath, [...selectorPath, 'persona'], () => {
      if (typeof raw.persona !== 'string') {
        throw new Error('selector.persona has an unresolved parameter reference');
      }
      if (raw.persona.trim().length === 0) {
        throw new Error('selector.persona must not be empty');
      }
      const resolved = resolvePersona(raw.persona, sections, workflowDir, context);
      if (isScopeRef(raw.persona) && resolved.personaPath === undefined) {
        throw new Error(`selector.persona could not be resolved: ${raw.persona}`);
      }
      return resolved;
    });
  const instruction = normalizeStepField(stepPath, [...selectorPath, 'instruction'], () => {
    if (typeof raw.instruction !== 'string') {
      throw new Error('selector.instruction has an unresolved parameter reference');
    }
    const resolved = resolveSelectorInstruction(
      raw.instruction,
      sections.resolvedInstructionsWithSource ?? sections.resolvedInstructions,
      workflowDir,
      context,
    );
    if (resolved === undefined) {
      throw new Error(`selector.instruction could not be resolved: ${raw.instruction}`);
    }
    return resolved;
  });
  return {
    ...(normalizedPersona?.personaSpec === undefined ? {} : { persona: normalizedPersona.personaSpec }),
    ...(normalizedPersona?.personaPath === undefined ? {} : { personaPath: normalizedPersona.personaPath }),
    instruction,
  };
}

function normalizePromotionEntry(
  entry: NonNullable<RawStep['promotion']>[number],
): NonNullable<AgentWorkflowStep['promotion']>[number] {
  if (entry.at === undefined) {
    throw new Error('Configuration error: workflow promotion entry requires "at"');
  }
  return { at: entry.at };
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

const INSTRUCTION_COMPOSITION_SEPARATOR = '\n\n---\n\n';

function normalizeInstruction(
  rawInstruction: z.input<typeof WorkflowStepRawSchema>['instruction'],
  stepName: string,
  stepPath: readonly PropertyKey[],
  sections: WorkflowSections,
  workflowDir: string,
  context: FacetResolutionContext | undefined,
): string | undefined {
  if (rawInstruction === undefined) {
    return undefined;
  }
  const refs = Array.isArray(rawInstruction) ? rawInstruction : [rawInstruction];
  const contents = refs.map((ref, index) => normalizeStepField(
    stepPath,
    ['instruction', ...(Array.isArray(rawInstruction) ? [index] : [])],
    () => {
      if (isWorkflowParamReference(ref)) {
        throw new Error(`Step "${stepName}" has unresolved $param in instruction`);
      }
      const resolved = resolveRefToContent(
        ref,
        sections.resolvedInstructionsWithSource ?? sections.resolvedInstructions,
        workflowDir,
        'instructions',
        context,
      );
      if (resolved === undefined) {
        throw new Error(`Failed to resolve instruction "${ref}"`);
      }
      return resolved;
    },
  ));
  return Array.isArray(rawInstruction)
    ? contents.join(INSTRUCTION_COMPOSITION_SEPARATOR)
    : contents[0];
}

function preserveInstructionRef(
  rawInstruction: z.output<typeof WorkflowStepRawSchema>['instruction'],
  stepName: string,
  stepPath: readonly PropertyKey[],
): string | string[] | undefined {
  return normalizeStepField(stepPath, ['instruction'], () => {
    if (rawInstruction === undefined) {
      return undefined;
    }
    const refs = Array.isArray(rawInstruction) ? rawInstruction : [rawInstruction];
    const stringRefs = refs.map((ref) => {
      if (isWorkflowParamReference(ref)) {
        throw new Error(`Step "${stepName}" has unresolved $param in instruction`);
      }
      return ref;
    });
    return Array.isArray(rawInstruction) ? stringRefs : stringRefs[0];
  });
}

export function normalizeStepFromRaw(
  step: RawStep,
  workflowDir: string,
  sections: WorkflowSections,
  workflowSchemas: Record<string, string> | undefined,
  stepPath: readonly PropertyKey[],
  inheritedAllowGitCommit?: boolean,
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
  const promotion = step.promotion?.map((entry, index) => normalizeStepField(
    stepPath,
    ['promotion', index],
    () => normalizePromotionEntry(entry),
  ));
  const instruction = isSystemStep || isWorkflowCallStep
    ? undefined
    : normalizeInstruction(
      step.instruction,
      step.name,
      stepPath,
      sections,
      workflowDir,
      context,
    );
  const completionRetry = normalizeCompletionRetry(
    step,
    stepPath,
    workflowDir,
    sections,
    context,
  );
  const instructionRef = isSystemStep || isWorkflowCallStep
    ? undefined
    : preserveInstructionRef(step.instruction, step.name, stepPath);

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
      args: normalizeStepField(stepPath, ['args'], () => normalizeWorkflowCallArgs(step.name, step.args)),
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

  // A step's own `capabilities:` replaces the workflow default rather than merging. Capability
  // options remain a separate layer from runtime profile options and never become a direct
  // provider assignment.
  const stepCapabilityOptions = step.capabilities !== undefined
    ? normalizeStepField(stepPath, ['capabilities'], () => resolveCapabilitySets(step.capabilities!, workflowDir, context))
    : undefined;
  const effectiveCapabilityOptions = stepCapabilityOptions ?? workflowDefinitions?.capabilityOptions;
  const companion = normalizeStepField(stepPath, ['companion'], () => {
    if (isWorkflowParamReference(step.companion)) {
      throw new Error(`Step "${step.name}" has unresolved $param in companion`);
    }
    return step.companion as CompanionSelection | undefined;
  });

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
    promotion,
    requiredPermissionMode: step.required_permission_mode,
    capabilityProviderOptions: effectiveCapabilityOptions,
    edit: step.edit,
    allowGitCommit: step.allow_git_commit ?? inheritedAllowGitCommit ?? false,
    instruction: instruction || '{task}',
    instructionRef,
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
    companion,
    completionRetry,
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
          normalizedAgentFields.allowGitCommit,
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
      normalizedAgentFields.allowGitCommit,
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
      selection: {
        mode: step.parallel.selection.mode,
        ...(step.parallel.selection.reports === undefined ? {} : {
          reports: [...step.parallel.selection.reports],
        }),
        ...(step.parallel.selection.selector === undefined ? {} : {
          selector: normalizeSelectorGuidance(
            step.parallel.selection.selector,
            stepPath,
            ['parallel', 'selection', 'selector'],
            workflowDir,
            sections,
            context,
          ),
        }),
      },
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
  const dynamicFacets = normalizeDynamicFacets(step.dynamic_facets, stepPath, workflowDir, sections, context);
  if (teamLeader) {
    return {
      ...normalizedAgentFields,
      teamLeader,
      dynamicFacets,
    };
  }

  return {
    ...normalizedAgentFields,
    session: step.session,
    dynamicFacets,
  };
  } catch (error) {
    throw withWorkflowStepErrorPath(error, stepPath);
  }
}
