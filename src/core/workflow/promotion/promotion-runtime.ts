import type { StructuredCaller } from '../../../agents/structured-caller.js';
import type { RunAgentOptions } from '../../../agents/runner.js';
import type { AgentWorkflowStep, WorkflowStep } from '../../models/types.js';
import type { ProviderLadderConfig, ProviderRoutingEntry, TagRoutingConflictPolicy } from '../../models/config-types.js';
import type { ProviderResolutionSource } from '../provider-options-trace.js';
import type { RuntimeStepResolution, StepProviderInfo } from '../types.js';
import { isDelegatedWorkflowStep } from '../step-kind.js';
import { applyProviderModelOverride, assertTagMatchesAgree, tagRoutingEntryIdentity } from '../provider-resolution.js';
import { countMatchedLadderStages, evaluatePromotion, isTargetedPromotionEntry } from './PromotionEvaluator.js';
import {
  isFilePreferredProviderOptionPath,
  mergeProviderOptions,
  PROVIDER_OPTION_PATHS,
} from '../../../infra/config/providerOptions.js';
import { createLogger } from '../../../shared/utils/index.js';
import { resolveWorkflowStepTarget } from '../provider-target-resolution.js';

const log = createLogger('workflow-promotion');

export interface PromotionRuntimeContext {
  cwd: string;
  previousResponseContent: string;
  structuredCaller?: StructuredCaller;
  childProcessEnv?: RunAgentOptions['childProcessEnv'];
  resolveStepProviderModel: (step: WorkflowStep, runtime?: RuntimeStepResolution) => StepProviderInfo;
  /**
   * Fully-resolved runtime.yaml `ladder` stages (issue #1208). A matched target-less `{at:N}`
   * promotion advances the governing ladder to a later stage. Undefined when no ladder is
   * configured, in which case a target-less promotion is a logged no-op.
   */
  providerLadders?: ProviderLadderConfig;
  /**
   * The same `tags` conflict policy the base resolution applies. A ladder selected off
   * `provider_routing.tags` must judge equal-priority conflicts identically to stage 0.
   */
  providerRoutingTagConflictPolicy?: TagRoutingConflictPolicy;
}

function isPromotionStep(step: WorkflowStep): step is AgentWorkflowStep {
  return step.kind !== 'system' && step.kind !== 'workflow_call';
}

function getProviderOptionValue(options: StepProviderInfo['providerOptions'], path: string): unknown {
  if (!options) return undefined;
  return path.split('.').reduce<unknown>((current, part) => {
    if (current === undefined || current === null || typeof current !== 'object') {
      return undefined;
    }
    return (current as Record<string, unknown>)[part];
  }, options);
}

function setProviderOptionValue(
  options: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const parts = path.split('.');
  let current = options;
  for (const part of parts.slice(0, -1)) {
    const next = current[part];
    if (next === undefined || next === null || typeof next !== 'object' || Array.isArray(next)) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]!] = value;
}

function filterPromotionProviderOptions(
  baseSources: StepProviderInfo['providerOptionsSources'],
  promotionOptions: StepProviderInfo['providerOptions'],
): StepProviderInfo['providerOptions'] {
  if (!promotionOptions) {
    return undefined;
  }

  const result: Record<string, unknown> = {};
  for (const path of PROVIDER_OPTION_PATHS) {
    const value = getProviderOptionValue(promotionOptions, path);
    if (value === undefined) {
      continue;
    }
    const baseSource = baseSources?.[path];
    if (
      !isFilePreferredProviderOptionPath(path)
      && (baseSource === 'env' || baseSource === 'cli')
    ) {
      continue;
    }
    setProviderOptionValue(result, path, value);
  }

  return Object.keys(result).length > 0
    ? result as StepProviderInfo['providerOptions']
    : undefined;
}

