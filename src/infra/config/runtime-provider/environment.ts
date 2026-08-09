/**
 * Provider-environment compilation for the two configuration formats (issue #1136).
 *
 * The engine consumes a format-agnostic bundle of provider engine-options
 * (`provider` / `model` / `personaProviders` / `providerRouting` / `autoRouting` /
 * `providerOptions` / `internalAgents`). This module is the anti-corruption boundary that
 * compiles either configuration format into that single bundle, so executor / runner /
 * provider SDK never branch on the format:
 *
 * - `LegacyProviderPolicyCompiler` reuses the values the bootstrap already assembled from
 *   `config.yaml` + workflow + CLI, unchanged (byte-identical legacy behavior).
 * - `RuntimeProviderPolicyCompiler` maps a validated `runtime.yaml` `provider` section into
 *   the same bundle: profile `options` become provider-specific options, `pool` assignments and
 *   the `auto_routing` section become an `AutoRoutingConfig`, and `internal_agents` targets
 *   become the `internalAgents` bundle entry consumed by the selector/assistant seams.
 *
 * The configuration format is loaded as a discriminated union and a single factory
 * (`compileProviderEnvironment`) selects the matching compiler.
 */

import type { ProviderType } from '../../../shared/types/provider.js';
import type {
  AutoRoutingCandidate,
  AutoRoutingConfig,
  AutoRoutingStrategy,
  InternalAgentSeats,
  PersonaProviderEntry,
  ProviderEscalationTarget,
  ProviderLadderConfig,
  ProviderRoutingConfig,
  ProviderRoutingEntry,
  RoutingTier,
  TagRoutingConflictPolicy,
  TaktProvidersConfig,
} from '../../../core/models/config-types.js';
import type { StepProviderOptions } from '../../../core/models/workflow-types.js';
import type { ProviderResolutionSource } from '../../../core/workflow/provider-options-trace.js';
import { normalizeProviderOptions } from '../providerOptions.js';
import { validateRuntimeProviderSection, flattenProfiles, type FlatProfile } from './policy.js';
import type {
  RuntimeCompanionProviderAssignment,
  RuntimeProviderAssignment,
  RuntimeProviderSection,
} from './schema.js';

/**
 * Provider/model/options resolved for the internal agents. The seat set is defined once in
 * `core/models/config-types.ts` so the compiler and the engine consumers cannot drift apart.
 */
export type InternalAgentEnvironment = InternalAgentSeats;

/** Format-agnostic provider engine-options bundle consumed by the engine. */
export interface CompiledProviderEnvironment {
  provider: ProviderType | undefined;
  providerSource: ProviderResolutionSource;
  model: string | undefined;
  modelSource: ProviderResolutionSource;
  personaProviders: Record<string, PersonaProviderEntry> | undefined;
  providerRouting: ProviderRoutingConfig | undefined;
  autoRouting: AutoRoutingConfig | undefined;
  providerOptions: StepProviderOptions | undefined;
  /**
   * `escalate` target of the profile behind `defaults`. Steps that resolve their provider from
   * this layer inherit it; steps resolved by a target entry carry the entry's own escalation.
   */
  escalation: ProviderEscalationTarget | undefined;
  /**
   * How the engine resolves same-priority tag routing conflicts. Carried on the bundle (not
   * derived from the format at the seam) so executor/runner/SDK act on a policy, never on
   * "is this runtime-v1".
   */
  tagConflictPolicy: TagRoutingConflictPolicy;
  /**
   * Provider/model/options for the internal selector/assistant agents. Undefined in legacy
   * mode (those seams keep resolving `taktProviders`); set in runtime-v1 mode so the selector
   * and assistant seams resolve the runtime.yaml `targets.internal_agents` ladder.
   */
  internalAgents: InternalAgentEnvironment | undefined;
  companions?: Record<string, ProviderRoutingEntry>;
  /**
   * Every stage of each `ladder` assignment (issue #1208), so the promotion seam can advance a
   * matched target-less `{at:N}` to a later stage. Stage 0 is the initial assignment already
   * carried by provider/model/personaProviders/providerRouting; only the later stages are new
   * information. Undefined in legacy mode and when no assignment uses a `ladder`. `internal_agents`
   * ladders are intentionally excluded — those seats are not promotion targets.
   */
  providerLadders: ProviderLadderConfig | undefined;
}

