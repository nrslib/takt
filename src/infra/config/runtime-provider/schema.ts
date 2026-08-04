/**
 * Zod schema for the runtime.yaml provider configuration (issue #1136).
 *
 * Shapes are the literal ones from order.md:41-103 / 206-217 / 221-223. The schema is
 * intentionally strict: it rejects any indirection key (e.g. `runtime_file`) and any
 * `provider.targets` map other than the four documented ones. Cross-reference checks
 * (extends chains, profile/pool references) are enforced later at compile time by
 * `validateRuntimeProviderSection`, not here.
 */

import { z } from 'zod';
import { PROVIDER_TYPES } from '../../../shared/types/provider.js';
import { RUNTIME_PROVIDER_VERSION } from './constants.js';

const ProviderNameSchema = z.enum(PROVIDER_TYPES);

/** Flat provider-specific options bag (e.g. `{ reasoning_effort: 'high' }`). */
const ProfileOptionsSchema = z.record(z.string(), z.unknown());

/** A named provider/model/options definition. `extends` inherits from another profile. */
const ProfileSchema = z
  .object({
    provider: ProviderNameSchema.optional(),
    model: z.string().min(1).optional(),
    options: ProfileOptionsSchema.optional(),
    extends: z.string().min(1).optional(),
  })
  .strict();

/** `defaults` and every target entry pick exactly one of a fixed profile or an auto-routing pool. */
const AssignmentSchema = z
  .object({
    profile: z.string().min(1).optional(),
    pool: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasProfile = value.profile !== undefined;
    const hasPool = value.pool !== undefined;
    if (hasProfile === hasPool) {
      ctx.addIssue({
        code: 'custom',
        message: 'assignment must specify exactly one of `profile` or `pool`',
      });
    }
  });

/** An auto-routing pool candidate references a profile; it must not inline provider/model. */
const CandidateSchema = z
  .object({
    profile: z.string().min(1),
    tier: z.string().min(1).optional(),
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
    strategy: z.string().min(1).optional(),
    router_profile: z.string().min(1).optional(),
    pools: z.record(z.string(), PoolSchema).optional(),
  })
  .strict();

/** Only the four documented target maps are allowed. */
const TargetsSchema = z
  .object({
    personas: z.record(z.string(), AssignmentSchema).optional(),
    tags: z.record(z.string(), AssignmentSchema).optional(),
    steps: z.record(z.string(), AssignmentSchema).optional(),
    internal_agents: z.record(z.string(), AssignmentSchema).optional(),
  })
  .strict();

const ProviderSectionSchema = z
  .object({
    defaults: AssignmentSchema.optional(),
    profiles: z.record(z.string(), ProfileSchema).optional(),
    targets: TargetsSchema.optional(),
    auto_routing: AutoRoutingSchema.optional(),
  })
  .strict();

export const RuntimeProviderFileSchema = z
  .object({
    version: z.literal(RUNTIME_PROVIDER_VERSION),
    provider: ProviderSectionSchema.optional(),
  })
  .strict();

export type RuntimeProviderFile = z.infer<typeof RuntimeProviderFileSchema>;
export type RuntimeProviderSection = z.infer<typeof ProviderSectionSchema>;
export type RuntimeProviderProfile = z.infer<typeof ProfileSchema>;
export type RuntimeProviderAssignment = z.infer<typeof AssignmentSchema>;
export type RuntimeProviderAutoRouting = z.infer<typeof AutoRoutingSchema>;
