/**
 * Zod schema for the runtime.yaml provider configuration (issue #1136).
 *
 * Shapes are the literal ones from order.md:41-103 / 206-217 / 221-223. The schema is
 * intentionally strict: it rejects any indirection key (e.g. `runtime_file`) and any
 * `provider.targets` map other than the documented ones. Cross-reference checks
 * (extends chains, profile/pool references) are enforced later at compile time by
 * `validateRuntimeProviderSection`, not here.
 */

import { z } from 'zod';
import { PROVIDER_TYPES } from '../../../shared/types/provider.js';
import { PermissionModeSchema } from '../../../core/models/schema-base.js';
import { COMPANION_REVIEW_MODE_VALUES } from '../../../core/models/companion-types.js';
import { RUNTIME_PROVIDER_VERSION } from './constants.js';
import { McpSectionSchema } from './mcp-schema.js';
import { DEFAULT_COMPANION_ENABLED } from '../../../shared/constants.js';

const ProviderNameSchema = z.enum(PROVIDER_TYPES);

/** Flat provider-specific options bag (e.g. `{ reasoning_effort: 'high' }`). */
const ProfileOptionsSchema = z.record(z.string(), z.unknown());

/** A named provider/model/options definition. `extends` inherits from another profile. */
const ProfileSchema = z
  .object({
    provider: ProviderNameSchema.optional(),
    model: z.string().min(1).optional(),
    options: ProfileOptionsSchema.optional(),
    capabilities: z.union([
      z.string().min(1),
      z.array(z.string().min(1)).min(1),
    ]).optional(),
    permission_mode: PermissionModeSchema.optional(),
    extends: z.string().min(1).optional(),
  })
  .strict();

/**
 * Target entries pick exactly one assignment form: a fixed `profile`, an auto-routing `pool`,
 * or (issue #1208) an ordered `ladder` of profiles. The ladder's first profile is the initial
 * assignment; a step `promotion` request advances to the next stage.
 */
const AssignmentSchema = z
  .object({
    profile: z.string().min(1).optional(),
    pool: z.string().min(1).optional(),
    ladder: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const present = [value.profile, value.pool, value.ladder].filter((form) => form !== undefined);
    if (present.length !== 1) {
      ctx.addIssue({
        code: 'custom',
        message: 'assignment must specify exactly one of `profile`, `pool`, or `ladder`',
      });
    }
  });

const DefaultAssignmentSchema = z
  .object({
    profile: z.string().min(1).optional(),
    ladder: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const present = [value.profile, value.ladder].filter((form) => form !== undefined);
    if (present.length !== 1) {
      ctx.addIssue({
        code: 'custom',
        message: 'provider.defaults must specify exactly one of `profile` or `ladder`',
      });
    }
  });

const CompanionAssignmentSchema = z
  .object({
    profile: z.string().min(1),
  })
  .strict();

const RuntimeCompanionPolicySchema = z
  .object({
    enabled: z.boolean().optional(),
    review_mode: z.enum(COMPANION_REVIEW_MODE_VALUES).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.enabled === undefined && value.review_mode === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'companion policy must specify at least one of `enabled` or `review_mode`',
      });
    }
  });

const RuntimeLoopAnalysisSchema = z
  .object({
    enabled: z.boolean(),
    output: z.enum(['file', 'pr-comment']).default('file'),
  })
  .strict();

/** An auto-routing pool candidate references a profile; it must not inline provider/model. */
const CandidateSchema = z
  .object({
    profile: z.string().min(1),
    tier: z.enum(['low', 'medium', 'high']).optional(),
  })
  .strict();

const PoolSchema = z
  .object({
    candidates: z.array(CandidateSchema).min(1),
    fallback_profile: z.string().min(1).optional(),
  })
  .strict();

const AutoRoutingSchema = z
  .object({
    strategy: z.enum(['cost', 'balanced', 'performance']).optional(),
    router_profile: z.string().min(1).optional(),
    pools: z.record(z.string(), PoolSchema).optional(),
  })
  .strict();

/** Only the documented target maps are allowed. */
const TargetsSchema = z
  .object({
    personas: z.record(z.string(), AssignmentSchema).optional(),
    tags: z.record(z.string(), AssignmentSchema).optional(),
    steps: z.record(z.string(), AssignmentSchema).optional(),
    internal_agents: z.record(z.string(), AssignmentSchema).optional(),
    companions: z.record(z.string(), CompanionAssignmentSchema).optional(),
  })
  .strict();