/** The exact provider engine-options the legacy bootstrap already resolved. */
export interface LegacyProviderEnvironmentInput {
  provider: ProviderType | undefined;
  providerSource: ProviderResolutionSource;
  model: string | undefined;
  modelSource: ProviderResolutionSource;
  personaProviders: Record<string, PersonaProviderEntry> | undefined;
  providerRouting: ProviderRoutingConfig | undefined;
  autoRouting: AutoRoutingConfig | undefined;
  providerOptions: StepProviderOptions | undefined;
  /**
   * `takt_providers` provider assignments explicitly written to project/global `config.yaml`.
   * order.md lists a `takt_providers` provider indication among the legacy settings that must not
   * coexist with an active runtime.yaml section, so it participates in mixed-config detection.
   */
  taktProviders?: TaktProvidersConfig;
}

export type ProviderConfigModel =
  | { kind: 'legacy'; legacy: LegacyProviderEnvironmentInput }
  | { kind: 'runtime-v1'; section: RuntimeProviderSection };

/** Factory/registry: pick the matching compiler for the loaded configuration format. */
export function compileProviderEnvironment(
  model: ProviderConfigModel,
): CompiledProviderEnvironment {
  switch (model.kind) {
    case 'legacy':
      return compileLegacyProviderEnvironment(model.legacy);
    case 'runtime-v1':
      return compileRuntimeProviderEnvironment(model.section);
  }
}

/** LegacyProviderPolicyCompiler: pass the already-resolved legacy engine-options through unchanged. */
export function compileLegacyProviderEnvironment(
  legacy: LegacyProviderEnvironmentInput,
): CompiledProviderEnvironment {
  return {
    provider: legacy.provider,
    providerSource: legacy.providerSource,
    model: legacy.model,
    modelSource: legacy.modelSource,
    personaProviders: legacy.personaProviders,
    providerRouting: legacy.providerRouting,
    autoRouting: legacy.autoRouting,
    providerOptions: legacy.providerOptions,
    escalation: undefined,
    tagConflictPolicy: 'last-wins',
    internalAgents: undefined,
    providerLadders: undefined,
  };
}

/**
 * RuntimeProviderPolicyCompiler: map a validated runtime.yaml `provider` section into the
 * shared engine-options bundle. Profile `options`, `pool`/`auto_routing`, and `internal_agents`
 * are all compiled into the bundle here; nothing is left unwired.
 */
export function compileRuntimeProviderEnvironment(
  section: RuntimeProviderSection,
): CompiledProviderEnvironment {
  // Reuse the runtime section's up-front validation: unknown profile/pool references,
  // cyclic `extends`, and profiles missing provider/model all throw here.
  validateRuntimeProviderSection(section);

  const flatProfiles = flattenProfiles(section.profiles ?? {});

  const defaultProfile = initialAssignmentProfile(section.defaults);
  const defaults = defaultProfile !== undefined
    ? resolveProfileEntry(defaultProfile, flatProfiles)
    : undefined;
  const personaProviders = mapTargetEntries(section.targets?.personas, flatProfiles);
  const providerRouting = buildProviderRouting(section, flatProfiles);
  const autoRouting = buildAutoRoutingConfig(section, flatProfiles);
  const internalAgents = buildInternalAgents(section.targets?.internal_agents, flatProfiles);
  const companions = buildCompanions(section.targets?.companions, flatProfiles);
  const providerLadders = buildProviderLadders(section, flatProfiles);

  return {
    provider: defaults?.provider,
    providerSource: 'runtime-v1',
    model: defaults?.model,
    modelSource: 'runtime-v1',
    personaProviders,
    providerRouting,
    autoRouting,
    providerOptions: defaults?.providerOptions,
    escalation: defaults?.escalation,
    tagConflictPolicy: 'fail-fast',
    internalAgents,
    ...(companions === undefined ? {} : { companions }),
    providerLadders,
  };
}

