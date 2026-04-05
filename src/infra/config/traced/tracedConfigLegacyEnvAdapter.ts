import type { TracedValue } from 'traced-config';
import { setNestedConfigValue, type EnvSpec, type LegacyEnvSpec } from '../env/config-env-overrides.js';

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

    const blocked = spec.blockedBy.some((envKey) => process.env[envKey] !== undefined);
    if (blocked) {
      continue;
    }

    console.warn(spec.warning);
    const parsed = coerceLegacyEnvValue(rawValue, spec.type, spec.env);
    setNestedConfigValue(rawConfig, spec.path, parsed);
    legacyTraceEntries.set(spec.path, {
      value: parsed,
      source: spec.env,
      origin: 'env',
    });
  }
}
