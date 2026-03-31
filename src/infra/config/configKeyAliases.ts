import { isDeepStrictEqual } from 'node:util';

type PreviewCountConfig = Record<string, unknown>;

type PermissionOverrideAliases = {
  movement_permission_overrides?: Record<string, unknown>;
  step_permission_overrides?: Record<string, unknown>;
};

export type RawProviderPermissionProfile = {
  default_permission_mode: unknown;
  movement_permission_overrides?: Record<string, unknown>;
  step_permission_overrides?: Record<string, unknown>;
};

export function resolveAliasedPreviewCount(parsed: PreviewCountConfig, source: string): number | undefined {
  const movementValue = parsed.interactive_preview_movements;
  const stepValue = parsed.interactive_preview_steps;
  if (
    typeof movementValue === 'number'
    && typeof stepValue === 'number'
    && movementValue !== stepValue
  ) {
    throw new Error(`Configuration error: ${source} interactive_preview_steps must match interactive_preview_movements when both are set.`);
  }
  return typeof stepValue === 'number'
    ? stepValue
    : (typeof movementValue === 'number' ? movementValue : undefined);
}

export function resolvePermissionOverrideAliases(
  source: string,
  raw: PermissionOverrideAliases,
): Record<string, unknown> | undefined {
  const movementOverrides = raw.movement_permission_overrides;
  const stepOverrides = raw.step_permission_overrides;
  if (
    movementOverrides !== undefined
    && stepOverrides !== undefined
    && !isDeepStrictEqual(movementOverrides, stepOverrides)
  ) {
    throw new Error(`Configuration error: ${source} step_permission_overrides must match movement_permission_overrides when both are set.`);
  }
  return stepOverrides ?? movementOverrides;
}