function resolvePromotionProviderOptionsSources(
  baseSources: StepProviderInfo['providerOptionsSources'],
  promotionOptions: StepProviderInfo['providerOptions'],
): StepProviderInfo['providerOptionsSources'] {
  if (!promotionOptions) {
    return baseSources;
  }

  const sources: Record<string, NonNullable<StepProviderInfo['providerOptionsSources']>[string]> = {
    ...baseSources,
  };
  for (const path of PROVIDER_OPTION_PATHS) {
    if (getProviderOptionValue(promotionOptions, path) !== undefined) {
      sources[path] = 'promotion';
    }
  }
  return Object.keys(sources).length > 0 ? sources : undefined;
}

export async function resolvePromotionRuntime(
  context: PromotionRuntimeContext,
  step: WorkflowStep,
  stepIteration: number | undefined,
  runtime: RuntimeStepResolution | undefined,
): Promise<RuntimeStepResolution | undefined> {
  if (!isPromotionStep(step) || !step.promotion || step.promotion.length === 0) {
    return runtime;
  }
  if (isDelegatedWorkflowStep(step)) {
    throw new Error(`Step "${step.name}" promotion is only supported for normal agent steps`);
  }
  if (stepIteration === undefined) {
    throw new Error(`Step "${step.name}" promotion requires a normal agent step execution`);
  }

  const baseProviderInfo = context.resolveStepProviderModel(step, runtime);
  const promotion = await evaluatePromotion(step, {
    cwd: context.cwd,
    stepIteration,
    previousResponseContent: context.previousResponseContent,
    structuredCaller: context.structuredCaller,
    resolvedProvider: baseProviderInfo.provider,
    resolvedModel: baseProviderInfo.model,
    resolvedProviderOptions: baseProviderInfo.providerOptions,
    permissionMode: baseProviderInfo.permissionMode,
    childProcessEnv: context.childProcessEnv,
  });

  if (promotion !== undefined && isTargetedPromotionEntry(promotion)) {
    return applyPromotionTarget(runtime, baseProviderInfo, {
      provider: promotion.provider,
      providerSpecified: promotion.providerSpecified === true || promotion.provider !== undefined,
      model: promotion.model,
      modelSpecified: promotion.model !== undefined,
      providerOptions: promotion.providerOptions,
      permissionMode: undefined,
    });
  }

  // Target-less `{at:N}` promotion: advance the governing runtime.yaml `ladder` (issue #1208). The
  // matched `{at}` count is the stage index; stage 0 is already the current assignment.
  const stageIndex = countMatchedLadderStages(step, stepIteration);
  if (stageIndex === 0) {
    return runtime;
  }
  const ladder = resolveGoverningLadder(
    context.providerLadders,
    step,
    baseProviderInfo.providerSource,
    context.providerRoutingTagConflictPolicy,
  );
  if (ladder === undefined) {
    // INV-B: a profile/pool direct assignment records no governing ladder, so a target-less
    // promotion has nothing to advance and stays at the base assignment (INV-3 no-op). Surfaced as
    // a warning — not a debug log — so a runtime.yaml that silently disables an existing promotion
    // is visible.
    log.warn(
      `Promotion for step "${step.name}" requested ladder stage ${stageIndex} but no ladder governs its assignment; keeping the current provider/model`,
    );
    return runtime;
  }
  // Promotion is a monotonic escalation. A stage index past the ladder end has no further stage to
  // apply, so keep the terminal stage rather than downgrading toward the base assignment. The
  // exhausted depth is still surfaced as a warning — not a debug log — so a ladder that cannot
  // satisfy the requested promotion depth is visible.
  const isPastLadderEnd = stageIndex >= ladder.length;
  if (isPastLadderEnd) {
    log.warn(
      `Promotion for step "${step.name}" requested ladder stage ${stageIndex} but the ladder ends at stage ${ladder.length - 1}; keeping the terminal stage`,
    );
  }
  const stageEntry = ladder[isPastLadderEnd ? ladder.length - 1 : stageIndex] as ProviderRoutingEntry;
  return applyPromotionTarget(runtime, baseProviderInfo, {
    provider: stageEntry.provider,
    providerSpecified: stageEntry.provider !== undefined,
    model: stageEntry.model,
    modelSpecified: stageEntry.model !== undefined,
    providerOptions: stageEntry.providerOptions,
    permissionMode: stageEntry.permissionMode,
  });
}

