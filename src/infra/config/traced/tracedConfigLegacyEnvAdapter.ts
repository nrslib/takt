import type { TracedValue } from 'traced-config';
import type { EnvSpec, LegacyEnvSpec } from '../env/config-env-overrides.js';

function coerceLegacyEnvValue(rawValue: string, type: EnvSpec['type'], envKey: string): unknown {
  if (type === 'string') {
    return rawValue;
  }
  if (type === 'boolean') {
    if (rawValue === 'true' || rawValue === '1') return true;
    if (rawValue === 'false' || rawValue === '0') return false;
    throw new Error(`${envKey} must be one of: true, false, 1, 0`);
  }
  if (type === 'number') {
    const value = Number(rawValue);
    if (!Number.isFinite(value)) {
      throw new Error(`${envKey} must be a number`);
    }
    return value;
  }
  try {
    return JSON.parse(rawValue);
  } catch {
    throw new Error(`${envKey} must be valid JSON`);
  }
}

export function applyLegacyEnvSpecs(
  rawConfig: Record<string, unknown>,
  legacyTraceEntries: Map<string, TracedValue<unknown>>,
  legacyEnvSpecs: readonly LegacyEnvSpec[],
): void {
  for (const spec of legacyEnvSpecs) {
    const rawValue = process.env[spec.env];
    if (rawValue === undefined) {
      continue;
    }

    coerceLegacyEnvValue(rawValue, spec.type, spec.env);
    const canonicalPath = spec.blockedBy[0]
      ?.replace(/^TAKT_/, '')
      .toLowerCase();
    throw new Error(
      canonicalPath
        ? `Configuration error: "${spec.path}" has been removed. Use "${canonicalPath}" instead.`
        : `Configuration error: "${spec.path}" has been removed.`,
    );
  }
}
