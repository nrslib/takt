/**
 * Runtime-v1 provider section validation (issue #1136).
 *
 * `validateRuntimeProviderSection` takes a validated `provider` section, resolves every
 * `extends` chain, and validates all profile/pool references up front — unknown references,
 * cyclic `extends`, and profiles missing provider/model fail fast at compile time (before any
 * agent runs), never via a silent fallback.
 *
 * Runtime-v1 resolution itself (defaults/personas/tags/steps → provider/model, plus the
 * same-priority tag conflict fail-fast) is compiled into the shared engine-options bundle by
 * `environment.ts` and enforced at the single per-step resolution seam
 * (`resolveStepProviderModel`); this module only performs the up-front reference validation.
 */

import type {
  RuntimeProviderSection,
  RuntimeProviderProfile,
  RuntimeProviderAssignment,
} from './schema.js';

export interface FlatProfile {
  provider?: string;
  model?: string;
  options?: Record<string, unknown>;
}

/**
 * Validate every profile/pool reference in the section up front. Throws on unknown
 * references, cyclic `extends`, and referenced profiles missing `provider`/`model`.
 */
export function validateRuntimeProviderSection(section: RuntimeProviderSection): void {
  const flatProfiles = flattenProfiles(section.profiles ?? {});
  const poolNames = new Set(Object.keys(section.auto_routing?.pools ?? {}));
  validateReferences(section, flatProfiles, poolNames);
}

/** Resolve every `extends` chain into flat profiles; throw on cycles and unknown parents. */
export function flattenProfiles(
  profiles: Record<string, RuntimeProviderProfile>,
): Map<string, FlatProfile> {
  const cache = new Map<string, FlatProfile>();
  const resolving = new Set<string>();

  function resolve(name: string): FlatProfile {
    const cached = cache.get(name);
    if (cached) {
      return cached;
    }
    const profile = profiles[name];
    if (!profile) {
      throw new Error(`Unknown profile "${name}" referenced by \`extends\``);
    }
    if (resolving.has(name)) {
      throw new Error(`Cyclic \`extends\` chain detected at profile "${name}"`);
    }
    resolving.add(name);
    const flat: FlatProfile = profile.extends ? { ...resolve(profile.extends) } : {};
    if (profile.provider !== undefined) {
      flat.provider = profile.provider;
    }
    if (profile.model !== undefined) {
      flat.model = profile.model;
    }
    if (profile.options !== undefined) {
      flat.options = profile.options;
    }
    resolving.delete(name);
    cache.set(name, flat);
    return flat;
  }

  for (const name of Object.keys(profiles)) {
    resolve(name);
  }
  return cache;
}

function validateReferences(
  section: RuntimeProviderSection,
  flatProfiles: Map<string, FlatProfile>,
  poolNames: Set<string>,
): void {
  const assertProfile = (name: string, referencedBy: string): void => {
    const profile = flatProfiles.get(name);
    if (!profile) {
      throw new Error(`Unknown profile "${name}" referenced by ${referencedBy}`);
    }
    if (!profile.provider || !profile.model) {
      throw new Error(
        `Profile "${name}" referenced by ${referencedBy} must define both \`provider\` and \`model\``,
      );
    }
  };
  const assertPool = (name: string, referencedBy: string): void => {
    if (!poolNames.has(name)) {
      throw new Error(`Unknown pool "${name}" referenced by ${referencedBy}`);
    }
  };
  const assertAssignment = (assignment: RuntimeProviderAssignment, referencedBy: string): void => {
    if (assignment.profile !== undefined) {
      assertProfile(assignment.profile, referencedBy);
    } else if (assignment.pool !== undefined) {
      assertPool(assignment.pool, referencedBy);
    } else if (assignment.ladder !== undefined) {
      // Every stage of a ladder must resolve to a fully-defined profile up front (CT-LAD-5); an
      // unresolved or incomplete stage fails fast here, never at the moment a promotion advances.
      assignment.ladder.forEach((profileName, stage) => {
        assertProfile(profileName, `${referencedBy} ladder[${stage}]`);
      });
    }
  };

  if (section.defaults) {
    assertAssignment(section.defaults, 'defaults');
  }

  const targets = section.targets;
  if (targets) {
    for (const [mapName, map] of Object.entries(targets)) {
      if (map === undefined) {
        continue;
      }
      for (const [key, assignment] of Object.entries(map)) {
        assertAssignment(assignment, `targets.${mapName}.${key}`);
      }
    }
  }

  const autoRouting = section.auto_routing;
  if (autoRouting) {
    if (autoRouting.router_profile !== undefined) {
      assertProfile(autoRouting.router_profile, 'auto_routing.router_profile');
    }
    for (const [poolName, pool] of Object.entries(autoRouting.pools ?? {})) {
      for (const candidate of pool.candidates) {
        assertProfile(candidate.profile, `auto_routing.pools.${poolName} candidate`);
      }
      if (pool.fallback_profile !== undefined) {
        assertProfile(pool.fallback_profile, `auto_routing.pools.${poolName}.fallback_profile`);
      }
    }
  }
}