interface PromotionTarget {
  provider: StepProviderInfo['provider'];
  providerSpecified: boolean;
  model: StepProviderInfo['model'];
  modelSpecified: boolean;
  providerOptions: StepProviderInfo['providerOptions'];
  permissionMode: StepProviderInfo['permissionMode'];
}

/** Apply a resolved promotion target (targeted entry or ladder stage) onto the base resolution. */
function applyPromotionTarget(
  runtime: RuntimeStepResolution | undefined,
  baseProviderInfo: StepProviderInfo,
  target: PromotionTarget,
): RuntimeStepResolution {
  const promotionProviderOptions = filterPromotionProviderOptions(
    baseProviderInfo.providerOptionsSources,
    target.providerOptions,
  );
  const promotedProviderInfo = applyProviderModelOverride(baseProviderInfo, {
    provider: target.provider,
    providerSpecified: target.providerSpecified,
    model: target.model,
    modelSpecified: target.modelSpecified,
    source: 'promotion',
  });
  return {
    ...runtime,
    providerInfo: {
      ...promotedProviderInfo,
      providerOptions: mergeProviderOptions(baseProviderInfo.providerOptions, promotionProviderOptions),
      providerOptionsSources: resolvePromotionProviderOptionsSources(
        baseProviderInfo.providerOptionsSources,
        promotionProviderOptions,
      ),
      ...(target.providerSpecified
        ? { permissionMode: target.permissionMode }
        : {}),
    },
  };
}

/**
 * Resolve the ladder that governs this step's promotion. The base resolution already picked the
 * initial assignment (stage 0) at a definite priority; its source tells us which assignment path
 * — and therefore which ladder — to advance, so promotion continues the same ladder rather than
 * jumping to an unrelated one.
 */
function resolveGoverningLadder(
  ladders: ProviderLadderConfig | undefined,
  step: AgentWorkflowStep,
  baseSource: ProviderResolutionSource | undefined,
  tagConflictPolicy: TagRoutingConflictPolicy | undefined,
): ProviderRoutingEntry[] | undefined {
  if (ladders === undefined) {
    return undefined;
  }
  switch (baseSource) {
    case 'provider_routing.steps':
      return resolveWorkflowStepTarget(ladders.steps, step.name, ladders.workflowName);
    case 'provider_routing.tags':
      return resolveTagLadder(ladders.tags, step.tags, tagConflictPolicy);
    // runtime.yaml `targets.personas` compiles into `personaProviders`, not
    // `providerRouting.personas` (environment.ts), so `persona_providers` is the source a runtime
    // persona ladder resolves under. `provider_routing.personas` only ever comes from config.yaml,
    // which is a legacy signal — it cannot coexist with the runtime.yaml that produces ladders.
    case 'persona_providers':
      return ladders.personas?.[step.personaDisplayName];
    case 'runtime-v1':
      return ladders.defaults;
    default:
      return undefined;
  }
}

/**
 * Mirror the tag routing merge: the last matched tag that carries a ladder governs. The conflict
 * judgment is shared with the base resolution — deciding it here on its own would let stage 0
 * fail fast on an input whose later stages silently picked a winner.
 */
function resolveTagLadder(
  tags: Record<string, ProviderRoutingEntry[]> | undefined,
  stepTags: readonly string[] | undefined,
  conflictPolicy: TagRoutingConflictPolicy | undefined,
): ProviderRoutingEntry[] | undefined {
  if (tags === undefined || stepTags === undefined) {
    return undefined;
  }
  const matched = stepTags.flatMap((tag) => {
    const ladder = tags[tag];
    return ladder === undefined ? [] : [{ tag, ladder }];
  });
  const governing = matched[matched.length - 1];
  if (governing === undefined) {
    return undefined;
  }
  assertTagMatchesAgree(
    // A ladder is one assignment, so its identity is the ordered identity of every stage.
    matched.map(({ tag, ladder }) => ({ tag, identity: ladder.map(tagRoutingEntryIdentity).join('|') })),
    conflictPolicy,
    'provider ladders',
  );
  return governing.ladder;
}