function buildCompanions(
  map: Record<string, RuntimeCompanionProviderAssignment> | undefined,
  flatProfiles: Map<string, FlatProfile>,
): Record<string, ProviderRoutingEntry> | undefined {
  if (map === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(map).map(([name, assignment]) => [
      name,
      resolveProfileEntry(assignment.profile, flatProfiles),
    ]),
  );
}

/**
 * Resolve every stage of each `ladder` assignment into `ProviderRoutingEntry[]`, keyed by the
 * same assignment paths (`defaults` / `targets.steps` / `targets.tags` / `targets.personas`)
 * that carry the stage-0 initial assignment. Profile/pool assignments contribute nothing (they
 * have no later stages), and `internal_agents` is excluded — those seats are not promotion
 * targets. Returns undefined when no assignment uses a `ladder`, so non-ladder runtimes stay
 * unaffected.
 */
function buildProviderLadders(
  section: RuntimeProviderSection,
  flatProfiles: Map<string, FlatProfile>,
): ProviderLadderConfig | undefined {
  const defaults = section.defaults?.ladder !== undefined
    ? resolveLadderStages(section.defaults.ladder, flatProfiles)
    : undefined;
  const steps = mapLadderEntries(section.targets?.steps, flatProfiles);
  const tags = mapLadderEntries(section.targets?.tags, flatProfiles);
  const personas = mapLadderEntries(section.targets?.personas, flatProfiles);
  if (defaults === undefined && steps === undefined && tags === undefined && personas === undefined) {
    return undefined;
  }
  return {
    ...(defaults !== undefined ? { defaults } : {}),
    ...(steps !== undefined ? { steps } : {}),
    ...(tags !== undefined ? { tags } : {}),
    ...(personas !== undefined ? { personas } : {}),
  };
}

