import { isDeepStrictEqual } from 'node:util';

type PreviewCountConfig = Record<string, unknown>;
type AliasedConfig = Record<string, unknown>;
type RawQualityGateOverride = { quality_gates?: string[] };
type RawPieceOverrides = {
  quality_gates?: string[];
  quality_gates_edit_only?: boolean;
  movements?: Record<string, RawQualityGateOverride>;
  steps?: Record<string, RawQualityGateOverride>;
  personas?: Record<string, RawQualityGateOverride>;
};

type PermissionOverrideAliases = {
  movement_permission_overrides?: Record<string, unknown>;
  step_permission_overrides?: Record<string, unknown>;
};

export type RawProviderPermissionProfile = {
  default_permission_mode: unknown;
  movement_permission_overrides?: Record<string, unknown>;
  step_permission_overrides?: Record<string, unknown>;
};

function normalizeRawPieceOverrides(
  value: unknown,
): RawPieceOverrides | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }

  const raw = value as RawPieceOverrides;
  const normalized: RawPieceOverrides = {};
  if (raw.quality_gates !== undefined) {
    normalized.quality_gates = raw.quality_gates;
  }
  if (raw.quality_gates_edit_only !== undefined) {
    normalized.quality_gates_edit_only = raw.quality_gates_edit_only;
  }

  const stepOverrides = raw.steps ?? raw.movements;
  if (stepOverrides !== undefined) {
    normalized.steps = stepOverrides;
  }
  if (raw.personas !== undefined) {
    normalized.personas = raw.personas;
  }

  return normalized;
}

function resolveAliasedPieceOverrides(
  source: string,
  raw: AliasedConfig,
  preferredKey: string,
  legacyKey: string,
): RawPieceOverrides | undefined {
  const preferredValue = raw[preferredKey];
  const legacyValue = raw[legacyKey];
  const normalizedPreferredValue = normalizeRawPieceOverrides(preferredValue);
  const normalizedLegacyValue = normalizeRawPieceOverrides(legacyValue);

  if (
    preferredValue !== undefined
    && legacyValue !== undefined
    && !isDeepStrictEqual(normalizedPreferredValue, normalizedLegacyValue)
  ) {
    throw new Error(`Configuration conflict: '${preferredKey}' and '${legacyKey}' must match when both are set in ${source}.`);
  }

  return normalizedPreferredValue ?? normalizedLegacyValue;
}

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

export function resolveAliasedConfigKey<T>(
  source: string,
  raw: AliasedConfig,
  preferredKey: string,
  legacyKey: string,
): T | undefined {
  if (preferredKey === 'workflow_overrides' && legacyKey === 'piece_overrides') {
    return resolveAliasedPieceOverrides(source, raw, preferredKey, legacyKey) as T | undefined;
  }

  const preferredValue = raw[preferredKey];
  const legacyValue = raw[legacyKey];
  if (
    preferredValue !== undefined
    && legacyValue !== undefined
    && !isDeepStrictEqual(preferredValue, legacyValue)
  ) {
    throw new Error(`Configuration conflict: '${preferredKey}' and '${legacyKey}' must match when both are set in ${source}.`);
  }
  return (preferredValue ?? legacyValue) as T | undefined;
}

export function resolveAliasedNotificationSoundEvents(
  source: string,
  raw: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!raw) {
    return undefined;
  }

  const workflowComplete = resolveAliasedConfigKey<boolean>(
    `${source} notification_sound_events`,
    raw,
    'workflow_complete',
    'piece_complete',
  );
  const workflowAbort = resolveAliasedConfigKey<boolean>(
    `${source} notification_sound_events`,
    raw,
    'workflow_abort',
    'piece_abort',
  );

  return {
    ...raw,
    ...(workflowComplete !== undefined ? { piece_complete: workflowComplete } : {}),
    ...(workflowAbort !== undefined ? { piece_abort: workflowAbort } : {}),
  };
}