const ProviderAssignmentSetSchema = z
  .object({
    defaults: DefaultAssignmentSchema.optional(),
    targets: TargetsSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.defaults === undefined && value.targets === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'provider assignment must specify `defaults` or `targets`',
      });
    }
  });

const ProviderSectionSchema = z
  .object({
    defaults: DefaultAssignmentSchema.optional(),
    profiles: z.record(z.string(), ProfileSchema).optional(),
    targets: TargetsSchema.optional(),
    assignments: z.record(z.string(), ProviderAssignmentSetSchema).optional(),
    directories: z.record(z.string(), z.string().min(1)).optional(),
    auto_routing: AutoRoutingSchema.optional(),
  })
  .strict();

type RuntimeProviderSectionShape = z.infer<typeof ProviderSectionSchema>;
type RuntimeProviderTargets = z.infer<typeof TargetsSchema>;
type RuntimeProviderAssignmentSetShape = z.infer<typeof ProviderAssignmentSetSchema>;

function addAssignmentProfiles(
  profiles: Set<string>,
  assignment: { profile?: string; ladder?: string[] },
): void {
  if (assignment.profile !== undefined) {
    profiles.add(assignment.profile);
  }
  for (const profile of assignment.ladder ?? []) {
    profiles.add(profile);
  }
}

function collectProfileClosure(
  profiles: Record<string, z.infer<typeof ProfileSchema>>,
  roots: ReadonlySet<string>,
): Set<string> {
  const closure = new Set<string>();
  const visit = (name: string): void => {
    if (closure.has(name)) {
      return;
    }
    closure.add(name);
    const profile = profiles[name];
    if (profile?.extends !== undefined) {
      visit(profile.extends);
    }
  };
  roots.forEach(visit);
  return closure;
}

function withoutCompanionTargets(
  targets: RuntimeProviderTargets | undefined,
): RuntimeProviderTargets | undefined {
  if (targets === undefined || targets.companions === undefined) {
    return targets;
  }
  const remaining = { ...targets };
  delete remaining.companions;
  return remaining;
}

function hasTargetContent(targets: RuntimeProviderTargets | undefined): boolean {
  return Object.values(targets ?? {}).some(
    (targetMap) => targetMap !== undefined && Object.keys(targetMap).length > 0,
  );
}

function getEffectiveProviderSection(
  section: RuntimeProviderSectionShape | undefined,
  companionEnabled: boolean,
): RuntimeProviderSectionShape | undefined {
  const hasCompanionTargets = section?.targets?.companions !== undefined
    || Object.values(section?.assignments ?? {}).some(
      (assignment) => assignment.targets?.companions !== undefined,
    );
  if (section === undefined || companionEnabled || !hasCompanionTargets) {
    return section;
  }

  const profiles = section.profiles ?? {};
  const companionRoots = new Set<string>();
  for (const target of Object.values(section.targets?.companions ?? {})) {
    companionRoots.add(target.profile);
  }
  const nonCompanionRoots = new Set<string>();
  if (section.defaults !== undefined) {
    addAssignmentProfiles(nonCompanionRoots, section.defaults);
  }
  for (const targetMap of [
    section.targets?.personas,
    section.targets?.tags,
    section.targets?.steps,
    section.targets?.internal_agents,
  ]) {
    Object.values(targetMap ?? {}).forEach((assignment) => {
      addAssignmentProfiles(nonCompanionRoots, assignment);
    });
  }
  for (const assignment of Object.values(section.assignments ?? {})) {
    if (assignment.defaults !== undefined) {
      addAssignmentProfiles(nonCompanionRoots, assignment.defaults);
    }
    for (const targetMap of [
      assignment.targets?.personas,
      assignment.targets?.tags,
      assignment.targets?.steps,
      assignment.targets?.internal_agents,
    ]) {
      Object.values(targetMap ?? {}).forEach((target) => {
        addAssignmentProfiles(nonCompanionRoots, target);
      });
    }
    for (const target of Object.values(assignment.targets?.companions ?? {})) {
      companionRoots.add(target.profile);
    }
  }
  if (section.auto_routing?.router_profile !== undefined) {
    nonCompanionRoots.add(section.auto_routing.router_profile);
  }
  for (const pool of Object.values(section.auto_routing?.pools ?? {})) {
    pool.candidates.forEach((candidate) => nonCompanionRoots.add(candidate.profile));
    if (pool.fallback_profile !== undefined) {
      nonCompanionRoots.add(pool.fallback_profile);
    }
  }

  const companionClosure = collectProfileClosure(profiles, companionRoots);
  const nonCompanionClosure = collectProfileClosure(profiles, nonCompanionRoots);
  const effectiveProfiles = Object.fromEntries(
    Object.entries(profiles).filter(([name]) => (
      !companionClosure.has(name) || nonCompanionClosure.has(name)
    )),
  );
  const targets = withoutCompanionTargets(section.targets);
  const effectiveSection: RuntimeProviderSectionShape = {
    ...section,
    profiles: effectiveProfiles,
    targets,
  };
  if (section.assignments !== undefined) {
    const assignments: Record<string, RuntimeProviderAssignmentSetShape> = {};
    for (const [name, assignment] of Object.entries(section.assignments)) {
      const remainingTargets = withoutCompanionTargets(assignment.targets);
      const hasRemainingTargets = hasTargetContent(remainingTargets);
      if (assignment.defaults === undefined && !hasRemainingTargets) {
        continue;
      }
      assignments[name] = {
        ...(assignment.defaults === undefined ? {} : { defaults: assignment.defaults }),
        ...(hasRemainingTargets ? { targets: remainingTargets } : {}),
      };
    }
    if (Object.keys(assignments).length > 0) {
      effectiveSection.assignments = assignments;
    } else {
      delete effectiveSection.assignments;
    }
  }
  return effectiveSection;
}

