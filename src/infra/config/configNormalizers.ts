/**
 * Shared normalizer/denormalizer functions for config snake_case <-> camelCase conversion.
 *
 * Used by both globalConfig.ts and projectConfig.ts.
 */

import type { PieceRuntimeConfig } from '../../core/models/piece-types.js';
import type { ProviderPermissionProfiles } from '../../core/models/provider-profiles.js';
import type { PieceOverrides } from '../../core/models/persisted-global-config.js';

/**
 * Normalize runtime config: deduplicate prepare entries, return undefined if empty.
 * Used by both load (raw → domain) and save (domain → raw) since the field name is identical.
 */
export function normalizeRuntime(
  runtime: { prepare?: string[] } | undefined,
): PieceRuntimeConfig | undefined {
  if (!runtime?.prepare || runtime.prepare.length === 0) {
    return undefined;
  }
  return { prepare: [...new Set(runtime.prepare)] };
}

export function normalizeProviderProfiles(
  raw: Record<string, { default_permission_mode: unknown; movement_permission_overrides?: Record<string, unknown> }> | undefined,
): ProviderPermissionProfiles | undefined {
  if (!raw) return undefined;

  const entries = Object.entries(raw).map(([provider, profile]) => [provider, {
    defaultPermissionMode: profile.default_permission_mode,
    movementPermissionOverrides: profile.movement_permission_overrides,
  }]);

  return Object.fromEntries(entries) as ProviderPermissionProfiles;
}

export function denormalizeProviderProfiles(
  profiles: ProviderPermissionProfiles | undefined,
): Record<string, { default_permission_mode: string; movement_permission_overrides?: Record<string, string> }> | undefined {
  if (!profiles) return undefined;
  const entries = Object.entries(profiles);
  if (entries.length === 0) return undefined;

  return Object.fromEntries(entries.map(([provider, profile]) => [provider, {
    default_permission_mode: profile.defaultPermissionMode,
    ...(profile.movementPermissionOverrides
      ? { movement_permission_overrides: profile.movementPermissionOverrides }
      : {}),
  }])) as Record<string, { default_permission_mode: string; movement_permission_overrides?: Record<string, string> }>;
}

export function normalizePieceOverrides(
  raw: { quality_gates?: string[]; quality_gates_edit_only?: boolean; movements?: Record<string, { quality_gates?: string[] }> } | undefined,
): PieceOverrides | undefined {
  if (!raw) return undefined;
  return {
    qualityGates: raw.quality_gates,
    qualityGatesEditOnly: raw.quality_gates_edit_only,
    movements: raw.movements
      ? Object.fromEntries(
          Object.entries(raw.movements).map(([name, override]) => [
            name,
            { qualityGates: override.quality_gates },
          ])
        )
      : undefined,
  };
}

export function denormalizePieceOverrides(
  overrides: PieceOverrides | undefined,
): { quality_gates?: string[]; quality_gates_edit_only?: boolean; movements?: Record<string, { quality_gates?: string[] }> } | undefined {
  if (!overrides) return undefined;
  const result: { quality_gates?: string[]; quality_gates_edit_only?: boolean; movements?: Record<string, { quality_gates?: string[] }> } = {};
  if (overrides.qualityGates !== undefined) {
    result.quality_gates = overrides.qualityGates;
  }
  if (overrides.qualityGatesEditOnly !== undefined) {
    result.quality_gates_edit_only = overrides.qualityGatesEditOnly;
  }
  if (overrides.movements) {
    result.movements = Object.fromEntries(
      Object.entries(overrides.movements).map(([name, override]) => {
        const movementOverride: { quality_gates?: string[] } = {};
        if (override.qualityGates !== undefined) {
          movementOverride.quality_gates = override.qualityGates;
        }
        return [name, movementOverride];
      })
    );
  }
  return Object.keys(result).length > 0 ? result : undefined;
}
