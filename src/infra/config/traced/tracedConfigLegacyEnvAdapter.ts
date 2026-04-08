import type { LegacyEnvSpec } from '../env/config-env-overrides.js';

export function applyLegacyEnvSpecs(
  legacyEnvSpecs: readonly LegacyEnvSpec[],
): void {
  for (const spec of legacyEnvSpecs) {
    if (process.env[spec.env] === undefined) {
      continue;
    }

    throw new Error(
      spec.canonicalPath
        ? `Configuration error: "${spec.path}" has been removed. Use "${spec.canonicalPath}" instead.`
        : `Configuration error: "${spec.path}" has been removed.`,
    );
  }
}