/** Determine whether a provider section has active runtime configuration. */
export function hasActiveProviderContent(
  section: RuntimeProviderSectionShape | undefined,
  companionEnabled = DEFAULT_COMPANION_ENABLED,
): boolean {
  const effectiveSection = getEffectiveProviderSection(section, companionEnabled);
  if (effectiveSection === undefined) {
    return false;
  }
  const hasTargets = hasTargetContent(effectiveSection.targets);
  const hasAssignments = Object.values(effectiveSection.assignments ?? {}).some((assignment) => (
    (assignment.defaults !== undefined && Object.keys(assignment.defaults).length > 0)
    || hasTargetContent(assignment.targets)
  ));
  const hasDefaults = effectiveSection.defaults !== undefined
    && Object.keys(effectiveSection.defaults).length > 0;
  return hasDefaults
    || (effectiveSection.profiles !== undefined && Object.keys(effectiveSection.profiles).length > 0)
    || hasTargets
    || hasAssignments
    || (effectiveSection.auto_routing !== undefined
      && Object.keys(effectiveSection.auto_routing).length > 0);
}

export const RuntimeProviderFileSchema = z
  .object({
    version: z.literal(RUNTIME_PROVIDER_VERSION),
    companion: RuntimeCompanionPolicySchema.optional(),
    loop_analysis: RuntimeLoopAnalysisSchema.optional(),
    provider: ProviderSectionSchema.optional(),
    mcp: McpSectionSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const companionEnabled = value.companion?.enabled ?? DEFAULT_COMPANION_ENABLED;
    if (hasActiveProviderContent(value.provider, companionEnabled) && value.provider?.defaults === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['provider', 'defaults'],
        message: 'active provider section must specify `provider.defaults`',
      });
    }
  });

export type RuntimeProviderFile = z.infer<typeof RuntimeProviderFileSchema>;
export type RuntimeProviderSection = z.infer<typeof ProviderSectionSchema>;
export type RuntimeProviderProfile = z.infer<typeof ProfileSchema>;
export type RuntimeProviderAssignment = z.infer<typeof AssignmentSchema>;
export type RuntimeProviderAssignmentSet = z.infer<typeof ProviderAssignmentSetSchema>;
export type RuntimeCompanionProviderAssignment = z.infer<typeof CompanionAssignmentSchema>;
export type RuntimeProviderAutoRouting = z.infer<typeof AutoRoutingSchema>;
export type { McpSection } from './mcp-schema.js';

/** Remove disabled companion-only targets before mode detection and provider compilation. */
export function getEffectiveRuntimeProviderFile(
  file: RuntimeProviderFile | undefined,
): RuntimeProviderFile | undefined {
  if (file === undefined) {
    return file;
  }
  const provider = getEffectiveProviderSection(
    file.provider,
    file.companion?.enabled ?? DEFAULT_COMPANION_ENABLED,
  );
  return {
    ...file,
    ...(provider === undefined ? {} : { provider }),
  };
}