function mapLadderEntries(
  map: Record<string, RuntimeProviderAssignment> | undefined,
  flatProfiles: Map<string, FlatProfile>,
): Record<string, ProviderRoutingEntry[]> | undefined {
  if (map === undefined) {
    return undefined;
  }
  const result: Record<string, ProviderRoutingEntry[]> = {};
  for (const [key, assignment] of Object.entries(map)) {
    if (assignment.ladder === undefined) {
      continue;
    }
    result[key] = resolveLadderStages(assignment.ladder, flatProfiles);
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function resolveLadderStages(
  ladder: readonly string[],
  flatProfiles: Map<string, FlatProfile>,
): ProviderRoutingEntry[] {
  return ladder.map((profileName) => resolveProfileEntry(profileName, flatProfiles));
}

/**
 * The profile that becomes the initial routing assignment for an assignment slot: a fixed
 * `profile`, or (issue #1208) a `ladder`'s first stage. Returns undefined for a `pool`
 * assignment (routed through auto_routing, not the fixed routing map) or an empty slot, so the
 * three consumers (defaults / targets / internal_agents) resolve the initial stage identically.
 */
function initialAssignmentProfile(
  assignment: RuntimeProviderAssignment | undefined,
): string | undefined {
  return assignment?.profile ?? assignment?.ladder?.[0];
}

function mapTargetEntries(
  map: Record<string, RuntimeProviderAssignment> | undefined,
  flatProfiles: Map<string, FlatProfile>,
): Record<string, ProviderRoutingEntry> | undefined {
  if (map === undefined) {
    return undefined;
  }
  const result: Record<string, ProviderRoutingEntry> = {};
  for (const [key, assignment] of Object.entries(map)) {
    // `pool` assignments route through auto_routing (poolRules), not the fixed routing map;
    // `initialAssignmentProfile` returns undefined for them. A `ladder` resolves here to its
    // first stage; its later stages are carried separately in `providerLadders` and consumed by
    // the promotion seam (`resolvePromotionRuntime`) when a target-less `{at:N}` matches.
    const initialProfile = initialAssignmentProfile(assignment);
    if (initialProfile === undefined) {
      continue;
    }
    result[key] = resolveProfileEntry(initialProfile, flatProfiles);
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function buildProviderRouting(
  section: RuntimeProviderSection,
  flatProfiles: Map<string, FlatProfile>,
): ProviderRoutingConfig | undefined {
  const tags = mapTargetEntries(section.targets?.tags, flatProfiles);
  const steps = mapTargetEntries(section.targets?.steps, flatProfiles);
  if (tags === undefined && steps === undefined) {
    return undefined;
  }
  return {
    ...(tags !== undefined ? { tags } : {}),
    ...(steps !== undefined ? { steps } : {}),
  };
}

function buildInternalAgents(
  map: Record<string, RuntimeProviderAssignment> | undefined,
  flatProfiles: Map<string, FlatProfile>,
): InternalAgentEnvironment | undefined {
  if (map === undefined) {
    return undefined;
  }
  const seats: Record<string, keyof InternalAgentEnvironment> = {
    selector: 'selector',
    assistant: 'assistant',
    'intake-normalizer': 'intakeNormalizer',
    'findings-manager': 'findingsManager',
    'terminal-adjudicator': 'terminalAdjudicator',
    'loop-judge': 'loopJudge',
    'escalation-reviewer': 'escalationReviewer',
  };
  const result: InternalAgentEnvironment = {};
  for (const [key, assignment] of Object.entries(map)) {
    const seat = seats[key];
    if (seat === undefined) {
      throw new Error(
        `runtime.yaml \`provider.targets.internal_agents\` supports only ${Object.keys(seats)
          .map((name) => `\`${name}\``)
          .join(', ')}, got "${key}"`,
      );
    }
    if (assignment.pool !== undefined) {
      throw new Error(
        `runtime.yaml \`provider.targets.internal_agents.${key}\` cannot use a \`pool\`; internal agents require a fixed \`profile\``,
      );
    }
    // A `ladder` honors its first stage like every other target (issue #1208); only `pool` is
    // rejected for internal agents.
    const initialProfile = initialAssignmentProfile(assignment);
    if (initialProfile === undefined) {
      continue;
    }
    // internal agents は `escalate` を消費しない（格上げは FC のレビュー枠だけの
    // 概念）。解決結果に残すと使われないデータになるので落とす。
    const resolved = resolveProfileEntry(initialProfile, flatProfiles);
    result[seat] = {
      ...(resolved.provider !== undefined ? { provider: resolved.provider } : {}),
      ...(resolved.model !== undefined ? { model: resolved.model } : {}),
      ...(resolved.providerOptions !== undefined ? { providerOptions: resolved.providerOptions } : {}),
    };
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

const AUTO_ROUTING_STRATEGIES: readonly AutoRoutingStrategy[] = ['cost', 'balanced', 'performance'];
const ROUTING_TIERS: readonly RoutingTier[] = ['low', 'medium', 'high'];

/**
 * Map a runtime.yaml `provider.auto_routing` section (which references profiles) into the
 * resolved `AutoRoutingConfig` the routing selector consumes. Built only when `auto_routing`
 * is present; the pool assignments on `defaults`/`targets` decide which pool each step uses.
 */
function buildAutoRoutingConfig(
  section: RuntimeProviderSection,
  flatProfiles: Map<string, FlatProfile>,
): AutoRoutingConfig | undefined {
  const autoRouting = section.auto_routing;
  if (autoRouting === undefined) {
    return undefined;
  }
  const defaultPool = section.defaults?.pool;
  if (defaultPool === undefined) {
    throw new Error(
      'runtime.yaml `provider.defaults` must specify a `pool` when `provider.auto_routing` is configured',
    );
  }
  if (autoRouting.router_profile === undefined) {
    throw new Error('runtime.yaml `provider.auto_routing` requires a `router_profile`');
  }
  const router = resolveProfileEntry(autoRouting.router_profile, flatProfiles);
  const strategy = resolveStrategy(autoRouting.strategy);

  const candidates = new Map<string, AutoRoutingCandidate>();
  const candidatePools: AutoRoutingConfig['candidatePools'] = {};
  for (const [poolName, pool] of Object.entries(autoRouting.pools ?? {})) {
    const candidateNames: string[] = [];
    for (const candidate of pool.candidates) {
      const tier = requireRoutingTier(candidate.tier, poolName, candidate.profile);
      registerCandidate(candidates, candidate.profile, tier, flatProfiles);
      candidateNames.push(candidate.profile);
    }
    const fallback = pool.fallback_profile;
    if (fallback === undefined) {
      throw new Error(`runtime.yaml \`provider.auto_routing.pools.${poolName}\` requires a \`fallback_profile\``);
    }
    if (!candidateNames.includes(fallback)) {
      throw new Error(
        `runtime.yaml \`provider.auto_routing.pools.${poolName}.fallback_profile\` "${fallback}" must be one of the pool candidates`,
      );
    }
    candidatePools[poolName] = { candidates: candidateNames, fallback };
  }

  if (!Object.hasOwn(candidatePools, defaultPool)) {
    throw new Error(
      `runtime.yaml \`provider.defaults.pool\` "${defaultPool}" is not defined in \`provider.auto_routing.pools\``,
    );
  }
  const poolRules = collectPoolRules(section, candidatePools);

  return {
    strategy,
    router: { provider: router.provider as ProviderType, model: router.model as string },
    candidates: [...candidates.values()],
    defaultPool,
    candidatePools,
    ...(poolRules !== undefined ? { poolRules } : {}),
  };
}

function registerCandidate(
  candidates: Map<string, AutoRoutingCandidate>,
  profileName: string,
  tier: RoutingTier,
  flatProfiles: Map<string, FlatProfile>,
): void {
  const existing = candidates.get(profileName);
  if (existing !== undefined) {
    if (existing.routingTier !== tier) {
      throw new Error(
        `runtime.yaml auto_routing profile "${profileName}" is used with conflicting tiers "${existing.routingTier}" and "${tier}"`,
      );
    }
    return;
  }
  const entry = resolveProfileEntry(profileName, flatProfiles);
  candidates.set(profileName, {
    name: profileName,
    provider: entry.provider as ProviderType,
    model: entry.model as string,
    routingTier: tier,
    ...(entry.providerOptions !== undefined ? { providerOptions: entry.providerOptions } : {}),
  });
}

/** Collect `pool` assignments on targets into the `AutoRoutingConfig.poolRules` map. */
function collectPoolRules(
  section: RuntimeProviderSection,
  candidatePools: AutoRoutingConfig['candidatePools'],
): NonNullable<AutoRoutingConfig['poolRules']> | undefined {
  const personas = collectPoolMapping(section.targets?.personas, candidatePools, 'personas');
  const tags = collectPoolMapping(section.targets?.tags, candidatePools, 'tags');
  const steps = collectPoolMapping(section.targets?.steps, candidatePools, 'steps');
  if (personas === undefined && tags === undefined && steps === undefined) {
    return undefined;
  }
  return {
    ...(personas !== undefined ? { personas } : {}),
    ...(tags !== undefined ? { tags } : {}),
    ...(steps !== undefined ? { steps } : {}),
  };
}

function collectPoolMapping(
  map: Record<string, RuntimeProviderAssignment> | undefined,
  candidatePools: AutoRoutingConfig['candidatePools'],
  mapName: string,
): Record<string, string> | undefined {
  if (map === undefined) {
    return undefined;
  }
  const result: Record<string, string> = {};
  for (const [key, assignment] of Object.entries(map)) {
    if (assignment.pool === undefined) {
      continue;
    }
    if (!Object.hasOwn(candidatePools, assignment.pool)) {
      throw new Error(
        `runtime.yaml \`provider.targets.${mapName}.${key}.pool\` "${assignment.pool}" is not defined in \`provider.auto_routing.pools\``,
      );
    }
    result[key] = assignment.pool;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function resolveStrategy(raw: string | undefined): AutoRoutingStrategy {
  if (raw === undefined) {
    return 'balanced';
  }
  if ((AUTO_ROUTING_STRATEGIES as readonly string[]).includes(raw)) {
    return raw as AutoRoutingStrategy;
  }
  throw new Error(
    `runtime.yaml \`provider.auto_routing.strategy\` "${raw}" must be one of: ${AUTO_ROUTING_STRATEGIES.join(', ')}`,
  );
}

function requireRoutingTier(
  tier: string | undefined,
  poolName: string,
  profileName: string,
): RoutingTier {
  if (tier === undefined) {
    throw new Error(
      `runtime.yaml \`provider.auto_routing.pools.${poolName}\` candidate "${profileName}" requires a \`tier\``,
    );
  }
  if (!(ROUTING_TIERS as readonly string[]).includes(tier)) {
    throw new Error(
      `runtime.yaml \`provider.auto_routing.pools.${poolName}\` candidate "${profileName}" tier "${tier}" must be one of: ${ROUTING_TIERS.join(', ')}`,
    );
  }
  return tier as RoutingTier;
}

/**
 * Resolve a profile reference into provider/model/options. Presence of provider/model on
 * referenced profiles was asserted by `validateRuntimeProviderSection`; a flat profile
 * `options` bag is nested under the profile's provider and normalized into `StepProviderOptions`.
 */
function resolveProfileEntry(
  profileName: string,
  flatProfiles: Map<string, FlatProfile>,
): ProviderRoutingEntry {
  const profile = flatProfiles.get(profileName);
  if (profile?.provider === undefined || profile.model === undefined) {
    throw new Error(
      `runtime.yaml \`provider.profiles."${profileName}"\` is not defined or is missing \`provider\`/\`model\``,
    );
  }
  const options = resolveProfileProviderOptions(profile);
  const escalation = resolveProfileEscalation(profile, flatProfiles);
  return {
    provider: profile.provider as ProviderType,
    model: profile.model,
    ...(options !== undefined ? { providerOptions: options } : {}),
    ...(escalation !== undefined ? { escalation } : {}),
  };
}

/**
 * Resolve one `escalate` hop into a concrete provider/model. Deeper hops are declared and
 * validated but never consumed: escalation is "this worker's last move", not a ladder.
 */
function resolveProfileEscalation(
  profile: FlatProfile,
  flatProfiles: Map<string, FlatProfile>,
): ProviderEscalationTarget | undefined {
  if (profile.escalate === undefined) {
    return undefined;
  }
  const target = flatProfiles.get(profile.escalate);
  if (target?.provider === undefined || target.model === undefined) {
    throw new Error(
      `runtime.yaml \`provider.profiles."${profile.escalate}"\` referenced by \`escalate\` is not defined or is missing \`provider\`/\`model\``,
    );
  }
  const options = resolveProfileProviderOptions(target);
  return {
    profile: profile.escalate,
    provider: target.provider as ProviderType,
    model: target.model,
    ...(options !== undefined ? { providerOptions: options } : {}),
  };
}

/** Raw provider-options key each provider type expects when normalizing a flat options bag. */
const PROVIDER_OPTIONS_RAW_KEY: Partial<Record<ProviderType, string>> = {
  codex: 'codex',
  opencode: 'opencode',
  claude: 'claude',
  'claude-sdk': 'claude',
  'claude-terminal': 'claude_terminal',
  copilot: 'copilot',
  kiro: 'kiro',
};

function resolveProfileProviderOptions(
  profile: FlatProfile | undefined,
): StepProviderOptions | undefined {
  if (profile?.options === undefined || profile.provider === undefined) {
    return undefined;
  }
  const rawKey = PROVIDER_OPTIONS_RAW_KEY[profile.provider as ProviderType];
  if (rawKey === undefined) {
    throw new Error(
      `runtime.yaml profile \`options\` are not supported for provider "${profile.provider}"`,
    );
  }
  return normalizeProviderOptions({ [rawKey]: profile.options });
}
